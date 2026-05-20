import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import { IdempotencyInterceptor } from '../shared/idempotency/idempotency.interceptor';
import { CreateMessageDto } from './dto/create-message.dto';
import { FindMessagesQuery } from './dto/find-messages.query';
import { UpdateStatusDto } from './dto/update-status.dto';
import { Message, MessageStatus } from './message.types';
import { MessagesService } from './messages.service';

interface MessageResponse {
  id: string;
  content: string;
  sender: string;
  sentAt: string;
  status: MessageStatus;
  updatedAt: string;
}

interface PaginatedMessagesResponse {
  items: MessageResponse[];
  cursor?: string;
}

const BRT_OFFSET_HOURS = -3;

function toBrtIso(d: Date): string {
  const shifted = new Date(d.getTime() + BRT_OFFSET_HOURS * 3600 * 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const y = shifted.getUTCFullYear();
  const M = pad(shifted.getUTCMonth() + 1);
  const D = pad(shifted.getUTCDate());
  const h = pad(shifted.getUTCHours());
  const m = pad(shifted.getUTCMinutes());
  const s = pad(shifted.getUTCSeconds());
  const ms = pad(shifted.getUTCMilliseconds(), 3);
  return `${y}-${M}-${D}T${h}:${m}:${s}.${ms}-03:00`;
}

function toResponse(m: Message): MessageResponse {
  return {
    id: m.id,
    content: m.content,
    sender: m.sender,
    sentAt: toBrtIso(m.sentAt),
    status: m.status,
    updatedAt: toBrtIso(m.updatedAt),
  };
}

@Controller('messages')
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(IdempotencyInterceptor)
  async create(@Body() dto: CreateMessageDto): Promise<MessageResponse> {
    return toResponse(await this.messages.create(dto));
  }

  @Get(':id')
  async getById(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<MessageResponse> {
    return toResponse(await this.messages.findById(id));
  }

  @Get()
  async find(@Query() query: FindMessagesQuery): Promise<PaginatedMessagesResponse> {
    const hasSender = !!query.sender;
    const hasStart = !!query.startDate;
    const hasEnd = !!query.endDate;

    if (!hasSender && !hasStart && !hasEnd) {
      throw new BadRequestException('either sender or startDate+endDate must be provided');
    }
    if (hasSender && (hasStart || hasEnd)) {
      throw new BadRequestException('use either sender or startDate+endDate, not both');
    }
    if (hasStart !== hasEnd) {
      throw new BadRequestException('startDate and endDate must both be present');
    }
    if (query.cursor && (hasStart || hasEnd)) {
      throw new BadRequestException('cursor not supported with date range');
    }

    if (hasSender) {
      const result = await this.messages.findBySender({
        sender: query.sender!,
        limit: query.limit,
        cursor: query.cursor,
      });
      return { items: result.items.map(toResponse), cursor: result.cursor };
    }

    const result = await this.messages.findByPeriod({
      startDate: query.startDate!,
      endDate: query.endDate!,
      limit: query.limit,
    });
    return { items: result.items.map(toResponse) };
  }

  @Patch(':id/status')
  async updateMessageStatus(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateStatusDto,
  ): Promise<MessageResponse> {
    return toResponse(await this.messages.updateStatus({ id, nextStatus: dto.status }));
  }
}
