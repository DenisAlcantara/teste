import {
  ConditionalCheckFailedException,
  ReturnValue,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  NativeAttributeValue,
} from '@aws-sdk/lib-dynamodb';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvVars } from '../config/env.validation';
import { DYNAMO_DOCUMENT_CLIENT } from '../shared/infrastructure/dynamodb/dynamo.module';
import {
  InvalidCursorError,
  Message,
  MessageStatus,
  StatusConflictError,
} from './message.types';

interface MessageItem {
  PK: string;
  SK: string;
  GSI1PK: string;
  GSI1SK: string;
  GSI2PK: string;
  GSI2SK: string;
  id: string;
  content: string;
  sender: string;
  sentAt: string;
  status: MessageStatus;
  updatedAt: string;
}

export interface PaginatedResult<T> {
  items: T[];
  cursor?: string;
}

@Injectable()
export class MessagesRepository {
  private readonly tableName: string;
  private readonly senderIndex = 'GSI1-sender';
  private readonly dateIndex = 'GSI2-date';

  constructor(
    @Inject(DYNAMO_DOCUMENT_CLIENT) private readonly client: DynamoDBDocumentClient,
    config: ConfigService<EnvVars, true>,
  ) {
    this.tableName = config.get('MESSAGES_TABLE', { infer: true });
  }

  async save(message: Message): Promise<void> {
    const sentAtIso = message.sentAt.toISOString();
    const day = sentAtIso.slice(0, 10);

    const item: MessageItem = {
      PK: `MSG#${message.id}`,
      SK: `MSG#${message.id}`,
      GSI1PK: `SENDER#${message.sender}`,
      GSI1SK: `${sentAtIso}#${message.id}`,
      GSI2PK: `DATE#${day}`,
      GSI2SK: `${sentAtIso}#${message.id}`,
      id: message.id,
      content: message.content,
      sender: message.sender,
      sentAt: sentAtIso,
      status: message.status,
      updatedAt: message.updatedAt.toISOString(),
    };

    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: item,
        ConditionExpression: 'attribute_not_exists(PK)',
      }),
    );
  }

  async findById(id: string): Promise<Message | null> {
    const res = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: `MSG#${id}`, SK: `MSG#${id}` },
      }),
    );
    if (!res.Item) return null;
    return toMessage(res.Item as MessageItem);
  }

  async findBySender(args: {
    sender: string;
    limit?: number;
    cursor?: string;
  }): Promise<PaginatedResult<Message>> {
    const limit = args.limit ?? 50;
    const cursor = decodeCursor(args.cursor);

    const res = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: this.senderIndex,
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: { ':pk': `SENDER#${args.sender}` },
        ScanIndexForward: false,
        Limit: limit,
        ExclusiveStartKey: cursor,
      }),
    );

    const items = ((res.Items ?? []) as MessageItem[]).map(toMessage);
    return {
      items,
      cursor: res.LastEvaluatedKey ? encodeCursor(res.LastEvaluatedKey) : undefined,
    };
  }

  async findByPeriod(args: {
    startDate: Date;
    endDate: Date;
    limit?: number;
  }): Promise<PaginatedResult<Message>> {
    const limit = args.limit ?? 50;
    const startIso = args.startDate.toISOString();
    const endIso = args.endDate.toISOString();

    const days = Array.from(eachDayInRange(args.startDate, args.endDate));

    const responses = await Promise.all(
      days.map((day) => this.queryDay(day, startIso, endIso, limit)),
    );

    const allItems = responses
      .flat()
      .sort((a, b) => b.sentAt.localeCompare(a.sentAt))
      .slice(0, limit);

    return { items: allItems.map(toMessage) };
  }

  async updateStatus(args: {
    id: string;
    from: MessageStatus;
    to: MessageStatus;
  }): Promise<Message> {
    try {
      const res = await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { PK: `MSG#${args.id}`, SK: `MSG#${args.id}` },
          UpdateExpression: 'SET #status = :next, updatedAt = :now',
          ConditionExpression: '#status = :expected',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':next': args.to,
            ':expected': args.from,
            ':now': new Date().toISOString(),
          },
          ReturnValues: ReturnValue.ALL_NEW,
        }),
      );
      return toMessage(res.Attributes as MessageItem);
    } catch (e) {
      if (e instanceof ConditionalCheckFailedException) {
        throw new StatusConflictError(args.from);
      }
      throw e;
    }
  }

  private async queryDay(
    day: string,
    startIso: string,
    endIso: string,
    maxItems: number,
  ): Promise<MessageItem[]> {
    const items: MessageItem[] = [];
    let lastEvaluatedKey: Record<string, NativeAttributeValue> | undefined;

    do {
      const remaining = maxItems - items.length;
      if (remaining <= 0) break;

      const response = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: this.dateIndex,
          KeyConditionExpression: 'GSI2PK = :pk AND GSI2SK BETWEEN :start AND :end',
          ExpressionAttributeValues: {
            ':pk': `DATE#${day}`,
            ':start': `${startIso}#`,
            ':end': `${endIso}#~`,
          },
          ScanIndexForward: false,
          Limit: remaining,
          ExclusiveStartKey: lastEvaluatedKey,
        }),
      );

      items.push(...((response.Items ?? []) as MessageItem[]));
      lastEvaluatedKey = response.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    return items;
  }
}

function toMessage(item: MessageItem): Message {
  return {
    id: item.id,
    content: item.content,
    sender: item.sender,
    sentAt: new Date(item.sentAt),
    status: item.status,
    updatedAt: new Date(item.updatedAt),
  };
}

function* eachDayInRange(start: Date, end: Date): Generator<string> {
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const stop = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  while (cursor.getTime() <= stop.getTime()) {
    yield cursor.toISOString().slice(0, 10);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
}

function encodeCursor(key: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(key)).toString('base64url');
}

function decodeCursor(cursor: string | undefined): Record<string, unknown> | undefined {
  if (!cursor) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!isValidSenderCursor(decoded)) throw new InvalidCursorError();
    return decoded as Record<string, unknown>;
  } catch (e) {
    if (e instanceof InvalidCursorError) throw e;
    throw new InvalidCursorError();
  }
}

function isValidSenderCursor(
  value: unknown,
): value is { PK: string; SK: string; GSI1PK: string; GSI1SK: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const required = ['PK', 'SK', 'GSI1PK', 'GSI1SK'] as const;
  const keys = Object.keys(record);
  if (keys.length !== required.length) return false;
  return required.every((f) => typeof record[f] === 'string' && (record[f] as string).length > 0);
}
