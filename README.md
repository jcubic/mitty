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

Mitty: A transport-agnostic proxy RPC for executing method chains from any isolated
context (Workers, Tabs, or Servers).

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
  functions from the server or the server from the browser.

The wire format is specified independently of this implementation as
**[RO/RPC](https://rorpc.org/)** — Remote Object / Remote Procedure Call.

## Demo

[Online demo with mutliple tabs using Sysend](https://codepen.io/editor/jcubic/pen/01a0d9d8-697e-7dc0-9a2b-eb93adae0dfc).

## Installation

```bash
npm install @jcubic/mitty
```

No installation is needed to use it from a CDN. Two builds ship, and which one you get
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
with `@` when you want the URL to stay put, e.g. `@jcubic/mitty@0.5.0`.

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

## Which keys a chain may walk

A chain is a list of property names the peer chose, so `resolve()` is not quite the whole
boundary: from any object you hand out, `constructor.prototype` reaches `Object.prototype`,
and a write there lands on **every object in the program** — including ones the peer was
never given.

Three keys are refused by default, for reading as well as writing:

```js
await require('config').constructor.prototype.admin; // Error, code -32013
require('config').__proto__.admin = true; // Error, code -32013
```

Refusing the _write_ would not be enough. The damaging write is
`{get constructor}{get prototype}{set admin}`, whose own key is `admin` — perfectly
innocent. It is the reads in front of it that have to be stopped.

The price is that `value.constructor.name` cannot be read across a channel. If you need
that, or want a different rule entirely, `get` and `set` take one:

```js
import { Host, safe_key } from '@jcubic/mitty';

new Host({
  channel,
  resolve,
  get: key => safe_key(key) && !key.startsWith('_'), // keep the default, add to it
  set: () => false // read-only host
});
```

Both are **predicates**: they answer `true` or `false` for a key. They are not `Proxy`
traps — mitty already has `serialize` and `remote` for changing values — and a rule that
answers with anything else fails loudly rather than being read as "allow". Your rule
_replaces_ the default, so compose with `safe_key()` when you mean to keep it.

There is no `has`: RO/RPC has no such operation, and `key in proxy` could not use one
anyway, since `in` must answer synchronously and a round trip cannot.

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

Arguments are trimmed to the number of parameters your callback declares. Callers pass more
than you asked for — jQuery gives an event object, `each()` gives the element beside the
index — and those extras are usually exactly the things that cannot cross a channel.
Declaring what you want is how you decline them:

```js
// cheerio calls back with (index, element); only the index is sent
await $('li').each(index => {
  count[index]++;
});
```

Anything you _do_ declare that the host cannot copy arrives as a handle, and **that handle
lives only for the call**. The host releases it as soon as your callback returns, so an
`each()` over a thousand rows does not leave a thousand objects pinned on the other side.
Read what you need while the call is running:

```js
await $('li').each(async (index, el) => {
  text[index] = await el.text(); // read it now
  saved.push(el); // this handle is dead once the callback returns
});
```

> [!IMPORTANT]
> The count comes from `Function.length`, which **stops at the first default or rest
> parameter**. `(a, b = 1) => …` reports 1, so `b` always takes its default; `(...args) => …`
> reports 0, so it receives nothing at all. Neither fails loudly — the callback simply runs
> with less than the caller passed.
>
> Give a callback a fixed list of plain parameters. If you need an argument, name it:
>
> ```js
> // ✗ b never arrives, args is always empty
> await require('util').each((a, b = 2) => a + b);
> await require('util').each((...args) => args.length);
>
> // ✓ say what you want
> await require('util').each((a, b) => a + (b ?? 2));
> ```

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

Arguments travel the other way as JSON, so a value that is not plain data cannot be
sent. A chain records whatever it is given and fails only when something awaits it, at
which point the call rejects with what the value is and where it sits:

```js
await $('#list').add(back_reference); // refers to itself
// mitty: cannot send ops.1.args.0 across the channel - a circular object with
// constructor 'Selection' - it refers back to itself at ops.1.args.0.owner.
// Only plain data, functions and remote handles can be sent; await a remote
// chain first, and keep host-side objects behind handles.
```

The path counts the message, not your call, so `ops.1.args.0` is the first argument of
the second recorded step. The original `JSON.stringify` error is kept on `error.cause`.

### A library that mistakes a chain for a function

A chain is a `Proxy` around a function, because any step in it may turn out to be a
call. So `typeof chain === 'function'`, and a library that duck-types for a callable
will treat it as one. jQuery Terminal does exactly this in `echo()`:

```js
if (typeof arg === 'function') {
  value = arg.bind(self); // `self` is the terminal's own jQuery object
}
```

That records `bind` as another step and puts a real jQuery selection in its arguments —
a client-side object that cannot cross the channel, so the call rejects. Resolve the
chain _before_ handing it to such a library:

```js
term.echo(await handle.toString()); // a string
term.echo(handle.toString()); // a chain, and the trap above
```

Use [`is_remote(value)`](#is_remotevalue) to tell the two apart.

### Printing a handle

A handle stands for an object the worker never receives, so there is nothing on this side
to build a name from. The host builds it instead, when it mints the handle, and it travels
with it — which is what lets `String(handle)` answer at once:

```js
import { Host, repr } from '@jcubic/mitty';

const host = new Host({
  channel,
  resolve,
  repr(value) {
    if (value instanceof jQuery.fn.init) {
      return `#<jQuery [${value.length}]>`;
    }
    if (value instanceof Element) {
      return `<${value.tagName.toLowerCase()} />`;
    }
    return repr(value); // the import, not this option - see below
  }
});
```

```js
const node = await $('#list').get(0);
`${node}`; // '<li />'
term.echo(String(node)); // '<li />', with no round trip
```

`repr` runs on the host with the host as `this`, and must return a string. Without it the
default is the exported [`repr()`](#reprvalue), which gives `#<HTMLLIElement>`.

The option and the default share a name on purpose, and the call above is not recursion: a
method shorthand does not bind its own name, so `repr(value)` inside it is the import. Write
it as `repr: function repr(value) { ... }` and it _would_ call itself — use the shorthand.

> [!NOTE]
> The repr is built **once**, when the handle is minted, because `Symbol.toPrimitive` has
> to answer synchronously and cannot wait for a round trip. It is a label for a person to
> read, not live data — if the object changes afterwards, the repr does not.

Coercing a chain that has _not_ run is still an error, and says so:

```js
`${$('#list')}`;
// mitty: cannot make a string from a remote chain that has not run - await it first
```

### Listing what a remote object can do

```js
import { dir } from '@jcubic/mitty';

const $ = require('$');
const { methods, properties } = await dir($('.terminal'));
```

Two lists — what the value can be asked to do, and what it holds:

```json
{
  "methods": [
    { "name": "addClass", "params": { "arity": { "required": 1 } } },
    { "name": "append", "params": { "arity": { "required": 0 } } }
  ],
  "properties": [
    { "name": "length", "readonly": false, "type": ["number"] },
    { "name": "innerHTML", "readonly": false }
  ]
}
```

The chain runs first, so `dir($('.terminal'))` costs one round trip, not two. Both lists are
always present and sorted by name; one may be empty.

On the wire the recorded step is `{ type: 'describe' }` — RO/RPC §8.3 names the op for what
it does, while `dir` here is the shorter name a REPL user reaches for.

> [!IMPORTANT]
> Only `name` is ever guaranteed. Everything else is optional, and JavaScript supplies very
> little of it: `Function.length` counts the parameters before the first default, so
> `append(node, mode = 'after')` reports `required: 1` and cannot say a second is accepted.
> Parameter **names and return types are not recoverable at all** — a minified `find(e, t)`
> has lost them. Treat an absent member as unknown, never as zero.

A property's `type` is present only when the host could learn it **without reading the
value** — describing something must not run code, and a getter runs code. So a stored field
is typed and `innerHTML` is not, though both report `readonly`. The same holds one level
down: whether a stored object arrives as data or as a handle depends on its `toJSON`, so a
value whose `toJSON` is a getter is listed without a type rather than have that getter run.

Types are always a list, since a union is the ordinary case:

| Name       | Meaning                                         |
| ---------- | ----------------------------------------------- |
| `string`   |                                                 |
| `number`   |                                                 |
| `boolean`  |                                                 |
| `null`     | The empty value                                 |
| `array`    |                                                 |
| `object`   | A plain object, sent by value                   |
| `remote`   | A handle — the object stays on the host         |
| `function` | A callback                                      |
| `void`     | Nothing at all, which is not the same as `null` |

The list is open: a host may use a name of its own, such as `"DateTime"`, and a client must
not reject one it has not seen.

A host that knows its own API can say much more, through the `describe` option:

```js
import { describe } from '@jcubic/mitty';

new Host({
  channel,
  resolve,
  describe(value) {
    if (value instanceof Query) {
      return {
        methods: [
          {
            name: 'find',
            params: {
              arity: { required: 1, optional: 1 },
              values: [{ name: 'selector', type: ['string', 'remote'] }]
            },
            result: { type: ['remote', 'null'] }
          }
        ],
        properties: [{ name: 'length', readonly: true, type: ['number'] }]
      };
    }
    // the import, not this option - a method
    // shorthand does not bind its own name
    return describe(value);
  }
});
```

Return `null` to refuse. That is an error on the client, not two empty lists — empty means
"nothing on this object", which is a different claim. Introspection is optional in RO/RPC
for exactly this reason: not every language can look a value up like this.

`describe` never names a key the host's `get` policy would refuse, so it cannot be used to
enumerate what that policy hides. An entry it returns without a string `name` is an error,
not something quietly dropped — the key filter cannot judge a name that is not a string.

### Sending what JSON cannot carry

`object`, `function` and `error` are mitty's own `__type__` names. Every other one is
yours, and that is how a `BigInt`, a `RegExp` or anything else JSON has no place for
crosses the channel. Give it a marker on the way out and read it back on the way in:

```js
const serialize = value => {
  if (typeof value === 'bigint') {
    return { __type__: 'bigint', __data__: { value: value.toString() } };
  }
  if (value instanceof RegExp) {
    return { __type__: 'regex', __data__: { source: value.source, flags: value.flags } };
  }
  return value; // not mine - leave it alone
};

const unserialize = value => {
  if (value?.__type__ === 'bigint') return BigInt(value.__data__.value);
  if (value?.__type__ === 'regex') {
    return new RegExp(value.__data__.source, value.__data__.flags);
  }
  return value;
};
```

> [!IMPORTANT]
> **Both ends need the same pair.** The host takes them as options, and so does `connect()`:
>
> ```js
> new Host({ channel, resolve, serialize, unserialize });
> const { require } = connect(channel, { serialize, unserialize });
> ```
>
> Give them to one side only and the other receives the raw marker — a plain object where
> you meant a number. Nothing in the protocol says what `bigint` means; the two rules are
> what make it mean anything.

They apply at any depth, in either direction, and inside a callback's arguments:

```js
await $.grep(/^a/i, { limit: 10n }); // out
const rule = await settings.pattern; // back, as a real RegExp
```

A `serialize` hook claims a value only by **returning something else**. Hand the value
straight back and mitty's own handling is untouched, so a handle stays a handle and an
error stays an error.

Without a hook, a `BigInt` is refused with a clear error and a `RegExp` would flatten to
`{}` the way `JSON.stringify` leaves it.

## API

### `new Host(options)`

| option        | type                             | description                                                                                                  |
| ------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `channel`     | `Channel`                        | Transport to listen on. Required. Never closed by mitty.                                                     |
| `resolve`     | `(name) => unknown`              | Turns a `require()` name into a value. Return `null`/`undefined` for unknown. May be async.                  |
| `serialize`   | `(value) => unknown`             | Called for every outgoing value, before `remote`. Return a different value to decide that one yourself.      |
| `unserialize` | `(value) => unknown`             | Called for every incoming value.                                                                             |
| `remote`      | `(value) => boolean`             | Which values stay behind a handle. Defaults to `has_methods`. Replaces the default rather than adding to it. |
| `get`         | `(key) => boolean`               | May a chain read this key? Defaults to `safe_key`. Replaces it rather than adding to it.                     |
| `set`         | `(key) => boolean`               | May a chain write this key? Defaults to `safe_key`.                                                          |
| `repr`        | `(value) => string`              | The string form of a value kept behind a handle. Built when the handle is minted. Defaults to `repr()`.      |
| `describe`    | `(value) => Description \| null` | What `dir()` answers for a value kept here. `null` refuses. Defaults to `describe()`.                        |

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

### `safe_key(key)`

The default `get`/`set` predicate: `false` for `__proto__`, `constructor` and `prototype`,
`true` otherwise. Exported so a rule of your own can keep it — see
[Which keys a chain may walk](#which-keys-a-chain-may-walk).

### `is_remote(value)`

`true` when `value` is a chain or a handle made by `connect()`. Use it wherever a
`typeof value === 'function'` test would otherwise catch one:

```js
import { is_remote } from '@jcubic/mitty';

if (typeof value === 'function' && !is_remote(value)) {
  value = value.bind(self);
}
```

A library that does not depend on mitty can make the same test from the symbol alone.
It is registered with `Symbol.for()`, so a second copy of mitty — a bundled one beside
one from a CDN — still answers to it:

```js
const HANDLE = Symbol.for('@jcubic/mitty/handle');
const is_remote = value =>
  !!value &&
  (typeof value === 'object' || typeof value === 'function') &&
  !!value[HANDLE];
```

### `repr(value)`

The default for the host's `repr` option: `#<Selection>`, from the constructor name.
Exported so a `repr` of your own can fall back to it.

### `dir(remote)`

`Promise<Description>` — `{ methods, properties }` for a handle, or for whatever a chain
resolves to. Rejects if given something that is not remote.

### `describe(value)`

The default for the host's `describe` option: `{ methods, properties }` for the value and
its prototype chain, each sorted by name, stopping above `Object.prototype`. Members are
read as descriptors, so asking never invokes a getter.

The name is the one every test framework uses for its own global, so in a test file import
it under another name, or reach it through the namespace:

```js
import * as mitty from '@jcubic/mitty';
mitty.describe(value);
```

### `connect(channel, options?)`

| option        | type                 | description                                                                                      |
| ------------- | -------------------- | ------------------------------------------------------------------------------------------------ |
| `onerror`     | `(error) => void`    | Where a failed property assignment goes, since none can be awaited. Defaults to `console.error`. |
| `serialize`   | `(value) => unknown` | Called for every outgoing value. Return a different value to send that instead.                  |
| `unserialize` | `(value) => unknown` | Called for every incoming value, including a `__type__` mitty does not know.                     |

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
- **`__proto__`, `constructor` and `prototype` are refused**, so `value.constructor.name`
  cannot be read across a channel — see [Which keys a chain may walk](#which-keys-a-chain-may-walk).
- **One channel carries one conversation.** Request ids start at 1 on every client, so two
  clients sharing a bus (sysend, a `BroadcastChannel` with more than two ends) cannot tell
  their replies apart. A host ignores traffic that is not addressed to it as a request, so
  peers no longer answer each other without end, but the ids still overlap — give each pair
  of ends a channel of its own.

## Examples

All of them live in [`example/`](https://github.com/jcubic/mitty/tree/master/example) and
run against the local build, so `npm run build` first.

### [`example/worker/`](https://github.com/jcubic/mitty/tree/master/example/worker)

A page that drives jQuery from a worker, in both the `importScripts` and `import` styles.

```bash
npm install && npm run build
npx serve .
```

then open `/example/worker/`.

### [`example/cross-tab/`](https://github.com/jcubic/mitty/tree/master/example/cross-tab)

One tab reaching into another over [sysend](https://github.com/jcubic/sysend), driving
both jQuery and plain DOM. Served the same way; open it in two tabs.

### [`example/node/`](https://github.com/jcubic/mitty/tree/master/example/node)

**cheerio on the server, driven from the browser over a WebSocket.** No markup reaches the
page and cheerio never runs there — the browser writes `$('li').first().text()` and the
chain is replayed in Node.

```bash
npm run build          # in the repo root
cd example/node
npm install
npm start
```

then open <http://localhost:3000>.

A socket already is a two-way stream of messages, so the only thing between it and a
`Channel` is the name:

```js
const channel = socket => ({
  postMessage: message => socket.send(message),
  addEventListener: (type, listener) => socket.addEventListener(type, listener),
  removeEventListener: (type, listener) => socket.removeEventListener(type, listener)
});
```

That same adapter works on both ends — `ws` in Node and the browser's `WebSocket` both
carry `addEventListener`. The example gives every connection its own `Host` and its own
document, calls `host.close()` when the socket drops, and covers handles, callbacks,
arity trimming and error propagation; see its
[README](https://github.com/jcubic/mitty/tree/master/example/node#readme).

> [!WARNING]
> Whatever `resolve()` answers is fully reachable by whoever is on the other end. Handing
> out `$` lets a client run any chain against that document. Over a socket that is your
> security boundary — return a narrow object of the operations you mean to allow.

## Development

```bash
npm test          # unit tests
npm run coverage  # tests with coverage
npm run lint      # eslint
npm run build     # ESM + IIFE + .d.ts into dist/
```

## Origin

The first idea for the mechanism was created for [Fake Linux Terminal](https://fake.terminal.jcubic.pl/),
and improved in [Hacking Cafe](https://hacking.cafe), a Unix-like environment in the browser. It was then
extracted into an NPM library. The name and logo were based on a fictional "Life" magazine worker named
[Waleter Mitty](https://en.wikipedia.org/wiki/Walter_Mitty) from the movie
["The Secret Life of Walter Mitty"](<https://en.wikipedia.org/wiki/The_Secret_Life_of_Walter_Mitty_(2013_film)>).

## License

Copyright (c) 2026 [Jakub T. Jankiewicz](https://jakub.jankiewicz.org/)

Released under the MIT License. See [LICENSE](https://github.com/jcubic/mitty/blob/master/LICENSE) for details.
