<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://github.com/jcubic/mitty/blob/master/.github/logo-dark.svg?raw=true" />
    <source media="(prefers-color-scheme: light)" srcset="https://github.com/jcubic/mitty/blob/master/.github/logo-light.svg?raw=true" />
    <img alt="Mitty Logo" src="https://github.com/jcubic/mitty/blob/master/.github/logo-light.svg?raw=true" height="500"/>
  </picture>
</h1>

<div align="center">

[![npm version](https://img.shields.io/npm/v/@jcubic/mitty.svg)](https://www.npmjs.com/package/@jcubic/mitty)
[![github repo](https://img.shields.io/badge/github-repo-orange?logo=github)](https://github.com/jcubic/mitty)
[![CI](https://github.com/jcubic/mitty/actions/workflows/ci.yml/badge.svg)](https://github.com/jcubic/mitty/actions/workflows/ci.yml)
[![Coverage Status](https://coveralls.io/repos/github/jcubic/mitty/badge.svg)](https://coveralls.io/github/jcubic/mitty)
[![LICENSE MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/jcubic/mitty/blob/master/LICENSE)

</div>

Use objects that only exist on the main thread — DOM nodes, jQuery objects, class
instances with methods, or anything that is inaccessible from inside a Web/Service Worker.

A worker has no DOM, and `postMessage` cannot carry a DOM node, a jQuery object, or
anything else that isn't structured-cloneable. Mitty leaves the real object on the main
thread and puts a proxy in the worker. The proxy records property accesses and calls
without touching the channel; the whole chain is replayed on the main thread when you
await it.

```js
// inside a worker — no DOM here
const $ = require('$');
await $('#list').find('li').first().text(); // one message, not four
```

## Installation

```bash
npm install @jcubic/mitty
```

No install is needed to use it from a CDN. Two builds ship, and which one you get
depends on the URL.

The **bare URL is the ES module**, for `import` in a page or a module worker:

```js
import { connect, Host } from 'https://cdn.jsdelivr.net/npm/@jcubic/mitty';
```

The **`dist/index.global.js` path is the standalone build**, which defines a `Mitty`
global for `importScripts()` and classic `<script>` tags:

```js
importScripts('https://cdn.jsdelivr.net/npm/@jcubic/mitty/dist/index.global.js');

const { require } = Mitty.connect(new BroadcastChannel('my-app'));
```

```html
<script src="https://cdn.jsdelivr.net/npm/@jcubic/mitty/dist/index.global.js"></script>
```

The two cannot share one URL: `importScripts()` only accepts a classic script and
rejects a file containing `export`, while `import` needs those exports. Pin a version
with `@` when you want the URL to stay put, e.g. `@jcubic/mitty@0.1.1`.

## Quick start

### Main thread

```js
import { Host } from '@jcubic/mitty';

const modules = {
  $: () => jQuery,
  term: () => $('.terminal').terminal(),
};

const channel = new BroadcastChannel('my-app');

const host = new Host({
  channel,
  resolve(name) {
    if (Object.hasOwn(modules, name)) {
      return modules[name]();
    }
    return null;
  },
  serialize(value) {
    // a jQuery object wraps DOM nodes and cannot cross the channel —
    // hand out a handle the worker can call methods on instead
    if (value instanceof $.fn.init) {
      return this.remote(value);
    }
    return value;
  },
});

const worker = new Worker('./worker.js');
```

Only the names your `resolve()` answers are reachable. Everything else on the page stays
invisible to the worker.

### Worker

With an `import` statement, in a worker started with `{ type: 'module' }` — from your
bundler, or straight from the CDN:

```js
import { connect } from '@jcubic/mitty';
// or: from 'https://cdn.jsdelivr.net/npm/@jcubic/mitty'

const { require } = connect(new BroadcastChannel('my-app'));

const $ = require('$');
await $('.terminal').terminal().echo('Hello from a worker');
```

Or with `importScripts()`, in a classic worker:

```js
importScripts('https://cdn.jsdelivr.net/npm/@jcubic/mitty/dist/index.global.js');

const { require } = Mitty.connect(new BroadcastChannel('my-app'));
```

#### Blob URL

If the worker itself is created from a `Blob` — which is how you run code generated at
runtime — a URL you pass to `importScripts()` **must be absolute**. A `blob:` URL has an
opaque path, so `'/mitty.js'` and `'./mitty.js'` have nothing to resolve against and are
rejected as invalid. A CDN URL is already absolute and needs nothing else; if you serve
your own copy instead, name it in full:

```js
// in the page, when generating the worker source
const mitty = new URL('/mitty.js', location.href).href;
const source = `importScripts(${JSON.stringify(mitty)}); /* ... */`;
const worker = new Worker(URL.createObjectURL(new Blob([source])));
```

## One channel per worker

Both ends take a channel rather than creating one, so you decide what the two sides talk
over and how many conversations there are. Request ids are per connection and start at 1,
so two workers sharing a channel name will see each other's replies and resolve the wrong
calls. Give every worker its own channel:

```js
let seq = 0;

function spawn(url) {
  const name = `my-app-${++seq}`;
  const host = new Host({ channel: new BroadcastChannel(name), resolve, serialize });
  const worker = new Worker(url);
  worker.postMessage({ channel: name }); // tell the worker which one to join
  return { host, worker };
}
```

A channel is never closed by this library — whoever created it owns it.

## How a chain becomes one message

`$('#list').find('li').first().text()` does not talk to the main thread four times. Each
step appends to a list of operations held in the worker:

```js
[
  { type: 'call', args: ['#list'] },
  { type: 'get', key: 'find' },
  { type: 'call', args: ['li'] },
  // ...
];
```

Nothing is sent until you attach `then`, `catch` or `finally` — usually by awaiting the
chain. That is the point at which the proxy behaves as a promise. The host then walks the
whole list against the resolved module and sends back the final value.

A consequence worth knowing: a chain with nothing recorded yet is not a promise, and a
bare handle is not one either. `require('x')` and an awaited handle are both inert until
you chain something onto them. That is also why a remote method genuinely named `catch`
or `finally` still works — on a bare handle there is nothing to run, so the name is
treated as an ordinary property access rather than a promise method.

### There is no fire-and-forget

Because the message is only sent when you attach `then`/`catch`/`finally`, a call you
never await does **nothing at all** — silently, with no error:

```js
stdout.writeln('hello'); // never sent
await stdout.writeln('hello'); // sent
```

This bites hardest in a helper that wraps remote calls. Await inside it, and the helper
stays convenient to call without `await`, because awaiting internally is what dispatches
the messages:

```js
const console = {
  log: async (...args) => {
    await stdout.writeln(args.join(' '));
    await stdout.flush();
  },
};

console.log('this works'); // the writes still happen
```

## Handles and memory

Anything `serialize()` turns into a handle with `this.remote(value)` is kept alive on the
main thread until it is released. There is no automatic collection — a handle is a plain
integer on the wire, and the host cannot see when the worker drops its proxy.

Release explicitly when you are done:

```js
const list = await $('#list');
// ... use it ...
release(list);
```

If you would rather tie it to garbage collection, a `FinalizationRegistry` can do it —
but the callback must not capture the proxy, or the proxy will never become unreachable
and the callback will never run. Register the numeric id instead, which is what
`handle()` is for:

```js
const client = connect(channel);
const registry = new FinalizationRegistry(id => client.release(id));

function tracked(remote) {
  registry.register(remote, client.handle(remote));
  return remote;
}

const list = tracked(await $('#list'));
// when `list` becomes unreachable, the host is told to drop it
```

Collection timing is not guaranteed, so this is a safety net rather than a replacement
for releasing things you know you are finished with.

## Callbacks

A function passed from the worker stays in the worker. The host receives a stub that
returns a promise; calling it runs the real function back in the worker:

```js
// worker
const result = await require('util').map([1, 2, 3], n => n * 2);
// -> [2, 4, 6], with the doubling done in the worker
```

Arguments are trimmed to the callback's declared arity, because callers like jQuery pass
extras (event objects, indexes) that usually cannot be serialized. Declare the parameters
you actually want.

## Errors

Errors cross the channel with their `name`, `message` and the host's `stack`, and arrive
as real `Error` instances:

```js
try {
  await $('#list').nosuchmethod();
} catch (error) {
  error instanceof Error; // true
  error.message; // "mitty: $().nosuchmethod is not a function"
}
```

`catch()` works directly on a chain too, without awaiting it first:

```js
await $('#list')
  .nosuchmethod()
  .catch(error => report(error));
```

## API

### `new Host(options)`

| option        | type                 | description                                                                                  |
| ------------- | -------------------- | -------------------------------------------------------------------------------------------- |
| `channel`     | `Channel`            | Transport to listen on. Required. Never closed by mitty.                                     |
| `resolve`     | `(name) => unknown`  | Turns a `require()` name into a value. Return `null`/`undefined` for unknown. May be async.  |
| `serialize`   | `(value) => unknown` | Called for every outgoing value. Return `this.remote(value)` for anything JSON cannot carry. |
| `unserialize` | `(value) => unknown` | Called for every incoming value.                                                             |

`serialize` and `unserialize` are called with the host as `this`.

- **`host.remote(value)`** — register `value` and return a handle marker. Call this from
  `serialize()`.
- **`host.release(handle)`** — drop a handle, by marker or by id. Returns `false` if it
  was already gone.
- **`host.close()`** — stop listening and forget every handle.

### `connect(channel)`

Returns a client:

- **`require(name)`** — a proxy rooted at whatever the host's `resolve()` returns.
- **`handle(remote)`** — the numeric id behind a handle proxy.
- **`release(remote)`** — tell the host to drop it, by proxy or by id.
- **`close()`** — stop listening. The channel stays open.

### `Channel`

Any object with these three members works — a `BroadcastChannel`, a `MessagePort`
wrapper, or a stub in tests:

```ts
interface Channel {
  postMessage(message: string): void;
  addEventListener(type: 'message', listener: (event: { data: string }) => void): void;
  removeEventListener(type: 'message', listener: (event: { data: string }) => void): void;
}
```

Messages on the wire are JSON strings, so a channel only has to carry text.

## Limitations

- **Values must survive JSON.** Anything else needs a handle via `serialize()`. Circular
  structures fail the call that would return them.
- **`{ type, data }` is reserved.** Functions, handles and errors travel as objects of
  that exact shape. An application object that looks identical would be mistaken for one.
- **Functions returned from the host are dropped**, as they would be by `JSON.stringify`.
  Expose them through a handle instead.
- **Handles are not garbage collected** — see [Handles and memory](#handles-and-memory).

## Example

A runnable page that drives jQuery from a worker, in both the `importScripts` and
`import` styles, lives in
[`example/`](https://github.com/jcubic/mitty/tree/master/example):

```bash
npm install
npm run build
npx serve .
```

then open `/example/`.

## Development

```bash
npm test          # unit tests
npm run coverage  # tests with coverage
npm run lint      # eslint
npm run build     # ESM + IIFE + .d.ts into dist/
```

## Origin

The first idea for the mechanism was created for [Hacking Cafe](https://hacking.cafe), a Unix-like environment in the browser. It was then extracted into an NPM library. The name and logo were based on a fictional "Life" magazine worker named [Waleter Mitty](https://en.wikipedia.org/wiki/Walter_Mitty) from the movie ["The Secret Life of Walter Mitty"](<https://en.wikipedia.org/wiki/The_Secret_Life_of_Walter_Mitty_(2013_film)>).

A similar RPC mechanism was created in [Wayne library](https://github.com/jcubic/wayne).

## License

Copyright (c) 2026 [Jakub T. Jankiewicz](https://jakub.jankiewicz.org/)

Released under the MIT License. See [LICENSE](https://github.com/jcubic/mitty/blob/master/LICENSE) for details.
