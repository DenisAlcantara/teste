import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateMessageDto } from '../../src/messages/dto/create-message.dto';
import { FindMessagesQuery } from '../../src/messages/dto/find-messages.query';
import { UpdateStatusDto } from '../../src/messages/dto/update-status.dto';

function check<T extends object>(cls: new () => T, raw: unknown) {
  const obj = plainToInstance(cls, raw, { enableImplicitConversion: true });
  return validateSync(obj, { whitelist: true, forbidNonWhitelisted: true });
}

describe('DTO contracts', () => {
  describe('CreateMessageDto', () => {
    it('accepts valid payload', () => {
      expect(check(CreateMessageDto, { content: 'hi', sender: 'alice' })).toHaveLength(0);
    });
    it('rejects empty content', () => {
      expect(check(CreateMessageDto, { content: '', sender: 'a' }).length).toBeGreaterThan(0);
    });
    it('rejects content > 5000 chars', () => {
      expect(
        check(CreateMessageDto, { content: 'x'.repeat(5001), sender: 'a' }).length,
      ).toBeGreaterThan(0);
    });
  });

  describe('UpdateStatusDto', () => {
    it('accepts enviado, recebido, lido', () => {
      for (const status of ['enviado', 'recebido', 'lido']) {
        expect(check(UpdateStatusDto, { status })).toHaveLength(0);
      }
    });
    it('rejects unknown status', () => {
      expect(check(UpdateStatusDto, { status: 'queimado' }).length).toBeGreaterThan(0);
    });
  });

  describe('FindMessagesQuery', () => {
    it('accepts sender-only query', () => {
      expect(check(FindMessagesQuery, { sender: 'alice' })).toHaveLength(0);
    });
    it('accepts startDate+endDate query', () => {
      expect(
        check(FindMessagesQuery, {
          startDate: '2026-01-01T00:00:00.000Z',
          endDate: '2026-01-31T23:59:59.999Z',
        }),
      ).toHaveLength(0);
    });
  });
});
