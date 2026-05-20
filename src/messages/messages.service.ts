import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CreateMessageDto } from './dto/create-message.dto';
import { MessageEventPublisher } from './kafka.publisher';
import {
  InvalidCursorError,
  InvalidStatusTransitionError,
  Message,
  MessageStatus,
  StatusConflictError,
  canTransition,
  newMessage,
} from './message.types';
import { MessagesRepository, PaginatedResult } from './messages.repository';

const MAX_RANGE_DAYS = 31;

@Injectable()
export class MessagesService {
  private readonly logger = new Logger(MessagesService.name);

  constructor(
    private readonly repo: MessagesRepository,
    private readonly publisher: MessageEventPublisher,
  ) {}

  async create(dto: CreateMessageDto): Promise<Message> {
    const message = newMessage({ content: dto.content, sender: dto.sender });
    await this.repo.save(message);

    try {
      await this.publisher.publish({
        type: 'message.created',
        messageId: message.id,
        sender: message.sender,
        sentAt: message.sentAt.toISOString(),
      });
    } catch (err) {
      this.logger.error(
        { err, messageId: message.id },
        'failed to publish message.created — message persisted, event lost',
      );
    }

    return message;
  }

  async findById(id: string): Promise<Message> {
    const found = await this.repo.findById(id);
    if (!found) throw new NotFoundException(`Message ${id} not found`);
    return found;
  }

  async findBySender(args: {
    sender: string;
    limit?: number;
    cursor?: string;
  }): Promise<PaginatedResult<Message>> {
    try {
      return await this.repo.findBySender(args);
    } catch (e) {
      if (e instanceof InvalidCursorError) throw new BadRequestException(e.message);
      throw e;
    }
  }

  findByPeriod(args: {
    startDate: string;
    endDate: string;
    limit?: number;
  }): Promise<PaginatedResult<Message>> {
    const start = new Date(args.startDate);
    const end = new Date(args.endDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new BadRequestException('invalid date format');
    }
    if (start > end) throw new BadRequestException('startDate must be <= endDate');

    const days = (end.getTime() - start.getTime()) / 86_400_000;
    if (days > MAX_RANGE_DAYS) {
      throw new BadRequestException(`range exceeds max of ${MAX_RANGE_DAYS} days`);
    }

    return this.repo.findByPeriod({ startDate: start, endDate: end, limit: args.limit });
  }

  async updateStatus(args: { id: string; nextStatus: MessageStatus }): Promise<Message> {
    const current = await this.repo.findById(args.id);
    if (!current) throw new NotFoundException(`Message ${args.id} not found`);

    if (!canTransition(current.status, args.nextStatus)) {
      throw new ConflictException(
        new InvalidStatusTransitionError(current.status, args.nextStatus).message,
      );
    }

    let updated: Message;
    try {
      updated = await this.repo.updateStatus({
        id: args.id,
        from: current.status,
        to: args.nextStatus,
      });
    } catch (e) {
      if (e instanceof StatusConflictError) throw new ConflictException(e.message);
      throw e;
    }

    try {
      await this.publisher.publish({
        type: 'message.status_changed',
        messageId: updated.id,
        from: current.status,
        to: args.nextStatus,
        changedAt: updated.updatedAt.toISOString(),
      });
    } catch (err) {
      this.logger.error({ err, messageId: updated.id }, 'failed to publish status_changed event');
    }

    return updated;
  }
}
