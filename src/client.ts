/*
 * Mitty - use main thread objects from inside a Web Worker
 *
 * Copyright (c) 2026 Jakub T. Jankiewicz <https://jakub.jankiewicz.org>
 * Released under MIT license
 */
import {
    HANDLE,
    VERSION,
    compatible,
    decode_error,
    encode_error,
    is_error_marker,
    is_object_marker,
    version_mismatch
} from './protocol';
import type {
    Channel,
    ChannelListener,
    Client,
    ClientOptions,
    Description,
    Op,
    Remote
} from './types';

// what a chain is rooted at: a module looked up by name, or an object that
// stayed behind on the host
interface Root {
    namespace?: string;
    object?: number;
}

interface ChainInfo {
    root: Root;
    ops: Op[];
    // run this chain and describe what it produces. Held here rather than
    // exported from the client object because dir() is a free function, and a
    // chain is the only thing it is given - it has to find its own way back
    // to the connection that made it
    dir(): Promise<Description>;
}

interface Message {
    rorpc?: string;
    id?: number;
    // present on a request, never on a reply - see the listener below
    ops?: unknown;
    callback?: number;
    call?: number;
    args?: unknown[];
    result?: unknown;
    error?: unknown;
    release?: number;
}

type Callback = (...args: unknown[]) => unknown;

// where JSON.stringify last was, and - when the value has been seen before -
// the path of the second sighting that closes the circle
interface Spot {
    path: string[];
    value: unknown;
    loop?: string[];
}

const PROMISE_METHODS = ['then', 'catch', 'finally'];

// what a handle says for itself when the host sent no repr - §6.1.1 makes it
// optional, so a host that does not build one is a host a client has to live
// with rather than an error
const UNLABELLED = '#<object>';

function is_promise_method(key: string): boolean {
    return PROMISE_METHODS.includes(key);
}

function chain_info(value: unknown): ChainInfo | undefined {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
        return undefined;
    }
    return (value as Record<symbol, ChainInfo | undefined>)[HANDLE];
}

// -----------------------------------------------------------------------------
// Connect to a Host listening on the other end of `channel`. Safe to call in a
// worker loaded with either `import` or `importScripts`.
// -----------------------------------------------------------------------------
export function connect(channel: Channel, options: ClientOptions = {}): Client {
    const on_error =
        options.onerror ??
        ((error: unknown) => {
            // a set has no caller to reject, so say something rather than
            // letting the failure disappear
            console.error('mitty: setting a remote property failed', error);
        });
    let rpc_id = 0;
    let callback_id = 0;
    const pending = new Map<
        number,
        { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
    >();
    // functions handed to the host, so it can call back into this worker.
    // keyed both ways to reuse an id when the same function is passed twice.
    const callbacks = new Map<number, Callback>();
    const callback_ids = new Map<Callback, number>();
    const to_wire = options.serialize;
    const from_wire = options.unserialize;

    // a short name for a value that cannot cross the channel, for an error
    // that says what it is rather than where JSON.stringify gave up on it.
    // Terminal emulators and other thenable-sniffing libraries call .bind() on
    // an awaitable chain with one of their own objects, which lands a
    // client-side value like a jQuery selection in the recorded args - the raw
    // "circular structure" error that follows names no channel and no argument.
    // No article, so a caller can put one in front of it or a word between
    function describe_value(value: unknown): string {
        // only ever called for a value that closed a circle, which is always
        // a non-null object - hence no primitive case here
        if (Array.isArray(value)) {
            return 'array';
        }
        const node = value as { nodeType?: unknown; nodeName?: unknown };
        if (typeof node.nodeType === 'number' && typeof node.nodeName === 'string') {
            return `DOM node <${node.nodeName}>`;
        }
        const name = (value as { constructor?: { name?: unknown } }).constructor?.name;
        if (typeof name === 'string' && name !== 'Object') {
            return `object with constructor '${name}'`;
        }
        return 'object';
    }

    function serialize(data: unknown): string {
        // where JSON.stringify was when it gave up. Recorded as the replacer
        // runs, so a failure costs no second pass over the message - and a
        // second pass is what would have to repeat every rule below, forever,
        // to keep agreeing with them.
        const paths = new WeakMap<object, string[]>();
        // held in a box rather than a plain `let`: the replacer writes it, and
        // a `let` would still read as its initial null down in the catch
        const seen_last: { at: Spot | null } = { at: null };

        function note(holder: object, key: string, raw: unknown): void {
            // the root holder is the wrapper JSON makes, `{ "": data }`, and
            // is the one holder never recorded. Anything else missing from
            // `paths` sits under a toJSON() result, off the path the caller
            // wrote - better to say nothing than to name a place they cannot
            // find
            const path = key === '' ? [] : paths.get(holder);
            if (path === undefined) {
                seen_last.at = null;
                return;
            }
            const here = key === '' ? [] : [...path, key];
            if (raw === null || typeof raw !== 'object') {
                seen_last.at = { path: here, value: raw };
                return;
            }
            const seen = paths.get(raw);
            if (seen === undefined) {
                paths.set(raw, here);
                seen_last.at = { path: here, value: raw };
                return;
            }
            // second sighting: the loop closes here, but what the caller can
            // act on is the value itself, at the place they put it
            seen_last.at = { path: seen, value: raw, loop: here };
        }

        try {
            return JSON.stringify(
                data,
                function (this: Record<string, unknown>, key, value) {
                    // the raw holder value, before JSON.stringify applied toJSON() -
                    // a chain proxy answers every property access, toJSON included
                    const raw = this[key];
                    note(this, key, raw);
                    if (raw instanceof Error) {
                        return encode_error(raw);
                    }
                    // the hook comes before the protocol's own markers, so a
                    // value it claims is sent its way. It claims one only by
                    // returning something else - a hook that hands the value
                    // straight back leaves a handle or a callback alone
                    const decided = to_wire ? to_wire(raw) : raw;
                    if (decided !== raw) {
                        return decided;
                    }
                    const chain = chain_info(raw);
                    if (chain) {
                        if (chain.ops.length || typeof chain.root.object !== 'number') {
                            throw new TypeError(
                                'mitty: cannot send an unresolved remote chain - await it first'
                            );
                        }
                        // a handle can go back to the host, which swaps it for the
                        // object it stands for
                        return {
                            __type__: 'object',
                            __data__: { handle: chain.root.object }
                        };
                    }
                    if (typeof raw === 'function') {
                        let id = callback_ids.get(raw as Callback);
                        if (id === undefined) {
                            id = ++callback_id;
                            callback_ids.set(raw as Callback, id);
                            callbacks.set(id, raw as Callback);
                        }
                        // the arity the callback declares. Callers pass extras that
                        // a callback did not ask for - an element beside an index, an
                        // event beside a value - and those are often exactly what
                        // cannot cross a channel. What Function.length cannot express
                        // is a documented limitation; see the README
                        return {
                            __type__: 'function',
                            __data__: { callback: id, arity: raw.length }
                        };
                    }
                    return value;
                }
            );
        } catch (error) {
            // the replacer's own refusal already names the problem
            if (error instanceof Error && error.message.startsWith('mitty:')) {
                throw error;
            }
            // only two things are known to be the value's own fault: it closed
            // a circle, or JSON carries no type for it. Everything else that
            // can throw in here is someone's toJSON(), and dressing that up as
            // a channel problem would send the caller looking the wrong way
            const found = seen_last.at;
            const kind =
                found === null
                    ? null
                    : found.loop
                      ? `a circular ${describe_value(found.value)} - it refers ` +
                        `back to itself at ${found.loop.join('.')}`
                      : typeof found.value === 'bigint'
                        ? 'a bigint'
                        : null;
            if (found === null || kind === null) {
                throw error;
            }
            const failure = new TypeError(
                `mitty: cannot send ${found.path.join('.')} across the channel - ` +
                    `${kind}. Only plain data, functions and remote handles can ` +
                    `be sent; await a remote chain first, and keep host-side ` +
                    `objects behind handles.`
            );
            // the JSON error underneath, kept for its stack. Assigned rather
            // than constructed: the target predates cause options.
            (failure as TypeError & { cause?: unknown }).cause = error;
            throw failure;
        }
    }

    function unserialize(text: string): Message {
        return JSON.parse(text, (_key, value) => {
            if (is_object_marker(value)) {
                // a handle to something on the host - make it a chain rooted
                // there rather than handing back the marker itself
                return make_chain(
                    { object: value.__data__.handle },
                    [],
                    value.__data__.repr
                );
            }
            if (is_error_marker(value)) {
                return decode_error(value);
            }
            // anything mitty does not recognise, marker or not, goes to the
            // hook - that is where an application's own __type__ is decoded
            return from_wire ? from_wire(value) : value;
        }) as Message;
    }

    function post(data: Message): void {
        channel.postMessage(serialize({ rorpc: VERSION, ...data }));
    }

    async function run_callback(data: Message): Promise<void> {
        const fn = callbacks.get(data.callback as number);
        if (!fn || typeof data.call !== 'number') {
            return;
        }
        try {
            post({ call: data.call, result: await fn(...(data.args ?? [])) });
        } catch (error) {
            let failure: Error;
            try {
                failure = error instanceof Error ? error : new Error(String(error));
            } catch {
                // Even string conversion can fail, for example for a null-prototype object.
                failure = new Error('Callback failed');
            }
            post({ call: data.call, error: failure });
        }
    }

    // A frame that will not decode used to mean one thing: bytes that are not
    // JSON, carrying no id worth recovering. `unserialize` now runs a hook the
    // caller wrote, so a perfectly readable frame can fail on a value inside
    // it - and dropping that silently leaves whoever is waiting on it waiting
    // for ever. So the id is read back without the reviver that threw, and
    // whoever was waiting is told.
    function report_failure(text: string, reason: unknown): void {
        let frame: {
            rorpc?: unknown;
            id?: unknown;
            call?: unknown;
            callback?: unknown;
            ops?: unknown;
        };
        try {
            frame = JSON.parse(text) as typeof frame;
        } catch {
            // not JSON at all, so there was never anything to answer
            return;
        }
        if (frame === null || typeof frame !== 'object' || Array.isArray(frame.ops)) {
            // a request, which this client does not answer either way
            return;
        }
        const failure = reason instanceof Error ? reason : new Error(String(reason));
        if (typeof frame.callback === 'number' && typeof frame.call === 'number') {
            // the same two questions the ordinary path asks before it answers
            // an invocation, and for the same reasons. Without the version
            // check this is the one place that replies to a major it cannot
            // read; without the ownership check a client answers for a peer it
            // is merely overhearing on a shared bus, and the host fails a call
            // that was never this one's to fail
            if (!compatible(frame.rorpc) || !callbacks.has(frame.callback)) {
                return;
            }
            // the host is awaiting this invocation and nothing else will
            // settle it. Its own serialize may fail in turn, and there is
            // nowhere left to report that
            try {
                post({ call: frame.call, error: failure });
            } catch {
                on_error(failure);
            }
            return;
        }
        if (typeof frame.id !== 'number') {
            return;
        }
        const entry = pending.get(frame.id);
        if (!entry) {
            return;
        }
        pending.delete(frame.id);
        entry.reject(failure);
    }

    const listener: ChannelListener = event => {
        let data: Message;
        try {
            data = unserialize(event.data);
        } catch (error) {
            report_failure(event.data, error);
            return;
        }
        // §5.2. A client has no error reply to send, so a message it cannot
        // speak to is dropped; §5.2 permits failing the pending call instead,
        // which is done below rather than leaving a caller waiting forever
        const versioned = compatible(data.rorpc);
        if (typeof data.callback === 'number') {
            if (versioned) {
                void run_callback(data);
            }
            return;
        }
        // only a reply settles a pending call. On a shared bus this client
        // also overhears the requests other peers send, and those carry an id
        // from a counter of their own - one could match a call in flight here
        // and settle it with a value that was never meant for it
        if (typeof data.id !== 'number' || Array.isArray(data.ops)) {
            return;
        }
        const entry = pending.get(data.id);
        if (!entry) {
            return;
        }
        pending.delete(data.id);
        if (!versioned) {
            entry.reject(version_mismatch(data.rorpc));
            return;
        }
        if (data.error) {
            entry.reject(data.error);
        } else {
            entry.resolve(data.result);
        }
    };

    channel.addEventListener('message', listener);

    function send(root: Root, ops: Op[]): Promise<unknown> {
        return new Promise((resolve, reject) => {
            const id = ++rpc_id;
            let payload: string;
            try {
                payload = serialize({ rorpc: VERSION, id, ...root, ops });
            } catch (error) {
                // an argument that cannot be sent (an unresolved chain, a
                // circular structure) fails the call rather than the channel
                reject(error);
                return;
            }
            pending.set(id, { resolve, reject });
            channel.postMessage(payload);
        });
    }

    // A set goes out without anyone awaiting it, so on its own nothing stops a
    // read issued afterwards from reaching the host first - every message is
    // handled in a task of its own there, and a resolve() that yields is
    // enough for the second to finish before the first. So while a set is in
    // flight the requests behind it wait for it, which is what lets a read
    // after a set see what the set wrote. With no set outstanding this costs
    // nothing: the request goes straight out.
    let in_flight: Promise<unknown> | null = null;

    function call(root: Root, ops: Op[]): Promise<unknown> {
        const dispatch = () => send(root, ops);
        const result = in_flight ? in_flight.then(dispatch, dispatch) : dispatch();
        if (ops[ops.length - 1]?.type === 'set') {
            const settled = result.then(
                () => {},
                () => {}
            );
            in_flight = settled;
            void settled.then(() => {
                // unless a later set has taken over the queue in the meantime
                if (in_flight === settled) {
                    in_flight = null;
                }
            });
        }
        return result;
    }

    // -------------------------------------------------------------------------
    // Records property accesses and calls without touching the channel. The
    // whole chain is sent once, when something awaits it.
    // -------------------------------------------------------------------------
    // `label` is the repr the host built when it minted this handle (§6.1.1).
    // It belongs to the handle, not to anything recorded onto it - a chain is
    // an operation that has not run, and has no value to stand for yet.
    function make_chain(root: Root, ops: Op[] = [], label?: string): Remote {
        const target = function () {} as unknown as Remote;
        return new Proxy(target, {
            apply(_target, _this_arg, args: unknown[]) {
                return make_chain(root, [...ops, { type: 'call', args }], label);
            },
            get(_target, key) {
                if (key === HANDLE) {
                    return {
                        root,
                        ops,
                        dir: () => call(root, [...ops, { type: 'describe' }])
                    } as ChainInfo;
                }
                // String(x), `${x}` and x + '' all land here. They cannot wait
                // for a round trip, so the answer has to be something already
                // held: the repr that came with the handle. Without this the
                // engine falls back to toString(), which on a chain is another
                // chain rather than a string, and coercion fails with
                // "Cannot convert object to primitive value"
                if (key === Symbol.toPrimitive) {
                    return () => {
                        if (ops.length) {
                            throw new TypeError(
                                'mitty: cannot make a string from a remote chain ' +
                                    'that has not run - await it first'
                            );
                        }
                        if (typeof root.namespace === 'string') {
                            return `#<module '${root.namespace}'>`;
                        }
                        return label ?? UNLABELLED;
                    };
                }
                // a chain with something recorded behaves like a promise:
                // attaching then/catch/finally is what triggers execution
                if (ops.length && typeof key === 'string' && is_promise_method(key)) {
                    return (...args: unknown[]) => {
                        const promise = call(root, ops) as unknown as Record<
                            string,
                            (...args: unknown[]) => unknown
                        >;
                        return promise[key](...args);
                    };
                }
                // with nothing recorded there is nothing to run. `then` still
                // has to be hidden - a bare handle resolves to another handle,
                // and native promise resolution would keep adopting it
                // forever. catch/finally carry no such hazard, so they fall
                // through and stay callable as ordinary remote methods.
                if (key === 'then') {
                    return undefined;
                }
                if (typeof key !== 'string') {
                    return undefined;
                }
                return make_chain(root, [...ops, { type: 'get', key }], label);
            },
            // An assignment cannot be awaited. This trap has to answer now,
            // and `a.b = c` evaluates to `c` in JavaScript, never to a
            // promise. So a set is the one thing mitty sends without being
            // asked to - the alternative is for it never to be sent at all.
            //
            // Trapping it is also what keeps `el.name = x` working: the
            // chain's target is a function, and a function's own `name` and
            // `length` are read-only, so an untrapped assignment throws.
            set(_target, key, value) {
                if (typeof key === 'string') {
                    void call(root, [...ops, { type: 'set', key, value }])
                        .catch(on_error)
                        .catch(() => {
                            // onerror belongs to the caller and can throw. The
                            // rejection it leaves has nowhere left to go, and
                            // an unhandled one would take the process down
                        });
                }
                return true;
            }
        });
    }

    // the host-side id a bare handle stands for. A chain that still has ops, or
    // one rooted at a module, does not name a single object.
    function handle_id(remote: unknown): number {
        const chain = chain_info(remote);
        if (!chain || chain.ops.length || typeof chain.root.object !== 'number') {
            throw new TypeError('mitty: expected a remote handle');
        }
        return chain.root.object;
    }

    return {
        require(name: string): Remote {
            return make_chain({ namespace: name });
        },
        handle(remote: unknown): number {
            return handle_id(remote);
        },
        release(remote: unknown): void {
            post({ release: typeof remote === 'number' ? remote : handle_id(remote) });
        },
        close(): void {
            channel.removeEventListener('message', listener);
            pending.clear();
            callbacks.clear();
            callback_ids.clear();
        }
    };
}

// -----------------------------------------------------------------------------
// List the methods of a remote object.
//
//     import { dir } from '@jcubic/mitty';
//     await dir(await $('.terminal'));
//
// Given a chain that has not run, the chain runs first and what it produces is
// what gets described - so `await dir($('.terminal'))` works too, in one round
// trip rather than two.
//
// Answers two lists, `methods` and `properties`. Everything past `name` in
// either is optional; see the Method and Property types. A host may refuse
// outright, which is an error rather than two empty lists.
// -----------------------------------------------------------------------------
export function dir(remote: unknown): Promise<Description> {
    const info = chain_info(remote);
    if (!info || typeof info.dir !== 'function') {
        return Promise.reject(
            new TypeError(
                'mitty: dir() expects a remote object - a handle, or a chain ' +
                    'that resolves to one'
            )
        );
    }
    return info.dir();
}
