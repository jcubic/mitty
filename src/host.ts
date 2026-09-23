/*
 * Mitty - use main thread objects from inside a Web Worker
 *
 * Copyright (c) 2026 Jakub T. Jankiewicz <https://jakub.jankiewicz.org>
 * Released under MIT license
 */
import {
    decode_error,
    encode_error,
    invalid_handle,
    is_error_marker,
    is_function_marker,
    is_object_marker,
} from './protocol';
import type { Channel, ChannelListener, ObjectMarker, Op } from './types';
import { has_methods } from './values';

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
}

interface Message {
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
        return { __type__: 'object', __data__: [id] };
    }

    // -------------------------------------------------------------------------
    // drop a handle. Returns false if it was already gone.
    // -------------------------------------------------------------------------
    public release(handle: ObjectMarker | number): boolean {
        const id = typeof handle === 'number' ? handle : handle?.__data__?.[0];
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
    }

    // -------------------------------------------------------------------------
    private _post(data: Message): void {
        this._channel.postMessage(this._serialize(data));
    }

    // -------------------------------------------------------------------------
    private _serialize(data: Message): string {
        // bound here because the replacer has to be a plain function - its
        // `this` is the holder object, not the Host
        const hook = this._options.serialize?.bind(this);
        const wanted = this._options.remote ?? has_methods;
        const remote = this.remote.bind(this);
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
                return encode_error(raw);
            }
            const result = hook ? hook(raw) : raw;
            if (result !== raw) {
                // the hook decided; it is the one place that can override
                // both the default and a `remote` predicate
                return result;
            }
            if (wanted(raw)) {
                return remote(raw);
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
                    const [id, length] = value.__data__;
                    return this._callback(id, length);
                }
                if (is_object_marker(value)) {
                    const [id] = value.__data__;
                    if (!this._objects.has(id)) {
                        deferred = deferred ?? invalid_handle(id);
                        return undefined;
                    }
                    return this._objects.get(id);
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
    private _callback(id: number, length: number) {
        return (...args: unknown[]): Promise<unknown> => {
            const call = ++this._call_id;
            return new Promise((resolve, reject) => {
                this._pending.set(call, { resolve, reject });
                // trim to the declared arity: callers like jQuery pass extras
                // (event objects, indexes) that usually cannot be serialized
                this._post({ callback: id, call, args: args.slice(0, length) });
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

        // a client callback finished - `callback` is absent, which is what
        // distinguishes a result coming back from an invocation going out
        if (typeof data.call === 'number' && data.callback === undefined) {
            const entry = this._pending.get(data.call);
            if (entry) {
                this._pending.delete(data.call);
                if (data.error) {
                    entry.reject(data.error);
                } else {
                    entry.resolve(data.result);
                }
            }
            return;
        }

        if (typeof data.release === 'number') {
            this._objects.delete(data.release);
            return;
        }

        if (typeof data.id !== 'number') {
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
    private async _invoke(data: Message): Promise<unknown> {
        const root = await this._root(data);
        const ops = data.ops ?? [];
        let object: unknown = root;
        let value: unknown = root;
        let label =
            typeof data.object === 'number' ? `#${data.object}` : (data.namespace ?? '');
        for (const op of ops) {
            if (op.type === 'get') {
                object = value;
                value = (value as Record<string, unknown> | null | undefined)?.[op.key];
                label += `.${op.key}`;
            } else {
                if (typeof value !== 'function') {
                    throw new TypeError(`mitty: ${label} is not a function`);
                }
                value = await (value as (...args: unknown[]) => unknown).apply(
                    object,
                    op.args,
                );
                // a result is not bound to anything until it is read off
                // something else, so the next call has no receiver
                object = undefined;
                label += '()';
            }
        }
        return value;
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
            throw new Error('mitty: request has neither a module name nor a handle');
        }
        const module = await this._options.resolve(data.namespace);
        if (module === null || module === undefined) {
            throw new Error(`mitty: unknown module '${data.namespace}'`);
        }
        return module;
    }
}
