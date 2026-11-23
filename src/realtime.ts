import WebSocket from "ws";
import { API_PATHS, WS_CAPABILITIES, WS_PROTOCOL } from "./constants.js";
import { WsCloseCode } from "./enums.js";
import type { AuthManager } from "./auth.js";
import type { TransportConfig } from "./http.js";
import type { MessengerFrame } from "./types.js";
import { TypedEmitter } from "./utils/emitter.js";

export interface RealtimeOptions {
  /** Как часто слать `ping`, мс. По умолчанию 10 000. */
  pingIntervalMs: number;
  /** Если от сервера ничего не приходило столько мс — переподключаемся. По умолчанию 30 000. */
  heartbeatTimeoutMs: number;
  /** Таймаут установки соединения, мс. По умолчанию 10 000. */
  connectTimeoutMs: number;
  /** Задержки переподключения: от min до max с экспоненциальным ростом. */
  reconnectMinDelayMs: number;
  reconnectMaxDelayMs: number;
}

export type RealtimeEvents = {
  open: [];
  close: [code: number, reason: string, willReconnect: boolean];
  frame: [frame: MessengerFrame];
  error: [error: Error];
};

/**
 * WebSocket мессенджера: `wss://<host>/api/v1/messenger/ws`, авторизация через подпротокол `bearer.<token>`.
 * Сам держит heartbeat (`ping` → `pong`) и переподключается с backoff.
 */
export class RealtimeGateway extends TypedEmitter<RealtimeEvents> {
  #socket: WebSocket | null = null;
  #manualClose = true;
  #reconnectDelay: number;
  #reconnectTimer: NodeJS.Timeout | null = null;
  #pingTimer: NodeJS.Timeout | null = null;
  #connectTimer: NodeJS.Timeout | null = null;
  #lastHeartbeatAt = 0;
  #lastPingAt = 0;
  #needsAuthRefresh = false;
  #connecting = false;

  constructor(
    private readonly transport: TransportConfig,
    private readonly auth: AuthManager,
    private readonly options: RealtimeOptions,
  ) {
    super();
    this.#reconnectDelay = options.reconnectMinDelayMs;
  }

  get isConnected(): boolean {
    return this.#socket?.readyState === WebSocket.OPEN;
  }

  get url(): string {
    const url = new URL(API_PATHS.messenger + "/ws", this.transport.baseUrl);
    url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
    url.searchParams.set("capabilities", WS_CAPABILITIES);
    return url.toString();
  }

  /** Подключиться (и поддерживать подключение до `disconnect()`). */
  connect(): void {
    this.#manualClose = false;
    void this.#open();
  }

  /** Отключиться без переподключения. */
  disconnect(): void {
    this.#manualClose = true;
    this.#clearTimers();
    const socket = this.#socket;
    this.#socket = null;
    if (socket) {
      socket.removeAllListeners();
      socket.on("error", () => undefined);
      try {
        socket.close(1000, "client disconnect");
      } catch {
        socket.terminate();
      }
      this.emit("close", 1000, "client disconnect", false);
    }
  }

  /** Принудительно переподключиться (например, после смены токена). */
  reconnect(): void {
    if (this.#manualClose) return;
    this.#dropSocket();
    this.#reconnectDelay = this.options.reconnectMinDelayMs;
    void this.#open();
  }

  async #open(): Promise<void> {
    if (this.#manualClose || this.#connecting) return;
    if (this.#socket && (this.#socket.readyState === WebSocket.OPEN || this.#socket.readyState === WebSocket.CONNECTING)) return;
    this.#connecting = true;

    let token: string;
    try {
      if (this.#needsAuthRefresh) {
        this.#needsAuthRefresh = false;
        this.auth.invalidateAccessToken();
      }
      token = await this.auth.getAccessToken();
    } catch (error) {
      this.#connecting = false;
      this.emit("error", error as Error);
      this.#scheduleReconnect();
      return;
    }
    this.#connecting = false;
    if (this.#manualClose) return;

    const socket = new WebSocket(this.url, [WS_PROTOCOL, `bearer.${token}`], {
      headers: {
        Origin: this.transport.baseUrl,
        "User-Agent": this.transport.userAgent,
        ...this.transport.headers,
      },
      handshakeTimeout: this.options.connectTimeoutMs,
    });
    this.#socket = socket;

    this.#connectTimer = setTimeout(() => {
      if (this.#socket === socket && socket.readyState === WebSocket.CONNECTING) {
        this.#dropSocket();
        this.#scheduleReconnect();
      }
    }, this.options.connectTimeoutMs);

    socket.on("open", () => {
      if (this.#socket !== socket) return;
      this.#clearConnectTimer();
      this.#reconnectDelay = this.options.reconnectMinDelayMs;
      this.#lastHeartbeatAt = Date.now();
      this.#startPing();
      this.emit("open");
    });

    socket.on("message", (data, isBinary) => {
      if (this.#socket !== socket) return;
      this.#lastHeartbeatAt = Date.now();
      const text = isBinary ? Buffer.from(data as Buffer).toString("utf8") : data.toString();
      if (!text || text === "pong") return;
      let frame: MessengerFrame;
      try {
        frame = JSON.parse(text) as MessengerFrame;
        if (!frame || typeof frame !== "object" || typeof frame.type !== "string") throw new Error("frame without type");
      } catch (error) {
        this.emit("error", new Error(`Некорректный кадр WebSocket: ${text.slice(0, 200)}`, { cause: error }));
        return;
      }
      this.emit("frame", frame);
    });

    socket.on("unexpected-response", (_req, res) => {
      if (this.#socket !== socket) return;
      if (res.statusCode === 401 || res.statusCode === 403) this.#needsAuthRefresh = true;
      this.emit("error", new Error(`WebSocket handshake отклонён: HTTP ${res.statusCode}`));
      res.resume();
      this.#dropSocket();
      this.#scheduleReconnect();
    });

    socket.on("error", (error) => {
      if (this.#socket !== socket) return;
      this.emit("error", error);
    });

    socket.on("close", (code, reasonBuf) => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      this.#clearTimers();
      const reason = reasonBuf.toString();
      if (code === WsCloseCode.AuthExpired || code === WsCloseCode.AuthRejected) this.#needsAuthRefresh = true;
      const willReconnect = !this.#manualClose;
      this.emit("close", code, reason, willReconnect);
      if (willReconnect) this.#scheduleReconnect();
    });
  }

  #startPing(): void {
    this.#stopPing();
    this.#lastPingAt = Date.now();
    const tick = Math.min(5000, this.options.pingIntervalMs);
    this.#pingTimer = setInterval(() => {
      const socket = this.#socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.#lastHeartbeatAt >= this.options.heartbeatTimeoutMs) {
        this.#dropSocket();
        this.emit("close", 4000, "heartbeat timeout", true);
        this.#scheduleReconnect();
        return;
      }
      if (Date.now() - this.#lastPingAt >= this.options.pingIntervalMs) {
        this.#lastPingAt = Date.now();
        socket.send("ping", (error) => {
          if (error) this.reconnect();
        });
      }
    }, tick);
    this.#pingTimer.unref?.();
  }

  #scheduleReconnect(): void {
    if (this.#manualClose || this.#reconnectTimer) return;
    const base = Math.min(this.#reconnectDelay, this.options.reconnectMaxDelayMs);
    const delay = Math.round(base * (0.75 + Math.random() * 0.25));
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#reconnectDelay = Math.min(base * 2, this.options.reconnectMaxDelayMs);
      void this.#open();
    }, delay);
  }

  #dropSocket(): void {
    const socket = this.#socket;
    this.#socket = null;
    this.#stopPing();
    this.#clearConnectTimer();
    if (!socket) return;
    socket.removeAllListeners();
    socket.on("error", () => undefined);
    socket.terminate();
  }

  #clearTimers(): void {
    this.#stopPing();
    this.#clearConnectTimer();
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
  }

  #clearConnectTimer(): void {
    if (this.#connectTimer) clearTimeout(this.#connectTimer);
    this.#connectTimer = null;
  }

  #stopPing(): void {
    if (this.#pingTimer) clearInterval(this.#pingTimer);
    this.#pingTimer = null;
  }
}
