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

## Universal Communication

While originally designed for Web/Service Workers, Mitty's underlying architecture is
transport-agnostic. You can use it to bridge any two contexts capable of sending messages:

- Web Workers / Service Workers: Offload heavy logic while keeping DOM access.
- Cross-Tab Communication: Control UI or trigger actions in another browser tab (e.g., via
  [Sysend](https://github.com/jcubic/sysend) or BroadcastChannel).
- Client-Server (WebSockets / WebRTC): Execute commands or query specific main-thread
  states directly from the server or a peer. It works both ways; you can execute browser
  objects from the server or the server from the browser.

See [examples](https://github.com/jcubic/mitty/tree/master/example).

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
with `@` when you want the URL to stay put, e.g. `@jcubic/mitty@0.4.0`.

## Quick start

### Main thread

```js
import { Host } from '@jcubic/mitty';

const modules = {
  $: () => jQuery,
  document: () => document
};

const channel = new BroadcastChannel('my-app');

const host = new Host({
  channel,
  resolve(name) {
    if (Object.hasOwn(modules, name)) {
      return modules[name]();
    }
    return null;
  }
});

const worker = new Worker('./worker.js');
```

Only the names your `resolve()` answers are reachable. Everything else on the page stays
invisible to the worker.

Nothing here says that a jQuery object cannot cross the channel, because it doesn't have
to — see [What travels and what stays](#what-travels-and-what-stays).

### Worker

With an `import` statement, in a worker started with `{ type: 'module' }` — from your
bundler, or straight from the CDN:

```js
import { connect } from '@jcubic/mitty';
// or
import { connect } from 'https://cdn.jsdelivr.net/npm/@jcubic/mitty';

const { require } = connect(new BroadcastChannel('my-app'));

const $ = require('$');
await $('body').find('p').css('color', 'navy');
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

## Universal Channel Interface

The channel doesn't have to be `BroacastChannel`. The channel only needs to implement this interface:

```typescript
interface Channel {
  postMessage(message: string): void;
  addEventListener(type: 'message', listener: ChannelListener): void;
  removeEventListener(type: 'message', listener: ChannelListener): void;
}
```

Web worker already specifies the interface, so if you want one channel per worker you can use this code:

```js
function spawn(url) {
  const worker = new Worker(url);
  const host = new Host({ channel: worker, resolve });
  worker.postMessage({ channel: name }); // tell the worker which one to join
  return { host, worker };
}
```

A channel is never closed by this library — whoever created it owns it.

## How a Chain Becomes One Message

`$('#list').find('li').first().text()` does not talk to the main thread four times. Each
step appends to a list of operations held in the worker:

```js
[
  { type: 'call', args: ['#list'] },
  { type: 'get', key: 'find' },
  { type: 'call', args: ['li'] }
  // ...
];
// and an assignment records { type: 'set', key: 'color', value: 'red' }
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
  }
};

console.log('this works'); // the writes still happen
```

### Setting a Property

Assignment is the one exception to everything above — it is sent **without** being awaited,
because it cannot be awaited:

```js
const body = await require('document').querySelector('body');

body.style.color = 'rebeccapurple'; // sent straight away
body.title = 'set from another tab';
```

`a.b = c` evaluates to `c` in JavaScript, and the proxy has to answer the assignment
immediately, so there is no promise for you to hold. Two things follow from that.

You get no confirmation. Read the value back if you need to know it arrived — a request
made while a set is in flight waits for that set to land, so a read never overtakes the
write in front of it:

```js
body.style.color = 'red';
await body.style.color; // 'red'
```

And a failed set has no caller to reject. It goes to `onerror` instead, which reports on
the console unless you say otherwise:

```js
const { require } = connect(channel, {
  onerror: error => report(error)
});
```

If you would rather have a promise, call the setter the object already has:

```js
await body.style.setProperty('color', 'red');
```

## What travels and what stays

Every value on its way to the worker is either **copied** as JSON or **kept** on the main
thread behind a handle. Mitty decides by asking whether the value's methods are the point
of it:

```js
await require('fs').readdir('/'); // ['bin', 'home'] — copied, an array is still an array
await require('fs').stat('/etc'); // a handle — Stat without isFile() would be useless
```

The rule is `has_methods()`, exported so you can use it yourself. It looks at the whole
prototype chain, not just own properties — which is the point, because a class keeps its
methods on the prototype:

```js
class Stat {
  constructor(type) {
    this.type = type;
  }
  isFile() {
    return this.type === 'file';
  }
}
```

`Object.keys(new Stat('file'))` is `['type']`, so a check for own function properties sees
plain data and copies it. The worker then gets `{ type: 'file' }` and `stat.isFile()` throws
`is not a function` — silently, at the far end, long after the decision was made. Hence the
default.

Values JSON already carries faithfully stay data even though their prototypes are full of
methods: arrays, typed arrays, and anything with a `toJSON()`. Errors are encoded as errors
before any of this runs. Functions returned by the host are still dropped.

### Overriding it

`serialize()` runs first and wins whenever it returns something different:

```js
new Host({
  channel,
  resolve,
  serialize(value) {
    // send a summary instead of a handle
    return value instanceof Stat ? { type: value.type } : value;
  }
});
```

Or replace the rule with a predicate of your own. It replaces the default rather than
adding to it, so `() => false` opts out entirely and goes back to explicit handles:

```js
new Host({ channel, resolve, remote: value => value instanceof Node });
```

## Handles and memory

Anything that becomes a handle — by the default rule or by `this.remote(value)` — is kept
alive on the main thread until it is released. There is no automatic collection: a handle
is a plain integer on the wire, and the host cannot see when the worker drops its proxy.

Because handles are now handed out without being asked for, this is worth a thought for a
long-lived host. A worker that calls `fs.stat()` in a loop pins one object per call until
the host is closed. Release them, or narrow the rule with `remote` so fewer values qualify.

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

| option        | type                 | description                                                                                                  |
| ------------- | -------------------- | ------------------------------------------------------------------------------------------------------------ |
| `channel`     | `Channel`            | Transport to listen on. Required. Never closed by mitty.                                                     |
| `resolve`     | `(name) => unknown`  | Turns a `require()` name into a value. Return `null`/`undefined` for unknown. May be async.                  |
| `serialize`   | `(value) => unknown` | Called for every outgoing value, before `remote`. Return a different value to decide that one yourself.      |
| `unserialize` | `(value) => unknown` | Called for every incoming value.                                                                             |
| `remote`      | `(value) => boolean` | Which values stay behind a handle. Defaults to `has_methods`. Replaces the default rather than adding to it. |

`serialize` and `unserialize` are called with the host as `this`.

- **`host.remote(value)`** — register `value` and return a handle marker. Only needed from
  `serialize()`, for something the `remote` predicate does not catch.
- **`host.release(handle)`** — drop a handle, by marker or by id. Returns `false` if it
  was already gone.
- **`host.close()`** — stop listening and forget every handle.

### `has_methods(value)`

The default `remote` predicate: `true` when the value has a callable property anywhere on
its prototype chain below `Object.prototype`. Arrays, typed arrays, anything with a
`toJSON()`, functions and primitives are all `false`. Getters are read as descriptors, so
asking never invokes one.

### `connect(channel, options?)`

| option    | type              | description                                                                                      |
| --------- | ----------------- | ------------------------------------------------------------------------------------------------ |
| `onerror` | `(error) => void` | Where a failed property assignment goes, since none can be awaited. Defaults to `console.error`. |

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

- **Values must survive JSON**, unless they become a handle — see
  [What travels and what stays](#what-travels-and-what-stays). Circular structures fail the
  call that would return them.
- **The rule is one-way.** The host decides what it keeps; a worker has no equivalent, so an
  object the worker sends as an argument is always copied and arrives without its methods.
  Only functions travel from the worker, as callbacks.
- **`{ __type__, __data__ }` is reserved.** Functions, handles and errors travel as
  objects of that exact shape, so an application value with both of those keys would be
  mistaken for one. The dunder names are deliberate — they are unlikely to occur in real
  data, so ordinary objects such as `{ type: 'object', data: [1] }` pass through intact.
- **Functions returned from the host are dropped**, as they would be by `JSON.stringify`.
  Expose them through a handle instead.
- **Handles are not garbage collected** — see [Handles and memory](#handles-and-memory).
- **One channel carries one conversation.** Request ids start at 1 on every client, so two
  clients sharing a bus (sysend, a `BroadcastChannel` with more than two ends) cannot tell
  their replies apart. A host ignores traffic that is not addressed to it as a request, so
  peers no longer answer each other without end, but the ids still overlap — give each pair
  of ends a channel of its own.

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
