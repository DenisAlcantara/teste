import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Producer } from 'kafkajs';
import { EnvVars } from '../config/env.validation';
import { KAFKA_PRODUCER } from '../shared/infrastructure/kafka/kafka.module';
import { MessageEvent } from './events';

@Injectable()
export class MessageEventPublisher {
  private readonly topic: string;
  private readonly acks: number;

  constructor(
    @Inject(KAFKA_PRODUCER) private readonly producer: Producer,
    config: ConfigService<EnvVars, true>,
  ) {
    this.topic = config.get('KAFKA_EVENTS_TOPIC', { infer: true });
    this.acks = parseInt(config.get('KAFKA_PRODUCER_ACKS', { infer: true }), 10);
  }

  async publish(event: MessageEvent): Promise<void> {
    await this.producer.send({
      topic: this.topic,
      acks: Number.isNaN(this.acks) ? -1 : this.acks,
      messages: [
        {
          key: event.messageId,
          value: JSON.stringify(event),
          headers: { eventType: event.type },
        },
      ],
    });
  }
}
