import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from '../config/env.validation';
import { LoggerModule } from '../shared/logger/logger.module';
import { DynamoModule } from '../shared/infrastructure/dynamodb/dynamo.module';
import { KafkaModule } from '../shared/infrastructure/kafka/kafka.module';
import { MessageConsumerService } from './message-consumer.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv, cache: true }),
    LoggerModule,
    DynamoModule,
    KafkaModule,
  ],
  providers: [MessageConsumerService],
})
export class WorkerModule {}
