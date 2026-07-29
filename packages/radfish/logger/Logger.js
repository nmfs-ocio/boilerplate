/**
 * Logger.js — a small browser logging module (prototype).
 *
 * Middleware contract uses a **return-based** signature instead of
 * Express-style `next()` callbacks. Every middleware MUST return one of the
 * action objects below, which makes the "forgot to call next()" footgun
 * impossible — JSDoc/TS + `noImplicitReturns` will flag any code path that
 * forgets to return.
 *
 * Use the exported helpers (`next`, `drop`, `forwardError`, `recover`,
 * `rethrow`, `handled`) instead of building action objects by hand.
 *
 * NOTE: Prototype for usability testing. Internals are intentionally minimal.
 */

// =============================================================================
// Type definitions (JSDoc — surfaces in editor hovers without a build step)
// =============================================================================

/**
 * @typedef {'debug'|'info'|'warn'|'error'} LogLevel
 */

/**
 * @typedef {Object} LogRecord
 * @property {number} timestamp
 * @property {string} stream
 * @property {LogLevel} level
 * @property {string} message
 * @property {Record<string, unknown>} attributes
 */

/**
 * Result returned by a normal middleware. Use the helpers below.
 * @typedef {{ action: 'next', record?: LogRecord }
 *         | { action: 'drop', reason?: string }
 *         | { action: 'error', err: unknown }} MiddlewareResult
 */

/**
 * Result returned by an error middleware. Use the helpers below.
 * @typedef {{ action: 'next' }
 *         | { action: 'rethrow', err?: unknown }
 *         | { action: 'handled' }} ErrorMiddlewareResult
 */

/**
 * @callback Middleware
 * @param {LogRecord} record
 * @returns {MiddlewareResult | Promise<MiddlewareResult>}
 */

/**
 * @callback ErrorMiddleware
 * @param {unknown} err
 * @param {LogRecord} record
 * @returns {ErrorMiddlewareResult | Promise<ErrorMiddlewareResult>}
 */

// =============================================================================
// Action helpers — return these from middleware
// =============================================================================

/** Continue the pipeline. Optionally replace the record. */
export const next         = (record) => ({ action: 'next', record });
/** Stop the pipeline; record is discarded. */
export const drop         = (reason) => ({ action: 'drop', reason });
/** Divert into the error pipeline. */
export const forwardError = (err)    => ({ action: 'error', err });

/** From an error middleware: recover and resume the normal pipeline. */
export const recover = ()    => ({ action: 'next' });
/** From an error middleware: pass to the next error middleware. */
export const rethrow = (err) => ({ action: 'rethrow', err });
/** From an error middleware: terminate; error is considered handled. */
export const handled = ()    => ({ action: 'handled' });

// =============================================================================
// Logger
// =============================================================================

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

class StreamHandle {
  constructor(logger, name) {
    this._logger = logger;
    this._name = name;
  }
  debug(msg, attrs) { this._logger._write(this._name, 'debug', msg, attrs); }
  info(msg, attrs)  { this._logger._write(this._name, 'info',  msg, attrs); }
  warn(msg, attrs)  { this._logger._write(this._name, 'warn',  msg, attrs); }
  error(msg, attrs) { this._logger._write(this._name, 'error', msg, attrs); }
  setLevel(level)   { this._logger._streams.get(this._name).level = level; }
  enable()  { this._logger._streams.get(this._name).enabled = true;  this._logger._emit('stream:enabled',  { name: this._name }); }
  disable() { this._logger._streams.get(this._name).enabled = false; this._logger._emit('stream:disabled', { name: this._name }); }
  isEnabled() { return this._logger._streams.get(this._name).enabled; }
}

export class Logger {
  constructor(config = {}) {
    this._streams = new Map();
    /** @type {Middleware[]} */
    this._middleware = [];
    /** @type {ErrorMiddleware[]} */
    this._errorMiddleware = [];
    this._listeners = new Map();
    this._queue = [];
    this._draining = false;
    this._unhandledCount = 0;

    for (const [name, def] of Object.entries(config.streams || {})) {
      this.createStream(name, def);
    }
    for (const mw of config.middleware || []) {
      if (typeof mw === 'function') this.use(mw);
    }
    this.flags = config.flags || {};
  }

  createStream(name, def, { overwrite = false } = {}) {
    if (this._streams.has(name) && !overwrite) {
      throw new Error(`Stream "${name}" already exists`);
    }
    this._streams.set(name, {
      name,
      level: def.level || 'info',
      sinks: (def.sinks || []).map(resolveSink),
      retention: def.retention || {},
      enabled: true,
    });
    this._emit('stream:created', { name });
    return this.stream(name);
  }

  removeStream(name, { purge = false } = {}) {
    const s = this._streams.get(name);
    if (!s) return;
    // BUGFIX (silent log loss): don't yank a stream out from under records that
    // are still queued (or mid-drain) for it — that used to discard them with
    // no error. Defer the removal until the queue is drained so those records
    // are delivered first. New writes are blocked immediately via `enabled`.
    const hasQueued = this._queue.some((r) => r.stream === name);
    if (hasQueued || this._draining) {
      s.enabled = false;
      s._pendingRemoval = { purge };
      return;
    }
    this._finalizeRemoval(name, purge);
  }

  _finalizeRemoval(name, purge) {
    const s = this._streams.get(name);
    if (!s) return;
    s.sinks.forEach((sink) => sink.close && sink.close({ purge }));
    this._streams.delete(name);
    this._emit('stream:removed', { name, purged: purge });
  }

  stream(name) {
    if (!this._streams.has(name)) throw new Error(`Unknown stream "${name}"`);
    return new StreamHandle(this, name);
  }

  listStreams() { return [...this._streams.keys()]; }

  /** @param {Middleware} fn */
  use(fn)      { this._middleware.push(fn); }

  /** @param {ErrorMiddleware} fn */
  useError(fn) { this._errorMiddleware.push(fn); }

  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event).push(fn);
  }

  _emit(event, payload) {
    (this._listeners.get(event) || []).forEach((fn) => fn(payload));
  }

  /**
   * Emits `error:unhandled` and falls back to `console.error` if no listener
   * is registered. Logger health should be observable even when the app
   * forgets to wire up a handler — a silent logger is worse than a chatty one.
   */
  _emitUnhandled(payload) {
    this._unhandledCount++;
    const userListeners = (this._listeners.get('error:unhandled') || []).length;
    this._emit('error:unhandled', payload);
    if (userListeners === 0) {
      console.error('[logger] unhandled', payload);
    }
  }

  getUnhandledCount() { return this._unhandledCount; }

  _write(stream, level, message, attributes = {}) {
    const def = this._streams.get(stream);
    if (!def || !def.enabled) return;
    if (LEVELS[level] < LEVELS[def.level]) return;

    const record = {
      timestamp: Date.now(),
      stream,
      level,
      message,
      // Shallow-clone so middleware that enriches the record (e.g.
      // `record.attributes.sessionId = ...`) can't mutate the caller's object
      // or leak across records when an attrs object is reused/memoized.
      attributes: { ...attributes },
    };
    this._queue.push(record);
    this._drain();
  }

  async _drain() {
    if (this._draining) return;
    this._draining = true;
    try {
      // Records enqueue in timestamp order already (timestamp is stamped at
      // call time, and Date.now() is non-decreasing), so one sort up front is
      // enough — re-sorting the whole queue on every shift was O(n²·log n).
      this._queue.sort((a, b) => a.timestamp - b.timestamp);
      while (this._queue.length) {
        const record = this._queue.shift();
        await this._runPipeline(record);
      }
      // Queue is empty — now it's safe to finalize any stream whose removal was
      // deferred, so its queued records were delivered before it disappeared.
      for (const [name, def] of [...this._streams]) {
        if (def._pendingRemoval) this._finalizeRemoval(name, def._pendingRemoval.purge);
      }
    } finally {
      this._draining = false;
    }
  }

  async _runPipeline(record) {
    let current = record;
    for (const mw of this._middleware) {
      let result;
      try {
        result = await mw(current);
      } catch (err) {
        return this._runErrorPipeline(err, current);
      }
      if (!result || typeof result.action !== 'string') {
        return this._runErrorPipeline(
          new Error(`Middleware returned ${result === undefined ? 'undefined' : 'invalid value'} — every middleware must return next(), drop(), or forwardError()`),
          current,
          { source: 'middleware-invalid-return' },
        );
      }
      switch (result.action) {
        case 'next':  current = result.record || current; break;
        case 'drop':  this._emit('record:dropped', { stream: current.stream, reason: result.reason }); return;
        case 'error': return this._runErrorPipeline(result.err, current, { source: 'forwarded' });
        default:      return this._runErrorPipeline(new Error(`Unknown action "${result.action}"`), current, { source: 'middleware-invalid-return' });
      }
    }
    await this._dispatchToSinks(current);
  }

  async _runErrorPipeline(err, record, meta = {}) {
    let currentErr = err;
    const originalErr = err;
    for (const mw of this._errorMiddleware) {
      let result;
      try {
        result = await mw(currentErr, record);
      } catch (thrown) {
        this._emitUnhandled({
          record,
          err: thrown,
          originalErr,
          source: 'error-middleware-threw',
        });
        return;
      }
      if (!result || typeof result.action !== 'string') {
        this._emitUnhandled({
          record,
          err: new Error('Error middleware returned invalid value — use recover(), rethrow(), or handled()'),
          originalErr,
          source: 'error-middleware-invalid-return',
        });
        return;
      }
      switch (result.action) {
        case 'next':    return this._dispatchToSinks(record);
        case 'rethrow': currentErr = result.err || currentErr; continue;
        case 'handled': return;
      }
    }
    this._emitUnhandled({ record, err: currentErr, originalErr, source: meta.source || 'no-handler' });
  }

  async _dispatchToSinks(record) {
    const def = this._streams.get(record.stream);
    if (!def) {
      // Backstop: with the deferred-removal fix above this should not happen,
      // but if a record ever arrives with no stream, never drop it silently.
      this._emit('record:dropped', {
        stream: record.stream,
        reason: 'stream was removed before the record could be delivered',
      });
      return;
    }
    for (const sink of def.sinks) {
      try { await sink.write(record); }
      catch (e) { this._emit('record:dropped', { stream: record.stream, reason: e.message }); }
    }
  }
}

function resolveSink(sinkOrConfig) {
  if (typeof sinkOrConfig.write === 'function') return sinkOrConfig;
  switch (sinkOrConfig.type) {
    case 'console':
      return { write: (r) => console[r.level === 'debug' ? 'log' : r.level](r) };
    case 'indexedDB':
      return { write: async (_r) => { /* stub */ }, close: () => {} };
    default:
      throw new Error(`Unknown sink type "${sinkOrConfig.type}"`);
  }
}
