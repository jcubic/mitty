/*
 * Mitty - use main thread objects from inside a Web Worker
 *
 * Copyright (c) 2026 Jakub T. Jankiewicz <https://jakub.jankiewicz.org>
 * Released under MIT license
 */
import {
    CODES,
    VERSION,
    cannot_set,
    compatible,
    decode_error,
    encode_error,
    invalid_handle,
    internal,
    invalid_request,
    key_denied,
    is_error_marker,
    is_function_marker,
    is_object_marker,
    no_introspection,
    not_a_function,
    unknown_module,
    version_mismatch
} from './protocol';
import type { Channel, ChannelListener, Description, ObjectMarker, Op } from './types';
import { describe, has_methods, repr, safe_key } from './values';

export interface HostOptions {
    // the transport this host listens on; the host never closes it
    channel: Channel;
    // turn a module name from require() into the value the chain runs against.
    // Return null/undefined for an unknown name. May be async.
    resolve(name: string): unknown;
    // called for every value on its way out, before the `remote` predicate
    // below. Return a different value to decide the matter yourself - a plain
    // copy to send data where a handle would be the default, or
    // this.remote(value) for something the default would not catch.
    serialize?(this: Host, value: unknown): unknown;
    // called for every value coming in from the client
    unserialize?(this: Host, value: unknown): unknown;
    // which values stay here behind a handle instead of being copied.
    // Defaults to has_methods(), so a DOM node, a jQuery object or any class
    // instance keeps working in the worker with nothing configured. Replaces
    // the default rather than adding to it: `() => false` turns it off.
    remote?(value: unknown): boolean;
    // May a chain read this key? May it write it? Both default to safe_key(),
    // which refuses the keys a chain reaches a prototype through - see
    // RO/RPC §13.2. These are predicates, not Proxy traps: answer true or
    // false. A rule of your own replaces the default rather than adding to
    // it, so compose with safe_key() when you mean to keep it.
    get?(key: string): boolean;
    set?(key: string): boolean;
    // the string form of a value that stays here behind a handle. Built when
    // the handle is minted and sent with it, so `String(handle)` in the client
    // answers without a round trip. Defaults to the exported repr().
    repr?(this: Host, value: unknown): string;
    // what dir() on the client answers for a value kept here. Defaults to
    // methods(). Return null to refuse - RO/RPC makes introspection optional,
    // because not every language can look a value up like this.
    dir?(this: Host, value: unknown): Description | null;
}

interface Message {
    rorpc?: string;
    id?: number;
    namespace?: string;
    object?: number;
    ops?: Op[];
    callback?: number;
    call?: number;
    args?: unknown[];
    result?: unknown;
    error?: unknown;
    release?: number;
}

type Resolver = { resolve: (value: unknown) => void; reject: (reason: unknown) => void };

export class Host {
    private _options: HostOptions;
    private _channel: Channel;
    private _listener: ChannelListener;
    // objects that cannot cross the channel, kept alive behind an integer id.
    // there is no GC here - entries live until release() drops them.
    private _objects = new Map<number, unknown>();
    private _object_id = 0;
    // in-flight invocations of client callbacks, keyed per call (not per
    // function) so the same callback can be running more than once at a time
    private _pending = new Map<number, Resolver>();
    // handles made while preparing one callback invocation, by call id. They
    // belong to that call and are dropped when it is complete - see §10.4
    private _scoped = new Map<number, number[]>();
    private _call_id = 0;

    constructor(options: HostOptions) {
        this._options = options;
        this._channel = options.channel;
        this._listener = event => {
            void this._on_message(event.data);
        };
        this._channel.addEventListener('message', this._listener);
    }

    // -------------------------------------------------------------------------
    // turn a value into a handle the client can call methods on instead of
    // receiving a copy of. Call this from serialize().
    // -------------------------------------------------------------------------
    public remote(value: unknown): ObjectMarker {
        const id = ++this._object_id;
        this._objects.set(id, value);
        return { __type__: 'object', __data__: { handle: id, repr: this._repr(value) } };
    }

    // The string form travels with the handle rather than being asked for
    // later, because the client needs it from Symbol.toPrimitive - and that
    // has to answer now. There is no round trip to be had inside `String(x)`.
    private _repr(value: unknown): string {
        const rule = this._options.repr ?? repr;
        const text = rule.call(this, value);
        if (typeof text !== 'string') {
            throw internal(`repr() must answer a string, not ${typeof text}`);
        }
        return text;
    }

    // -------------------------------------------------------------------------
    // drop a handle. Returns false if it was already gone.
    // -------------------------------------------------------------------------
    public release(handle: ObjectMarker | number): boolean {
        const id = typeof handle === 'number' ? handle : handle?.__data__?.handle;
        if (typeof id !== 'number') {
            throw new TypeError('mitty: release() expects a handle returned by remote()');
        }
        return this._objects.delete(id);
    }

    // -------------------------------------------------------------------------
    // stop listening and forget every handle. The channel stays open.
    // -------------------------------------------------------------------------
    public close(): void {
        this._channel.removeEventListener('message', this._listener);
        this._objects.clear();
        this._pending.clear();
        this._scoped.clear();
    }

    // -------------------------------------------------------------------------
    // `made` collects the handles this message minted, for a caller that has
    // to release them later
    private _post(data: Message, made?: number[]): void {
        this._channel.postMessage(this._serialize({ rorpc: VERSION, ...data }, made));
    }

    // -------------------------------------------------------------------------
    private _serialize(data: Message, made?: number[]): string {
        // bound here because the replacer has to be a plain function - its
        // `this` is the holder object, not the Host
        const hook = this._options.serialize?.bind(this);
        const wanted = this._options.remote ?? has_methods;
        const mint = (value: unknown) => {
            const marker = this.remote(value);
            made?.push(marker.__data__.handle);
            return marker;
        };
        // JSON.stringify offers the replacer the whole message first, under an
        // empty key. That one is the envelope every reply travels in, not a
        // value being sent, so no predicate gets a say over it
        let envelope = true;
        return JSON.stringify(data, function (this: Record<string, unknown>, key, value) {
            // read the untouched value off the holder: by the time a replacer
            // runs, JSON.stringify has already swapped in the result of any
            // toJSON(), which hides what we need to recognise
            const raw = this[key];
            if (envelope) {
                envelope = false;
                return value;
            }
            if (raw instanceof Error) {
                return encode_error(raw, CODES.APPLICATION);
            }
            const result = hook ? hook(raw) : raw;
            if (result !== raw) {
                // the hook decided; it is the one place that can override
                // both the default and a `remote` predicate
                return result;
            }
            if (wanted(raw)) {
                return mint(raw);
            }
            // nothing claimed the value, so fall back to `value` and let the
            // ordinary JSON conventions (Date#toJSON and friends) apply
            return value;
        });
    }

    // -------------------------------------------------------------------------
    // Returns null for a message that isn't even JSON - there is nothing to
    // reply to in that case. A handle that no longer exists is reported as a
    // deferred error instead of thrown, so the reply can still carry the id
    // the client is waiting on.
    // -------------------------------------------------------------------------
    private _unserialize(text: string): { data: Message; error: Error | null } | null {
        const hook = this._options.unserialize?.bind(this);
        let deferred: Error | null = null;
        try {
            const data = JSON.parse(text, (_key, value) => {
                if (is_function_marker(value)) {
                    const { callback, arity } = value.__data__;
                    return this._callback(callback, arity);
                }
                if (is_object_marker(value)) {
                    const { handle } = value.__data__;
                    if (!this._objects.has(handle)) {
                        deferred = deferred ?? invalid_handle(handle);
                        return undefined;
                    }
                    return this._objects.get(handle);
                }
                if (is_error_marker(value)) {
                    return decode_error(value);
                }
                return hook ? hook(value) : value;
            }) as Message;
            return { data, error: deferred };
        } catch {
            return null;
        }
    }

    // -------------------------------------------------------------------------
    // a stub standing in for a function that lives on the client. Calling it
    // sends the arguments over and resolves once the client replies.
    // -------------------------------------------------------------------------
    private _callback(id: number, arity?: number) {
        return (...args: unknown[]): Promise<unknown> => {
            const call = ++this._call_id;
            return new Promise((resolve, reject) => {
                this._pending.set(call, { resolve, reject });
                // §11.2: a limit only if the client asked for a real one.
                // Callers like jQuery pass extras (event objects, elements)
                // that a client usually cannot take, so most ask for one.
                // A negative arity would reach slice() as "all but the last",
                // and a fraction or NaN as something else again - none of
                // which is a limit, so treat those as if none was given
                const limited = Number.isInteger(arity) && (arity as number) >= 0;
                const sent = limited ? args.slice(0, arity) : args;
                // anything kept back for these arguments belongs to this call
                const made: number[] = [];
                this._post({ callback: id, call, args: sent }, made);
                if (made.length) {
                    this._scoped.set(call, made);
                }
            });
        };
    }

    // -------------------------------------------------------------------------
    private async _on_message(text: string): Promise<void> {
        const parsed = this._unserialize(text);
        if (!parsed) {
            return;
        }
        const { data, error } = parsed;
        // §5.2. The check comes after the message has been classified, not
        // before: only a would-be request may be answered with an error, or a
        // reply overheard on a shared bus would draw one, which the peer's
        // host would answer in turn - the storm the `ops` test below prevents
        const versioned = compatible(data.rorpc);

        // a client callback finished - `callback` is absent, which is what
        // distinguishes a result coming back from an invocation going out
        if (typeof data.call === 'number' && data.callback === undefined) {
            if (!versioned) {
                return;
            }
            const entry = this._pending.get(data.call);
            if (entry) {
                this._pending.delete(data.call);
                if (data.error) {
                    entry.reject(data.error);
                } else {
                    entry.resolve(data.result);
                }
            }
            // the call is over, so the handles it needed are too. This runs
            // after the reply was read, so a handle the client sent back was
            // already resolved to its object
            const made = this._scoped.get(data.call);
            if (made) {
                this._scoped.delete(data.call);
                for (const handle of made) {
                    this._objects.delete(handle);
                }
            }
            return;
        }

        if (typeof data.release === 'number') {
            if (!versioned) {
                return;
            }
            this._objects.delete(data.release);
            return;
        }

        // A reply carries an id just as a request does, so the id alone does
        // not make this a request - `ops` does. It matters on a bus every peer
        // hears (sysend, or a BroadcastChannel with more than two ends): a
        // host overhears the replies meant for another peer's client, and
        // answering one draws an error carrying the same id, which the other
        // host answers in turn. Two tabs, one click, no end.
        if (typeof data.id !== 'number' || !Array.isArray(data.ops)) {
            return;
        }

        // a request this host cannot speak to is the one case that is worth
        // answering: the peer is waiting, and a silent drop looks like a hang
        if (!versioned) {
            this._post({ id: data.id, error: version_mismatch(data.rorpc) });
            return;
        }

        try {
            if (error) {
                throw error;
            }
            this._post({ id: data.id, result: await this._invoke(data) });
        } catch (thrown) {
            const failure = thrown instanceof Error ? thrown : new Error(String(thrown));
            this._post({ id: data.id, error: failure });
        }
    }

    // -------------------------------------------------------------------------
    // walk the recorded chain against the root in one go, so a whole
    // expression costs a single message rather than one per step. `object` is
    // the receiver a call binds to (whatever the value was read off of) and
    // `value` is the running result.
    // -------------------------------------------------------------------------
    // a predicate's answer, refused loudly when it is not a boolean: a Proxy
    // trap written here by mistake would return a value, and every value is
    // truthy, which would quietly permit everything
    private _permits(which: 'get' | 'set', key: string): boolean {
        const rule = this._options[which] ?? safe_key;
        const allowed = rule(key);
        if (typeof allowed !== 'boolean') {
            throw internal(`${which}() must answer true or false, not ${typeof allowed}`);
        }
        return allowed;
    }

    private async _invoke(data: Message): Promise<unknown> {
        const root = await this._root(data);
        const ops = data.ops ?? [];
        let object: unknown = root;
        let value: unknown = root;
        let label =
            typeof data.object === 'number' ? `#${data.object}` : (data.namespace ?? '');
        for (const op of ops) {
            if (op.type === 'get') {
                if (!this._permits('get', op.key)) {
                    throw key_denied(label, op.key, 'read');
                }
                object = value;
                value = (value as Record<string, unknown> | null | undefined)?.[op.key];
                label += `.${op.key}`;
            } else if (op.type === 'describe') {
                // §8.3: terminal. What comes back is a description, not the
                // value, so a step after it would have nothing to run against
                if (op !== ops[ops.length - 1]) {
                    throw invalid_request('describe must be the last op in a chain');
                }
                return this._describe(value, label);
            } else if (op.type === 'set') {
                if (!this._permits('set', op.key)) {
                    throw key_denied(label, op.key, 'write');
                }
                if (value === null || value === undefined) {
                    throw cannot_set(label, op.key, value);
                }
                (value as Record<string, unknown>)[op.key] = op.value;
                label += `.${op.key}`;
                // the reply carries nothing back. A set is always the last
                // step - `a.b = c` evaluates to `c`, so no proxy is left to
                // chain onto - and sending the assigned value back would
                // serialize it, handing out a handle for anything with
                // methods in it that nothing would ever release
                value = undefined;
                object = undefined;
            } else if (op.type === 'call') {
                if (typeof value !== 'function') {
                    throw not_a_function(label);
                }
                value = await (value as (...args: unknown[]) => unknown).apply(
                    object,
                    op.args
                );
                // a result is not bound to anything until it is read off
                // something else, so the next call has no receiver
                object = undefined;
                label += '()';
            } else {
                // a later minor may define ops this host has never heard of.
                // Treating one as a call was how this used to end, and it
                // reported that the value was not a function - true, and about
                // a question nobody asked
                const { type } = op as unknown as { type: unknown };
                throw invalid_request(`unknown op '${String(type)}' at ${label}`);
            }
        }
        return value;
    }

    // Introspection is OPTIONAL in RO/RPC: a host that will not do it says so
    // with a code, rather than answering an empty list that reads as "no
    // methods". The key policy applies here too - a name a chain may not read
    // is a name this must not hand out, or `dir` becomes the way to find the
    // keys `get` refuses.
    private _describe(value: unknown, label: string): Description {
        const rule = this._options.dir ?? describe;
        const listed = rule.call(this, value);
        if (listed === null || listed === undefined) {
            throw no_introspection(label || 'this value');
        }
        if (!Array.isArray(listed?.methods) || !Array.isArray(listed?.properties)) {
            throw internal('dir() must answer { methods, properties } or null');
        }
        const allowed = <T extends { name: string }>(entries: T[]): T[] =>
            entries.filter(entry => this._permits('get', entry.name));
        return {
            methods: allowed(listed.methods),
            properties: allowed(listed.properties)
        };
    }

    // -------------------------------------------------------------------------
    private async _root(data: Message): Promise<unknown> {
        if (typeof data.object === 'number') {
            if (!this._objects.has(data.object)) {
                throw invalid_handle(data.object);
            }
            return this._objects.get(data.object);
        }
        if (typeof data.namespace !== 'string') {
            throw invalid_request('request has neither a module name nor a handle');
        }
        const module = await this._options.resolve(data.namespace);
        if (module === null || module === undefined) {
            throw unknown_module(data.namespace);
        }
        return module;
    }
}
