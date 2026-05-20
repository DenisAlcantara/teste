import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { MessageEventPublisher } from '../../src/messages/kafka.publisher';
import {
  InvalidCursorError,
  Message,
  MessageStatus,
  StatusConflictError,
  newMessage,
} from '../../src/messages/message.types';
import { MessagesRepository } from '../../src/messages/messages.repository';
import { MessagesService } from '../../src/messages/messages.service';

type RepoMock = jest.Mocked<
  Pick<MessagesRepository, 'save' | 'findById' | 'findBySender' | 'findByPeriod' | 'updateStatus'>
>;
type PublisherMock = jest.Mocked<Pick<MessageEventPublisher, 'publish'>>;

describe('MessagesService', () => {
  let repo: RepoMock;
  let publisher: PublisherMock;
  let service: MessagesService;

  beforeEach(() => {
    repo = {
      save: jest.fn().mockResolvedValue(undefined),
      findById: jest.fn(),
      findBySender: jest.fn(),
      findByPeriod: jest.fn(),
      updateStatus: jest.fn(),
    };
    publisher = { publish: jest.fn().mockResolvedValue(undefined) };
    service = new MessagesService(
      repo as unknown as MessagesRepository,
      publisher as unknown as MessageEventPublisher,
    );
  });

  describe('create', () => {
    it('persists message and publishes event', async () => {
      const msg = await service.create({ content: 'hi', sender: 'alice' });

      expect(msg.status).toBe(MessageStatus.SENT);
      expect(repo.save).toHaveBeenCalledWith(msg);
      expect(publisher.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'message.created',
          messageId: msg.id,
          sender: 'alice',
        }),
      );
    });

    it('returns message even when publish fails (persistence is source of truth)', async () => {
      publisher.publish.mockRejectedValueOnce(new Error('kafka unavailable'));
      const msg = await service.create({ content: 'hi', sender: 'alice' });
      expect(msg.id).toEqual(expect.any(String));
      expect(repo.save).toHaveBeenCalled();
    });
  });

  describe('updateStatus', () => {
    it('throws NotFoundException when message missing', async () => {
      repo.findById.mockResolvedValueOnce(null);
      await expect(
        service.updateStatus({ id: 'x', nextStatus: MessageStatus.RECEIVED }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects invalid transitions with ConflictException', async () => {
      const msg = newMessage({ content: 'hi', sender: 'a' }); // SENT
      repo.findById.mockResolvedValueOnce(msg);
      await expect(
        service.updateStatus({ id: msg.id, nextStatus: MessageStatus.READ }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repo.updateStatus).not.toHaveBeenCalled();
    });

    it('translates repo StatusConflictError into ConflictException', async () => {
      const msg = newMessage({ content: 'hi', sender: 'a' });
      repo.findById.mockResolvedValueOnce(msg);
      repo.updateStatus.mockRejectedValueOnce(new StatusConflictError(MessageStatus.SENT));
      await expect(
        service.updateStatus({ id: msg.id, nextStatus: MessageStatus.RECEIVED }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('persists, returns updated message, publishes event', async () => {
      const msg = newMessage({ content: 'hi', sender: 'a' });
      repo.findById.mockResolvedValueOnce(msg);
      const updated: Message = {
        ...msg,
        status: MessageStatus.RECEIVED,
        updatedAt: new Date(),
      };
      repo.updateStatus.mockResolvedValueOnce(updated);

      const out = await service.updateStatus({
        id: msg.id,
        nextStatus: MessageStatus.RECEIVED,
      });

      expect(out).toBe(updated);
      expect(repo.updateStatus).toHaveBeenCalledWith({
        id: msg.id,
        from: MessageStatus.SENT,
        to: MessageStatus.RECEIVED,
      });
      expect(publisher.publish).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'message.status_changed' }),
      );
    });
  });

  describe('findBySender', () => {
    it('translates InvalidCursorError into BadRequestException', async () => {
      repo.findBySender.mockRejectedValueOnce(new InvalidCursorError());
      await expect(
        service.findBySender({ sender: 'alice', cursor: 'broken-cursor' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
