export type DataErrorCode = 'INVALID_INPUT' | 'NOT_FOUND' | 'NETWORK' | 'TIMEOUT' | 'RATE_LIMITED' | 'UPSTREAM' | 'INVALID_RESPONSE' | 'UNAVAILABLE' | 'STORAGE';

export class DataError extends Error {
  constructor(public readonly code: DataErrorCode, message: string, public readonly retryable = false) {
    super(message);
    this.name = 'DataError';
  }
}

export interface DataWarning { code: DataErrorCode | 'CACHED' | 'PARTIAL'; operation: string; message: string; at: number }

interface Cached { value: unknown; expires: number; bytes: number }
interface Flight { value: Promise<unknown>; controller: AbortController; readers: number; done: boolean }
interface HttpOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  patientTimeoutMs?: number;
  intervalMs?: number;
  retries?: number;
  maxConcurrent?: number;
  /** How many requests may start together after a quiet spell. */
  burst?: number;
  maxEntries?: number;
  maxBytes?: number;
}
const wait = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason) };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
});
const MAX_BODY = 8 * 1024 * 1024;
const ALLOWED_HOSTS = new Set(['m.douban.com', 'movie.douban.com', 'www.douban.com', 'top.baidu.com']);

/** All requests are main-process only. A success is cached only after endpoint validation. */
export class DoubanHttp {
  private cache = new Map<string, Cached>();
  private flights = new Map<string, Flight>();
  private bytes = 0;
  private active = 0;
  private queue: Array<() => void> = [];
  private nextStart = 0;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly patientTimeoutMs: number;
  private readonly intervalMs: number;
  private readonly maxConcurrent: number;
  private readonly burst: number;
  private readonly retries: number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;

  constructor(options: HttpOptions = {}) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 8500;
    this.patientTimeoutMs = options.patientTimeoutMs ?? 20000;
    this.intervalMs = options.intervalMs ?? 180;
    this.maxConcurrent = options.maxConcurrent ?? 4;
    this.burst = Math.max(1, options.burst ?? 4);
    this.retries = options.retries ?? 1;
    this.maxEntries = options.maxEntries ?? 256;
    this.maxBytes = options.maxBytes ?? 24 * 1024 * 1024;
  }

  /**
   * `patient` is for listings Douban computes on demand: one long wait instead of two short
   * ones, because a request that is abandoned and repeated starts the computation again.
   */
  async json<T>(url: string, ttlMs: number, validate: (value: unknown) => T, patient = false, emptyTtlMs = ttlMs, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.has(parsed.hostname) || parsed.username || parsed.password) {
      throw new DataError('INVALID_INPUT', 'Unapproved metadata origin');
    }
    const cached = this.cache.get(url);
    if (cached && cached.expires > Date.now()) {
      this.cache.delete(url);
      this.cache.set(url, cached);
      return validate(structuredClone(cached.value));
    }
    if (cached) this.remove(url);
    let flight = this.flights.get(url);
    if (!flight || flight.controller.signal.aborted) {
    const created: Flight = { value: Promise.resolve(undefined), controller: new AbortController(), readers: 0, done: false };
    const work = this.request(parsed, patient, created.controller.signal).then(value => {
      created.controller.signal.throwIfAborted();
      const validated = validate(value);
      const bytes = Buffer.byteLength(JSON.stringify(value));
      const effectiveTtl = Array.isArray(validated) && !validated.length ? emptyTtlMs : ttlMs;
      if (bytes <= this.maxBytes && effectiveTtl > 0) {
        this.cache.set(url, { value, expires: Date.now() + effectiveTtl, bytes });
        this.bytes += bytes;
        while (this.cache.size > this.maxEntries || this.bytes > this.maxBytes) this.remove(this.cache.keys().next().value!);
      }
      return value;
    }).finally(() => { created.done = true; if (this.flights.get(url) === created) this.flights.delete(url); });
    created.value = work;
    this.flights.set(url, created);
    flight = created;
    }
    flight.readers++;
    try { return validate(structuredClone(await this.consume(flight.value, signal))); }
    finally { if (--flight.readers === 0 && !flight.done) flight.controller.abort(); }
  }

  private consume(value: Promise<unknown>, signal?: AbortSignal): Promise<unknown> {
    if (!signal) return value;
    return new Promise((resolve, reject) => {
      const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
      signal.addEventListener('abort', abort, { once: true });
      value.then(next => { signal.removeEventListener('abort', abort); resolve(next); }, error => { signal.removeEventListener('abort', abort); reject(error); });
      if (signal.aborted) abort();
    });
  }

  clear() { this.cache.clear(); this.bytes = 0; }

  private remove(key: string) {
    const value = this.cache.get(key);
    if (value) this.bytes -= value.bytes;
    this.cache.delete(key);
  }

  private async acquire(signal: AbortSignal) {
    let owned = false;
    try {
    signal.throwIfAborted();
    if (this.active >= this.maxConcurrent) {
      if (this.queue.length >= 64) throw new DataError('RATE_LIMITED', 'Metadata request queue is full', true);
      await new Promise<void>((resolve, reject) => {
        const ready = () => { signal.removeEventListener('abort', abort); owned = true; resolve(); };
        const abort = () => { signal.removeEventListener('abort', abort); const index = this.queue.indexOf(ready); if (index >= 0) this.queue.splice(index, 1); reject(signal.reason); };
        this.queue.push(ready); signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    } else { this.active++; owned = true; }
    signal.throwIfAborted();
    // Starts are paced at one per interval on average. After a quiet spell up to `burst` of
    // them leave together: a page made of several requests (home: ten) otherwise spends most
    // of its loading time waiting for its turn, not for Douban.
    // Reserve the next slot synchronously before yielding, including queued requests.
    const now = Date.now();
    const start = Math.max(now, this.nextStart - (this.burst - 1) * this.intervalMs);
    this.nextStart = Math.max(now, this.nextStart) + this.intervalMs;
    if (start > now) await wait(start - now, signal);
    } catch (error) { if (owned) this.release(); throw error; }
  }

  private release() {
    const next = this.queue.shift();
    if (next) next(); else this.active--;
  }

  private async request(initial: URL, patient: boolean, cancellation: AbortSignal): Promise<unknown> {
    let last: DataError = new DataError('NETWORK', 'Metadata request failed', true);
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      await this.acquire(cancellation);
      let retryDelay = 250 + Math.floor(Math.random() * 200);
      try {
        let url = initial;
        const signal = AbortSignal.any([cancellation, AbortSignal.timeout(patient ? this.patientTimeoutMs : this.timeoutMs)]);
        let response: Response | undefined;
        for (let redirect = 0; redirect <= 3; redirect++) {
          response = await this.fetcher(url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
              Referer: `${url.origin}/`, Accept: 'application/json',
            }, signal, redirect: 'manual',
          });
          if (![301, 302, 303, 307, 308].includes(response.status)) break;
          const location = response.headers.get('location');
          await response.body?.cancel();
          if (!location) throw new DataError('INVALID_RESPONSE', 'Missing redirect target');
          url = new URL(location, url);
          if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname) || url.username || url.password || redirect === 3) {
            throw new DataError('UPSTREAM', 'Metadata redirect rejected');
          }
        }
        if (!response) throw new DataError('NETWORK', 'Metadata response missing', true);
        if (!response.ok) {
          const status = response.status;
          const after = Number(response.headers.get('retry-after'));
          if (Number.isFinite(after) && after > 0) retryDelay = Math.min(2000, after * 1000);
          await response.body?.cancel();
          throw new DataError(status === 429 ? 'RATE_LIMITED' : status === 404 ? 'NOT_FOUND' : 'UPSTREAM', `Metadata HTTP ${status}`, status === 429 || status >= 500);
        }
        const declared = Number(response.headers.get('content-length'));
        if (declared > MAX_BODY) { await response.body?.cancel(); throw new DataError('INVALID_RESPONSE', 'Metadata body too large'); }
        const chunks: Uint8Array[] = [];
        let size = 0;
        const reader = response.body?.getReader();
        if (!reader) throw new DataError('INVALID_RESPONSE', 'Empty metadata response');
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_BODY) { await reader.cancel(); throw new DataError('INVALID_RESPONSE', 'Metadata body too large'); }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
        try {
          const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!value || typeof value !== 'object') throw new Error('object required');
          return value;
        } catch { throw new DataError('INVALID_RESPONSE', 'Metadata returned invalid JSON'); }
      } catch (error) {
        if (cancellation.aborted) throw cancellation.reason;
        last = error instanceof DataError ? error : new DataError(
          error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError') ? 'TIMEOUT' : 'NETWORK',
          error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError') ? 'Metadata request timed out' : 'Metadata network unavailable', true,
        );
      } finally { this.release(); }
      if (!last.retryable || attempt === this.retries || (patient && last.code === 'TIMEOUT')) throw last;
      await wait(retryDelay, cancellation);
    }
    throw last;
  }
}
