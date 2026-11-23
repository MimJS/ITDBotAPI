import { ITD_SYSTEM_USER_ID } from "./constants.js";
import type { ChatAction } from "./enums.js";
import type { ITDBotAPI, SendFileOptions, SendTextOptions } from "./client.js";
import type { Attachment, Message, MessageEntity, Reaction, ReplyPreview, SentMessage } from "./types.js";
import type { FileSource } from "./utils/file.js";

/** Разобранная команда вида `/cat arg1 arg2`. */
export interface ParsedCommand {
  /** Имя команды в нижнем регистре, без префикса: `cat`. */
  name: string;
  /** Префикс, с которым пришла команда: `/`. */
  prefix: string;
  /** Аргументы, разделённые пробелами. */
  args: string[];
  /** Всё, что после имени команды. */
  argsText: string;
}

export interface ReplyOptions extends Omit<SendTextOptions, "replyTo"> {
  /** Процитировать исходное сообщение (reply_to). По умолчанию false. */
  quote?: boolean;
}

export interface ReplyFileOptions extends Omit<SendFileOptions, "replyTo"> {
  quote?: boolean;
}

/** Разбирает команду: `/cat`, `/cat 3`, `/cat@bot 3`. */
export function parseCommand(text: string, prefixes: readonly string[]): ParsedCommand | null {
  const trimmed = text.trim();
  for (const prefix of [...prefixes].sort((a, b) => b.length - a.length)) {
    if (!prefix || !trimmed.startsWith(prefix)) continue;
    const match = /^([^\s@]+)(?:@\S+)?(?:\s+([\s\S]*))?$/u.exec(trimmed.slice(prefix.length));
    if (!match?.[1]) continue;
    const argsText = (match[2] ?? "").trim();
    return {
      name: match[1].toLocaleLowerCase("ru-RU"),
      prefix,
      args: argsText ? argsText.split(/\s+/u) : [],
      argsText,
    };
  }
  return null;
}

/** Контекст сообщения: само сообщение + удобные методы ответа. */
export class MessageContext {
  /** Заполняется, если сообщение совпало с `client.command(...)`. */
  command: ParsedCommand | null = null;
  /** Заполняется, если сообщение совпало с `client.hears(RegExp)`. */
  match: RegExpExecArray | null = null;

  constructor(
    readonly client: ITDBotAPI,
    readonly chatId: string,
    readonly message: Message,
  ) {}

  get id(): string {
    return this.message.message_id;
  }

  /** Текст сообщения (пустая строка, если текста нет). */
  get text(): string {
    return this.message.text ?? "";
  }

  get senderId(): string {
    return this.message.sender_id;
  }

  /** Сообщение отправили вы сами (с этого клиента или другого устройства). */
  get isOwn(): boolean {
    return this.message.sender_id === this.client.userId;
  }

  /** Служебное сообщение от системного аккаунта «ИТД». */
  get isSystem(): boolean {
    return this.message.sender_id === ITD_SYSTEM_USER_ID;
  }

  get date(): Date {
    return new Date(this.message.created_at);
  }

  get attachments(): Attachment[] {
    return this.message.attachments ?? [];
  }

  /** Вложения-картинки. */
  get photos(): Attachment[] {
    return this.attachments.filter((a) => a.mime?.startsWith("image/"));
  }

  get entities(): MessageEntity[] {
    return this.message.entities ?? [];
  }

  /** На какое сообщение это ответ. */
  get replyTo(): ReplyPreview | null {
    return this.message.reply_to ?? null;
  }

  get isForwarded(): boolean {
    return !!this.message.forwarded_from_msg;
  }

  /** Отправить текст в этот же чат. */
  reply(text: string, options: ReplyOptions = {}): Promise<SentMessage> {
    const { quote, ...rest } = options;
    return this.client.sendMessage(this.chatId, text, { ...rest, ...(quote ? { replyTo: this.id } : {}) });
  }

  /** Отправить картинку в этот же чат. */
  replyWithPhoto(photo: FileSource, options: ReplyFileOptions = {}): Promise<SentMessage> {
    const { quote, ...rest } = options;
    return this.client.sendPhoto(this.chatId, photo, { ...rest, ...(quote ? { replyTo: this.id } : {}) });
  }

  /** Отправить любой файл в этот же чат. */
  replyWithFile(file: FileSource, options: ReplyFileOptions = {}): Promise<SentMessage> {
    const { quote, ...rest } = options;
    return this.client.sendFile(this.chatId, file, { ...rest, ...(quote ? { replyTo: this.id } : {}) });
  }

  /** Показать «печатает…» / «отправляет фото…». */
  sendChatAction(action: ChatAction | `${ChatAction}` = "typing"): Promise<void> {
    return this.client.messenger.sendChatAction(this.chatId, action);
  }

  /** Отметить чат прочитанным до этого сообщения. */
  markRead(): Promise<unknown> {
    return this.client.messenger.markRead(this.chatId, this.id);
  }

  /** Поставить реакции (заменяет ваш набор реакций на этом сообщении). Пустой массив — убрать все. */
  react(reactions: string | Reaction | Array<string | Reaction>): Promise<unknown> {
    return this.client.react(this.chatId, this.id, reactions, { expectedVersion: this.message.reaction_version ?? undefined });
  }

  /** Отредактировать (только своё сообщение). */
  edit(text: string, entities?: MessageEntity[]): Promise<unknown> {
    return this.client.messenger.editMessage(this.chatId, this.id, text, entities ? { entities } : {});
  }

  /** Удалить сообщение у себя или у всех. */
  delete(options: { forEveryone?: boolean } = {}): Promise<unknown> {
    return this.client.messenger.deleteMessages(this.chatId, [this.id], options);
  }

  /** Переслать это сообщение в другой чат. */
  forwardTo(targetChatId: string): Promise<unknown> {
    return this.client.messenger.forwardMessages(targetChatId, this.chatId, [this.id]);
  }

  /** Принять входящий запрос на переписку в этом чате. */
  acceptRequest(): Promise<unknown> {
    return this.client.messenger.acceptRequest(this.chatId);
  }

  /** Скачать все вложения сообщения. */
  downloadAttachments(): Promise<Buffer[]> {
    return Promise.all(this.attachments.map((a) => this.client.downloadAttachment(a, this.chatId)));
  }
}
