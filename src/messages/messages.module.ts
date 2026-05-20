import { Module } from '@nestjs/common';
import { IdempotencyModule } from '../shared/idempotency/idempotency.module';
import { MessageEventPublisher } from './kafka.publisher';
import { MessagesController } from './messages.controller';
import { MessagesRepository } from './messages.repository';
import { MessagesService } from './messages.service';

@Module({
  imports: [IdempotencyModule],
  controllers: [MessagesController],
  providers: [MessagesService, MessagesRepository, MessageEventPublisher],
  exports: [MessagesRepository],
})
export class MessagesModule {}
