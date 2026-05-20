import { IsEnum } from 'class-validator';
import { MessageStatus } from '../message.types';

export class UpdateStatusDto {
  @IsEnum(MessageStatus, { message: 'status must be one of: enviado, recebido, lido' })
  status!: MessageStatus;
}
