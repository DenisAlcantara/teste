import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvVars } from '../../config/env.validation';
import { DYNAMO_DOCUMENT_CLIENT } from '../infrastructure/dynamodb/dynamo.module';

export interface IdempotencyRecord {
  key: string;
  status: 'in_progress' | 'completed';
  responseBody?: string;
  statusCode?: number;
  ttl: number;
}

@Injectable()
export class IdempotencyService {
  private readonly tableName: string;
  private readonly ttlSeconds: number;
  private readonly inProgressTtlSeconds = 60;
  private readonly maxAcquireRetries = 3;

  constructor(
    @Inject(DYNAMO_DOCUMENT_CLIENT) private readonly client: DynamoDBDocumentClient,
    config: ConfigService<EnvVars, true>,
  ) {
    this.tableName = config.get('IDEMPOTENCY_TABLE', { infer: true });
    this.ttlSeconds = config.get('IDEMPOTENCY_TTL_SECONDS', { infer: true });
  }

  async acquire(
    key: string,
  ): Promise<{ acquired: true } | { acquired: false; existing: IdempotencyRecord }> {
    for (let attempt = 1; attempt <= this.maxAcquireRetries; attempt++) {
      const now = Math.floor(Date.now() / 1000);
      const item: IdempotencyRecord = {
        key,
        status: 'in_progress',
        ttl: now + this.inProgressTtlSeconds,
      };

      try {
        await this.client.send(
          new PutCommand({
            TableName: this.tableName,
            Item: { PK: `IDEMP#${key}`, ...item },
            ConditionExpression: 'attribute_not_exists(PK)',
          }),
        );
        return { acquired: true };
      } catch (e) {
        if (!(e instanceof ConditionalCheckFailedException)) throw e;
        const existing = await this.fetch(key);
        if (existing) return { acquired: false, existing };
      }
    }

    throw new Error(`failed to acquire idempotency key after ${this.maxAcquireRetries} retries`);
  }

  async complete(key: string, statusCode: number, responseBody: unknown): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await this.client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { PK: `IDEMP#${key}` },
        UpdateExpression:
          'SET #s = :completed, statusCode = :code, responseBody = :body, #ttl = :ttl',
        ExpressionAttributeNames: { '#s': 'status', '#ttl': 'ttl' },
        ExpressionAttributeValues: {
          ':completed': 'completed',
          ':code': statusCode,
          ':body': JSON.stringify(responseBody),
          ':ttl': now + this.ttlSeconds,
        },
      }),
    );
  }

  async release(key: string): Promise<void> {
    await this.client.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { PK: `IDEMP#${key}` },
      }),
    );
  }

  private async fetch(key: string): Promise<IdempotencyRecord | null> {
    const res = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: `IDEMP#${key}` },
        ConsistentRead: true,
      }),
    );
    return (res.Item as IdempotencyRecord | undefined) ?? null;
  }
}
