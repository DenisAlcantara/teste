import { randomUUID } from 'node:crypto';

export enum MessageStatus {
  SENT = 'enviado',
  RECEIVED = 'recebido',
  READ = 'lido',
}

const ALLOWED_TRANSITIONS: Record<MessageStatus, MessageStatus[]> = {
  [MessageStatus.SENT]: [MessageStatus.RECEIVED],
  [MessageStatus.RECEIVED]: [MessageStatus.READ],
  [MessageStatus.READ]: [],
};

export function canTransition(from: MessageStatus, to: MessageStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export class InvalidStatusTransitionError extends Error {
  constructor(from: MessageStatus, to: MessageStatus) {
    super(`Invalid status transition: ${from} -> ${to}`);
    this.name = 'InvalidStatusTransitionError';
  }
}

export class StatusConflictError extends Error {
  constructor(public readonly expectedFrom: MessageStatus) {
    super(`Status conflict: expected current=${expectedFrom}`);
    this.name = 'StatusConflictError';
  }
}

export class InvalidCursorError extends Error {
  constructor() {
    super('invalid cursor');
    this.name = 'InvalidCursorError';
  }
}

export interface Message {
  id: string;
  content: string;
  sender: string;
  sentAt: Date;
  status: MessageStatus;
  updatedAt: Date;
}

export function newMessage(input: { content: string; sender: string }): Message {
  const now = new Date();
  return {
    id: randomUUID(),
    content: input.content,
    sender: input.sender,
    sentAt: now,
    status: MessageStatus.SENT,
    updatedAt: now,
  };
}
