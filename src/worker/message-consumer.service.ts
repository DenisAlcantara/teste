import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Consumer, EachMessagePayload, Kafka, Producer } from 'kafkajs';
import { EnvVars } from '../config/env.validation';
import { MessageEvent } from '../messages/events';
import {
  KAFKA_CLIENT,
  KAFKA_PRODUCER,
} from '../shared/infrastructure/kafka/kafka.module';

@Injectable()
export class MessageConsumerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(MessageConsumerService.name);
  private readonly topic: string;
  private readonly dlqTopic: string;
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private readonly consumer: Consumer;
  private running = false;

  constructor(
    @Inject(KAFKA_CLIENT) private readonly kafka: Kafka,
    @Inject(KAFKA_PRODUCER) private readonly producer: Producer,
    config: ConfigService<EnvVars, true>,
  ) {
    this.topic = config.get('KAFKA_EVENTS_TOPIC', { infer: true });
    this.dlqTopic = config.get('KAFKA_EVENTS_DLQ_TOPIC', { infer: true });
    this.maxAttempts = config.get('KAFKA_CONSUMER_MAX_ATTEMPTS', { infer: true });
    this.retryBaseMs = config.get('KAFKA_CONSUMER_RETRY_BASE_MS', { infer: true });

    this.consumer = this.kafka.consumer({
      groupId: config.get('KAFKA_GROUP_ID', { infer: true }),
      sessionTimeout: 30_000,
      heartbeatInterval: 3_000,
      maxWaitTimeInMs: 1_000,
      retry: { retries: 8, initialRetryTime: 300 },
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: this.topic, fromBeginning: false });

    this.running = true;
    await this.consumer.run({
      autoCommit: true,
      eachMessage: async (payload) => {
        if (!this.running) {
          throw new Error('consumer shutting down — offset not committed');
        }
        await this.handleMessage(payload);
      },
    });

    this.logger.log(`worker subscribed to ${this.topic}`);
  }

  async onApplicationShutdown(): Promise<void> {
    this.running = false;
    try {
      await this.consumer.disconnect();
    } catch (err) {
      this.logger.error({ err }, 'failed to disconnect kafka consumer');
    }
  }

  private async handleMessage(payload: EachMessagePayload): Promise<void> {
    const raw = payload.message.value?.toString() ?? '{}';

    let event: MessageEvent;
    try {
      event = JSON.parse(raw);
    } catch (err) {
      this.logger.error({ err, raw }, 'malformed event — sending straight to DLQ');
      await this.sendToDlq(payload, 'malformed_json', err);
      return;
    }

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        await this.process(event);
        return;
      } catch (err) {
        this.logger.warn(
          { err, attempt, messageId: event.messageId },
          `process attempt ${attempt}/${this.maxAttempts} failed`,
        );
        if (attempt < this.maxAttempts) {
          await sleep(this.retryBaseMs * 2 ** (attempt - 1));
        } else {
          await this.sendToDlq(payload, 'max_attempts_exceeded', err);
        }
      }
    }
  }

  private async sendToDlq(
    payload: EachMessagePayload,
    reason: string,
    err: unknown,
  ): Promise<void> {
    const errMessage = err instanceof Error ? err.message : String(err);

    await this.producer.send({
      topic: this.dlqTopic,
      messages: [
        {
          key: payload.message.key ?? undefined,
          value: payload.message.value ?? null,
          headers: {
            ...(payload.message.headers ?? {}),
            dlqReason: reason,
            dlqError: errMessage,
            dlqOriginalTopic: payload.topic,
            dlqOriginalPartition: String(payload.partition),
            dlqOriginalOffset: payload.message.offset,
          },
        },
      ],
    });

    this.logger.error(
      { reason, errMessage, offset: payload.message.offset },
      'message routed to DLQ',
    );
  }

  private async process(event: MessageEvent): Promise<void> {
    this.logger.log(
      { type: event.type, messageId: event.messageId },
      'processing message event',
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
