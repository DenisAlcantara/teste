export interface MessageCreatedEvent {
  type: 'message.created';
  messageId: string;
  sender: string;
  sentAt: string;
}

export interface MessageStatusChangedEvent {
  type: 'message.status_changed';
  messageId: string;
  from: string;
  to: string;
  changedAt: string;
}

export type MessageEvent = MessageCreatedEvent | MessageStatusChangedEvent;
