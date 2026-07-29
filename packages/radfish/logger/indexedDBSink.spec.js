// @vitest-environment node
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { createIndexedDBSink } from './indexedDBSink.js';

/**
 * Tests for the IndexedDB sink's maxSize budget + eviction.
 *
 * `fake-indexeddb/auto` installs an in-memory IndexedDB on globalThis, so the
 * real sink runs end-to-end with no mocking. Each test uses a unique dbName so
 * fake-indexeddb state can't leak across tests.
 */

const enc = new TextEncoder();
// Mirror the sink's accounting: serialized size of the record WITHOUT `_id`.
const accountedBytes = (records) =>
  records.reduce((sum, r) => {
    const { _id, ...rest } = r;
    return sum + enc.encode(JSON.stringify(rest)).length;
  }, 0);

let dbCounter = 0;
const uniqueDbName = (label) => `${label}-${Date.now()}-${++dbCounter}`;

const makeRecord = (seq) => ({
  timestamp: 1000 + seq,
  stream: 'app',
  level: 'info',
  message: 'catch report submitted',
  attributes: { seq, vessel: 'F/V Example' },
});

const writeSeq = async (sink, count, startAt = 0) => {
  for (let i = 0; i < count; i++) await sink.write(makeRecord(startAt + i));
};

describe('indexedDBSink maxSize eviction', () => {
  it('keeps everything while under budget', async () => {
    const sink = createIndexedDBSink({ dbName: uniqueDbName('under'), maxSize: '1MB' });
    await writeSeq(sink, 10);
    const stored = await sink.loadLogs();
    expect(stored).toHaveLength(10);
  });

  it('evicts oldest-first and keeps the newest once over budget', async () => {
    const sink = createIndexedDBSink({ dbName: uniqueDbName('evict'), maxSize: '1KB' });
    await writeSeq(sink, 50); // well past 1KB
    const stored = await sink.loadLogs();
    const seqs = stored.map((r) => r.attributes.seq).sort((a, b) => a - b);

    expect(stored.length).toBeLessThan(50); // some were evicted
    expect(seqs).not.toContain(0); // oldest gone
    expect(seqs).toContain(49); // newest kept
  });

  it('keeps a contiguous most-recent window (strict FIFO, no middle drops)', async () => {
    const sink = createIndexedDBSink({ dbName: uniqueDbName('fifo'), maxSize: '1KB' });
    await writeSeq(sink, 50);
    const seqs = (await sink.loadLogs()).map((r) => r.attributes.seq).sort((a, b) => a - b);

    const lo = seqs[0];
    const hi = seqs[seqs.length - 1];
    expect(hi).toBe(49); // window ends at the newest
    expect(seqs).toHaveLength(hi - lo + 1); // no gaps -> contiguous
  });

  it('stays within the budget', async () => {
    const sink = createIndexedDBSink({ dbName: uniqueDbName('budget'), maxSize: '1KB' });
    await writeSeq(sink, 50);
    const stored = await sink.loadLogs();
    expect(accountedBytes(stored)).toBeLessThanOrEqual(1024);
  });

  it('always keeps at least the newest record, even if it alone exceeds the budget', async () => {
    const sink = createIndexedDBSink({ dbName: uniqueDbName('tiny'), maxSize: 30 }); // bytes
    await writeSeq(sink, 5); // every record is larger than 30 bytes
    const stored = await sink.loadLogs();
    expect(stored).toHaveLength(1);
    expect(stored[0].attributes.seq).toBe(4); // the most recent one
  });

  it('re-trims correctly after clearLogs() (counter resets)', async () => {
    const sink = createIndexedDBSink({ dbName: uniqueDbName('clear'), maxSize: '1KB' });
    await writeSeq(sink, 50);
    await sink.clearLogs();
    expect(await sink.loadLogs()).toHaveLength(0);

    await writeSeq(sink, 50, 100); // refill past budget again
    const stored = await sink.loadLogs();
    expect(stored.length).toBeGreaterThan(0);
    expect(accountedBytes(stored)).toBeLessThanOrEqual(1024);
    expect(stored.map((r) => r.attributes.seq)).toContain(149); // newest of the refill
  });

  it('seeds its byte counter from existing on-disk data (new sink, same db)', async () => {
    const dbName = uniqueDbName('seed');
    const first = createIndexedDBSink({ dbName, maxSize: '1MB' });
    await writeSeq(first, 20);

    // A fresh sink instance over the same database must account for the 20
    // records already on disk, not start from zero.
    const second = createIndexedDBSink({ dbName, maxSize: '1MB' });
    await writeSeq(second, 20, 20);

    expect(await second.loadLogs()).toHaveLength(40);
  });
});

describe('indexedDBSink maxSize parsing/validation', () => {
  it.each(['5MB', '500 kb', '1.5gb', '2KB', 4096, 1])(
    'accepts a valid maxSize: %s',
    (value) => {
      expect(() => createIndexedDBSink({ dbName: uniqueDbName('ok'), maxSize: value })).not.toThrow();
    },
  );

  it.each(['.', '-5', '0', 'abc', '', 0, -100, NaN, Infinity])(
    'rejects an invalid maxSize: %s',
    (value) => {
      expect(() => createIndexedDBSink({ dbName: uniqueDbName('bad'), maxSize: value })).toThrow(/maxSize/);
    },
  );
});
