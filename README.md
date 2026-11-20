# tiny-file-append-queue

Serializes concurrent `appendFile` calls to the same path so writes never interleave and every line lands intact.

```js
import { AppendQueue } from 'tiny-file-append-queue';

const queue = new AppendQueue('./events.log');

// Fire many appends without awaiting each one; the queue keeps them ordered.
await Promise.all(
  ['started', 'tick', 'finished'].map((line) => queue.appendLine(line)),
);

// Wait for everything enqueued so far to hit disk.
await queue.drain();
```

The file `./events.log` now contains exactly:

```
started
tick
finished
```

## Why this exists

`fs.appendFile` is atomic at the syscall level for small writes, but once you
have several `await`ed appends in flight from the same process, the order in
which their promises resolve is not the order in which they were issued. Under
load you get lines from different logical records spliced together. A mutex
library or a lock file would fix that, but both drag in dependencies or leave
stale lock files behind on crash.

This library takes the simplest coordination point Node gives you: a promise
chain. Each append extends the chain, so writes run strictly one after another
in enqueue order. The trade-off is scope. The queue is **in-process only**: two
separate Node processes appending to the same path are not serialized by this
class. If you need cross-process ordering, you need a real lock or a database.
For the common case of one server process fanning out concurrent appends, the
promise chain is enough and costs nothing.

## API

### `new AppendQueue(filePath, options?)`

- `filePath` — non-empty string, required. Throws `TypeError` otherwise.
- `options.encoding` — passed to the writer; defaults to `'utf8'`.
- `options.writer` — injectable `(path, data, encoding) => Promise<void>`. Defaults to `fs/promises.appendFile`. Used by tests to observe call order without touching the filesystem.

### `queue.appendLine(line)`

Appends `line` plus a trailing `\n`. Accepts a `string` or a `Uint8Array`.
For a `Uint8Array`, a single `0x0a` byte is appended and the caller's buffer is
left untouched. Returns a promise that resolves when this line is on disk.

### `queue.appendRaw(data)`

Appends `data` with no newline added. Same accepted types. Useful when you
frame your own records. Note that two concurrent `appendRaw` calls may land in
either order; only their bytes are guaranteed not to interleave.

### `queue.drain()`

Resolves once every append enqueued so far has settled, including failed ones.

## The awkward edge

A rejected write rejects the promise returned by `appendLine` or `appendRaw`,
but it does **not** poison the queue. The chain catches the rejection before it
becomes the new tail, so the next append still runs. If you fire-and-forget
appends, attach a `.catch()` or the rejection is unhandled — `drain()` will
still resolve, but Node will report the unhandled rejection.
