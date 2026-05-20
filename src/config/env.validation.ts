import { plainToInstance, Type } from 'class-transformer';
import { IsEnum, IsInt, IsString, Min, validateSync } from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

export class EnvVars {
  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  PORT = 3000;

  @IsString()
  LOG_LEVEL = 'info';

  @IsString()
  CORS_ORIGINS = '*';

  @IsString()
  AWS_REGION!: string;

  @IsString()
  AWS_ACCESS_KEY_ID!: string;

  @IsString()
  AWS_SECRET_ACCESS_KEY!: string;

  @IsString()
  DYNAMODB_ENDPOINT!: string;

  @IsString()
  MESSAGES_TABLE!: string;

  @IsString()
  IDEMPOTENCY_TABLE!: string;

  @IsString()
  KAFKA_BROKERS!: string;

  @IsString()
  KAFKA_CLIENT_ID = 'messages-api';

  @IsString()
  KAFKA_GROUP_ID = 'messages-worker';

  @IsString()
  KAFKA_EVENTS_TOPIC = 'message-events';

  @IsString()
  KAFKA_EVENTS_DLQ_TOPIC = 'message-events-dlq';

  @Type(() => Number)
  @IsInt()
  @Min(1)
  KAFKA_CONSUMER_MAX_ATTEMPTS = 3;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  KAFKA_CONSUMER_RETRY_BASE_MS = 200;

  @IsString()
  KAFKA_PRODUCER_ACKS = '-1';

  @IsString()
  DEMO_PASSWORD!: string;

  @IsString()
  JWT_ACCESS_SECRET!: string;

  @IsString()
  JWT_ACCESS_TTL = '15m';

  @Type(() => Number)
  @IsInt()
  @Min(60)
  IDEMPOTENCY_TTL_SECONDS = 86400;
}

export function validateEnv(config: Record<string, unknown>): EnvVars {
  const parsed = plainToInstance(EnvVars, config, { enableImplicitConversion: true });
  const errors = validateSync(parsed, { skipMissingProperties: false });
  if (errors.length > 0) {
    throw new Error(
      `Invalid environment variables:\n${errors
        .map((e) => `  - ${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`)
        .join('\n')}`,
    );
  }
  return parsed;
}
