import test from 'node:test';
import assert from 'node:assert/strict';
import { AppendQueue } from '../src/index.js';

/**
 * Build a queue whose writer records calls instead of touching the disk, so
 * tests are deterministic and never depend on filesystem timing.
 */
function recordingQueue() {
  const calls = [];
  const queue = new AppendQueue('/tmp/ignored.log', {
    writer: async (path, data, encoding) => {
      // Yield to the microtask queue so overlapping enqueues would interleave
      // if the implementation were broken.
      await Promise.resolve();
      calls.push({ path, data, encoding });
    },
  });
  return { queue, calls };
}

test('appendLine writes a trailing newline', async () => {
  const { queue, calls } = recordingQueue();
  await queue.appendLine('hello');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].data, 'hello\n');
  assert.equal(calls[0].path, '/tmp/ignored.log');
  assert.equal(calls[0].encoding, 'utf8');
});

test('concurrent appendLine calls never interleave', async () => {
  const { queue, calls } = recordingQueue();
  const lines = ['a', 'b', 'c', 'd', 'e'];
  await Promise.all(lines.map((line) => queue.appendLine(line)));
  assert.equal(calls.length, lines.length);
  assert.deepEqual(
    calls.map((c) => c.data),
    lines.map((line) => line + '\n'),
  );
});

test('appendLine preserves enqueue order even when writes resolve out of order', async () => {
  const order = [];
  const queue = new AppendQueue('/tmp/order.log', {
    writer: async (_path, data) => {
      // First write is slow, second is fast. Serialization must still keep
      // the log in enqueue order.
      const delay = data === 'first\n' ? 5 : 0;
      await new Promise((resolve) => setTimeout(resolve, delay));
      order.push(data);
    },
  });
  const p1 = queue.appendLine('first');
  const p2 = queue.appendLine('second');
  await Promise.all([p1, p2]);
  assert.deepEqual(order, ['first\n', 'second\n']);
});

test('appendRaw does not add a newline', async () => {
  const { queue, calls } = recordingQueue();
  await queue.appendRaw('raw');
  assert.equal(calls[0].data, 'raw');
});

test('appendLine accepts Uint8Array and appends a newline byte', async () => {
  const { queue, calls } = recordingQueue();
  const input = new Uint8Array([0x68, 0x69]); // "hi"
  await queue.appendLine(input);
  assert.ok(calls[0].data instanceof Uint8Array);
  assert.deepEqual(Array.from(calls[0].data), [0x68, 0x69, 0x0a]);
  // The caller's buffer must be untouched.
  assert.deepEqual(Array.from(input), [0x68, 0x69]);
});

test('a failed write rejects its caller but does not poison later writes', async () => {
  const seen = [];
  let failNext = true;
  const queue = new AppendQueue('/tmp/flaky.log', {
    writer: async (_path, data) => {
      if (failNext) {
        failNext = false;
        throw new Error('disk full');
      }
      seen.push(data);
    },
  });
  await assert.rejects(() => queue.appendLine('boom'), /disk full/);
  await queue.appendLine('recovered');
  assert.deepEqual(seen, ['recovered\n']);
});

test('drain resolves after all enqueued writes settle', async () => {
  const { queue, calls } = recordingQueue();
  queue.appendLine('one');
  queue.appendLine('two');
  await queue.drain();
  assert.equal(calls.length, 2);
});

test('drain resolves even after a failed write', async () => {
  const queue = new AppendQueue('/tmp/fail.log', {
    writer: async () => {
      throw new Error('nope');
    },
  });
  // Swallow the rejection here; drain must still resolve.
  queue.appendLine('x').catch(() => {});
  await queue.drain();
});

test('constructor rejects an empty path', () => {
  assert.throws(() => new AppendQueue(''), TypeError);
  assert.throws(() => new AppendQueue(), TypeError);
});

test('appendLine rejects non-string, non-bytes input', () => {
  const { queue } = recordingQueue();
  assert.throws(() => queue.appendLine(42), TypeError);
  assert.throws(() => queue.appendLine(null), TypeError);
});

test('appendRaw rejects non-string, non-bytes input', () => {
  const { queue } = recordingQueue();
  assert.throws(() => queue.appendRaw({}), TypeError);
});

test('custom encoding is forwarded to the writer', async () => {
  const calls = [];
  const queue = new AppendQueue('/tmp/enc.log', {
    encoding: 'latin1',
    writer: async (_path, data, encoding) => {
      calls.push({ data, encoding });
    },
  });
  await queue.appendLine('caf\u00e9');
  assert.equal(calls[0].encoding, 'latin1');
});
