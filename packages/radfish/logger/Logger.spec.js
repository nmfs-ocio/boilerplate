import { describe, it, expect } from 'vitest';
import { Logger, next, drop } from './Logger.js';

/**
 * Tests for the core Logger: level filtering, the return-based middleware
 * pipeline, attribute isolation, and record ordering.
 *
 * The Logger drains its queue asynchronously, so after logging we await a
 * macrotask (`flush`) before asserting on what reached the sink.
 */

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

// A sink that just records everything it receives.
function captureSink() {
  const records = [];
  return { records, write: (r) => records.push(r) };
}

describe('Logger level filtering', () => {
  it('drops records below the stream level', async () => {
    const sink = captureSink();
    const logger = new Logger({ streams: { app: { level: 'info', sinks: [sink] } } });

    logger.stream('app').debug('too quiet'); // below info -> dropped
    logger.stream('app').info('kept');
    logger.stream('app').warn('kept');
    logger.stream('app').error('kept');
    await flush();

    const messages = sink.records.map((r) => r.message);
    expect(messages).not.toContain('too quiet');
    expect(messages).toEqual(['kept', 'kept', 'kept']);
  });
});

describe('Logger middleware', () => {
  it('drops a record when middleware returns drop()', async () => {
    const sink = captureSink();
    const logger = new Logger({
      streams: { app: { level: 'info', sinks: [sink] } },
      middleware: [(r) => (r.message.includes('secret') ? drop('redacted') : next())],
    });

    logger.stream('app').info('hello');
    logger.stream('app').info('my secret token');
    await flush();

    const messages = sink.records.map((r) => r.message);
    expect(messages).toEqual(['hello']);
  });

  it('does not mutate the caller\'s attributes object', async () => {
    const sink = captureSink();
    const logger = new Logger({
      streams: { app: { level: 'info', sinks: [sink] } },
      middleware: [(r) => { r.attributes.sessionId = 'S1'; return next(); }],
    });

    const callerAttrs = { id: 42 };
    logger.stream('app').info('one', callerAttrs);
    logger.stream('app').info('two', callerAttrs); // reuse the same object
    await flush();

    // The caller's object must be untouched by enrichment middleware...
    expect(callerAttrs).toEqual({ id: 42 });
    expect(callerAttrs).not.toHaveProperty('sessionId');
    // ...while the delivered records ARE enriched, independently.
    expect(sink.records[0].attributes).toMatchObject({ id: 42, sessionId: 'S1' });
    expect(sink.records[0].attributes).not.toBe(sink.records[1].attributes);
  });

  it('lets middleware replace the record via next(record)', async () => {
    const sink = captureSink();
    const logger = new Logger({
      streams: { app: { level: 'info', sinks: [sink] } },
      middleware: [(r) => next({ ...r, message: r.message.toUpperCase() })],
    });

    logger.stream('app').info('hello');
    await flush();

    expect(sink.records[0].message).toBe('HELLO');
  });
});

describe('Logger ordering', () => {
  it('delivers records in the order they were logged', async () => {
    const sink = captureSink();
    const logger = new Logger({ streams: { app: { level: 'info', sinks: [sink] } } });

    for (let i = 0; i < 10; i++) logger.stream('app').info(`m${i}`, { seq: i });
    await flush();

    expect(sink.records.map((r) => r.attributes.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});
