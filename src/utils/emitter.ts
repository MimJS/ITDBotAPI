type Listener<A extends unknown[]> = (...args: A) => unknown;

/**
 * Маленький типизированный EventEmitter.
 * Асинхронные обработчики не теряют ошибки: исключения и отклонённые промисы уходят в `onListenerError`.
 */
export class TypedEmitter<Events extends { [K in keyof Events]: unknown[] }> {
  #listeners = new Map<keyof Events, Set<{ fn: Listener<never[]>; once: boolean }>>();

  /** Куда отправлять ошибки из обработчиков. По умолчанию — console.error. */
  protected onListenerError(error: unknown, event: keyof Events): void {
    console.error(`[itdbotapi] Ошибка в обработчике события "${String(event)}":`, error);
  }

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): this {
    this.#add(event, listener, false);
    return this;
  }

  once<K extends keyof Events>(event: K, listener: Listener<Events[K]>): this {
    this.#add(event, listener, true);
    return this;
  }

  off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): this {
    const set = this.#listeners.get(event);
    if (!set) return this;
    for (const entry of set) if (entry.fn === (listener as unknown)) set.delete(entry);
    return this;
  }

  removeAllListeners<K extends keyof Events>(event?: K): this {
    if (event === undefined) this.#listeners.clear();
    else this.#listeners.delete(event);
    return this;
  }

  listenerCount<K extends keyof Events>(event: K): number {
    return this.#listeners.get(event)?.size ?? 0;
  }

  /** Ждёт следующего события и возвращает его аргументы. */
  waitFor<K extends keyof Events>(event: K, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Events[K]> {
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const listener = ((...args: Events[K]) => {
        cleanup();
        resolve(args);
      }) as Listener<Events[K]>;
      const onAbort = () => {
        cleanup();
        reject(options.signal?.reason ?? new Error("Aborted"));
      };
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        this.off(event, listener);
      };
      if (options.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          cleanup();
          reject(new Error(`Timeout waiting for "${String(event)}"`));
        }, options.timeoutMs);
      }
      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.on(event, listener);
    });
  }

  /** Вызывает обработчики. Возвращает true, если они были. */
  protected emit<K extends keyof Events>(event: K, ...args: Events[K]): boolean {
    const set = this.#listeners.get(event);
    if (!set || set.size === 0) return false;
    for (const entry of [...set]) {
      if (entry.once) set.delete(entry);
      try {
        const result = (entry.fn as Listener<Events[K]>)(...args);
        if (result && typeof (result as Promise<unknown>).then === "function") {
          (result as Promise<unknown>).then(undefined, (error) => this.onListenerError(error, event));
        }
      } catch (error) {
        this.onListenerError(error, event);
      }
    }
    return true;
  }

  #add<K extends keyof Events>(event: K, listener: Listener<Events[K]>, once: boolean): void {
    let set = this.#listeners.get(event);
    if (!set) this.#listeners.set(event, (set = new Set()));
    set.add({ fn: listener as unknown as Listener<never[]>, once });
  }
}
