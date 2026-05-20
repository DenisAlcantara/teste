import { MessageStatus, canTransition } from '../../src/messages/message.types';

describe('canTransition', () => {
  it.each([
    [MessageStatus.SENT, MessageStatus.RECEIVED, true],
    [MessageStatus.RECEIVED, MessageStatus.READ, true],
    [MessageStatus.SENT, MessageStatus.READ, false],
    [MessageStatus.READ, MessageStatus.SENT, false],
    [MessageStatus.RECEIVED, MessageStatus.SENT, false],
    [MessageStatus.READ, MessageStatus.RECEIVED, false],
  ])('canTransition(%s -> %s) === %s', (from, to, expected) => {
    expect(canTransition(from, to)).toBe(expected);
  });
});
