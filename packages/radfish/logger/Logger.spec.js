import { describe, it, expect, vi } from 'vitest';
import { Logger, next, drop, forwardError, recover } from './Logger.js';

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

describe('Logger error middleware (recover() must not bypass later middleware)', () => {
  it('recover() resumes the normal pipeline so downstream redaction still runs', async () => {
    const sink = captureSink();
    const logger = new Logger({
      streams: { app: { level: 'info', sinks: [sink] } },
      middleware: [
        () => { throw new Error('enrich failed'); },                              // #1 throws
        (r) => next({ ...r, message: r.message.replace('secret', '[REDACTED]') }), // #2 redacts
      ],
    });
    logger.useError(() => recover());

    logger.stream('app').info('my secret token');
    await flush();

    // redaction (mw #2) must still run even though mw #1 threw and was recovered
    expect(sink.records.map((r) => r.message)).toEqual(['my [REDACTED] token']);
  });

  it('recover() from a forwarded error also resumes after the forwarding middleware', async () => {
    const sink = captureSink();
    const logger = new Logger({
      streams: { app: { level: 'info', sinks: [sink] } },
      middleware: [
        (r) => forwardError(new Error('boom')),                                    // #1 forwards
        (r) => next({ ...r, message: r.message.replace('secret', '[REDACTED]') }), // #2 redacts
      ],
    });
    logger.useError(() => recover());

    logger.stream('app').info('my secret token');
    await flush();

    expect(sink.records.map((r) => r.message)).toEqual(['my [REDACTED] token']);
  });
});

describe('Logger level validation (unknown level must not disable filtering)', () => {
  it('coerces an unknown configured level to "info" so filtering still works', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sink = captureSink();
    const logger = new Logger({ streams: { app: { level: 'verbose', sinks: [sink] } } });

    logger.stream('app').debug('should be filtered'); // below info -> dropped
    logger.stream('app').info('kept');
    await flush();

    expect(sink.records.map((r) => r.message)).toEqual(['kept']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('setLevel() with an unknown level falls back to "info"', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sink = captureSink();
    const logger = new Logger({ streams: { app: { level: 'error', sinks: [sink] } } });

    logger.stream('app').setLevel('Info'); // wrong case -> coerced to 'info'
    logger.stream('app').debug('filtered');
    logger.stream('app').info('kept');
    await flush();

    expect(sink.records.map((r) => r.message)).toEqual(['kept']);
    warn.mockRestore();
  });
});

describe('resolveSink ({ type: "indexedDB" } must fail loudly, not drop records)', () => {
  it('throws instead of returning a silent no-op for { type: "indexedDB" }', () => {
    expect(() => new Logger({ streams: { app: { sinks: [{ type: 'indexedDB' }] } } }))
      .toThrow(/logger\.indexedDB/);
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
