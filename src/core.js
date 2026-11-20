import { appendFile } from 'node:fs/promises';

/**
 * Serializes appends to a single file path so concurrent writers never
 * interleave bytes within a line.
 *
 * Why a per-path promise chain instead of a lock file or a mutex library:
 * Node's event loop already gives us a single-threaded coordination point.
 * A promise chain is enough to guarantee ordering without any third-party
 * dependency, and it degrades gracefully when callers forget to await.
 * The trade-off is that the queue is in-process only: two separate Node
 * processes appending to the same path are NOT serialized by this class.
 */
export class AppendQueue {
  /**
   * @param {string} filePath - The file every queued write targets.
   * @param {object} [options]
   * @param {string} [options.encoding='utf8'] - Passed to appendFile.
   * @param {(path: string, data: string|Uint8Array, encoding: string) => Promise<void>} [options.writer]
   *   Injectable writer used by tests to observe call order without touching
   *   the filesystem. Defaults to fs/promises.appendFile.
   */
  constructor(filePath, options = {}) {
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new TypeError('filePath must be a non-empty string');
    }
    this.filePath = filePath;
    this.encoding = options.encoding ?? 'utf8';
    this.writer = options.writer ?? appendFile;

    // Tail of the promise chain. Every enqueue extends it. Starts resolved so
    // the first enqueue runs immediately rather than waiting on a fake tick.
    this._tail = Promise.resolve();
  }

  /**
   * Append one line to the file, serialized against every other append on
   * this queue instance.
   *
   * The newline is added here rather than left to the caller so that line
   * integrity is the queue's responsibility, not a convention callers can
   * forget. Data containing embedded newlines is allowed; it simply occupies
   * more than one line in the file, which matches how appendFile behaves.
   *
   * @param {string|Uint8Array} line
   * @returns {Promise<void>} resolves once this line is on disk.
   */
  appendLine(line) {
    if (typeof line !== 'string' && !(line instanceof Uint8Array)) {
      throw new TypeError('line must be a string or Uint8Array');
    }
    const payload =
      typeof line === 'string' ? line + '\n' : concatNewline(line);
    return this._enqueue(payload);
  }

  /**
   * Append raw bytes with no newline added. Exposed for callers that manage
   * their own framing, but note that two concurrent appendRaw calls can still
   * land in either order; only their bytes are guaranteed not to interleave.
   *
   * @param {string|Uint8Array} data
   * @returns {Promise<void>}
   */
  appendRaw(data) {
    if (typeof data !== 'string' && !(data instanceof Uint8Array)) {
      throw new TypeError('data must be a string or Uint8Array');
    }
    return this._enqueue(data);
  }

  /**
   * Wait until every append enqueued so far has settled. Useful before
   * reading the file back in a test or at shutdown.
   *
   * @returns {Promise<void>}
   */
  drain() {
    return this._tail;
  }

  /**
   * Chain a write onto the tail. The returned promise rejects if the write
   * rejects, but the chain itself is kept alive by catching the rejection
   * before it becomes the new tail, so one failed write does not poison
   * every subsequent append.
   *
   * @param {string|Uint8Array} payload
   * @returns {Promise<void>}
   */
  _enqueue(payload) {
    const run = this._tail.then(() =>
      this.writer(this.filePath, payload, this.encoding),
    );
    // Keep the chain alive on failure; surface the error to the caller only.
    this._tail = run.catch(() => {});
    return run;
  }
}

/**
 * Copy a Uint8Array and append a single newline byte. Copying keeps the
 * caller's buffer untouched, which matters because appendFile may hold a
 * reference to the data until the write completes.
 *
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
function concatNewline(bytes) {
  const out = new Uint8Array(bytes.length + 1);
  out.set(bytes, 0);
  out[bytes.length] = 0x0a;
  return out;
}
