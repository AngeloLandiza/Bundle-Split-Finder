import { describe, expect, it } from 'vitest';
import { createSseParser, type SseMessage } from './sse';

describe('createSseParser', () => {
  it('joins a message split across chunks and skips comments', () => {
    const got: SseMessage[] = [];
    const feed = createSseParser((m) => got.push(m));
    feed(': keep-alive\n\nevent: review\nda');
    feed('ta: {"type":"review"}\n\nevent: state\r\ndata: {"a":1}\r\n\r\n');
    expect(got).toEqual([
      { event: 'review', data: '{"type":"review"}' },
      { event: 'state', data: '{"a":1}' },
    ]);
  });
});
