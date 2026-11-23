// A small server-sent-events reader. EventSource cannot send the bearer token, so the real
// client reads /api/events with fetch and feeds the text through this parser.

export interface SseMessage {
  event: string;
  data: string;
}

/** Feeds chunks in; calls `emit` for every complete message. Keeps a partial message between chunks. */
export function createSseParser(emit: (m: SseMessage) => void): (chunk: string) => void {
  let buffer = '';
  return (chunk: string) => {
    buffer += chunk.replace(/\r\n?/g, '\n');
    let end = buffer.indexOf('\n\n');
    while (end >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line === '' || line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
      }
      if (data.length) emit({ event, data: data.join('\n') });
      end = buffer.indexOf('\n\n');
    }
  };
}
