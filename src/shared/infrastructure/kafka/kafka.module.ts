import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kafka, Producer, logLevel } from 'kafkajs';
import { EnvVars } from '../../../config/env.validation';

export const KAFKA_CLIENT = Symbol('KAFKA_CLIENT');
export const KAFKA_PRODUCER = Symbol('KAFKA_PRODUCER');

@Injectable()
export class KafkaProducerLifecycle implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(KafkaProducerLifecycle.name);

  constructor(@Inject(KAFKA_PRODUCER) private readonly producer: Producer) {}

  async onModuleInit(): Promise<void> {
    await this.producer.connect();
    this.logger.log('kafka producer connected');
  }

  async onApplicationShutdown(): Promise<void> {
    try {
      await this.producer.disconnect();
    } catch (err) {
      this.logger.error({ err }, 'failed to disconnect kafka producer');
    }
  }
}

@Global()
@Module({
  providers: [
    {
      provide: KAFKA_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvVars, true>) =>
        new Kafka({
          clientId: config.get('KAFKA_CLIENT_ID', { infer: true }),
          brokers: config
            .get('KAFKA_BROKERS', { infer: true })
            .split(',')
            .map((b) => b.trim())
            .filter(Boolean),
          logLevel: logLevel.WARN,
          retry: { retries: 5, initialRetryTime: 200 },
        }),
    },
    {
      provide: KAFKA_PRODUCER,
      inject: [KAFKA_CLIENT],
      useFactory: (kafka: Kafka) =>
        kafka.producer({
          idempotent: true,
          maxInFlightRequests: 5,
          allowAutoTopicCreation: false,
          transactionTimeout: 30_000,
        }),
    },
    KafkaProducerLifecycle,
  ],
  exports: [KAFKA_CLIENT, KAFKA_PRODUCER],
})
export class KafkaModule {}
