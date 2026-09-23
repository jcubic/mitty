/*
 * Mitty - use main thread objects from inside a Web Worker
 *
 * Copyright (c) 2026 Jakub T. Jankiewicz <https://jakub.jankiewicz.org>
 * Released under MIT license
 */
import {
    HANDLE,
    decode_error,
    encode_error,
    is_error_marker,
    is_object_marker,
} from './protocol';
import type { Channel, ChannelListener, Client, Op, Remote } from './types';

// what a chain is rooted at: a module looked up by name, or an object that
// stayed behind on the host
interface Root {
    namespace?: string;
    object?: number;
}

interface ChainInfo {
    root: Root;
    ops: Op[];
}

interface Message {
    id?: number;
    callback?: number;
    call?: number;
    args?: unknown[];
    result?: unknown;
    error?: unknown;
    release?: number;
}

type Callback = (...args: unknown[]) => unknown;

const PROMISE_METHODS = ['then', 'catch', 'finally'];

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
export function connect(channel: Channel): Client {
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

    function serialize(data: unknown): string {
        return JSON.stringify(data, function (this: Record<string, unknown>, key, value) {
            // the raw holder value, before JSON.stringify applied toJSON() -
            // a chain proxy answers every property access, toJSON included
            const raw = this[key];
            if (raw instanceof Error) {
                return encode_error(raw);
            }
            const chain = chain_info(raw);
            if (chain) {
                if (chain.ops.length || typeof chain.root.object !== 'number') {
                    throw new TypeError(
                        'mitty: cannot send an unresolved remote chain - await it first',
                    );
                }
                // a handle can go back to the host, which swaps it for the
                // object it stands for
                return { __type__: 'object', __data__: [chain.root.object] };
            }
            if (typeof raw === 'function') {
                let id = callback_ids.get(raw as Callback);
                if (id === undefined) {
                    id = ++callback_id;
                    callback_ids.set(raw as Callback, id);
                    callbacks.set(id, raw as Callback);
                }
                return { __type__: 'function', __data__: [id, raw.length] };
            }
            return value;
        });
    }

    function unserialize(text: string): Message {
        return JSON.parse(text, (_key, value) => {
            if (is_object_marker(value)) {
                // a handle to something on the host - make it a chain rooted
                // there rather than handing back the marker itself
                return make_chain({ object: value.__data__[0] });
            }
            if (is_error_marker(value)) {
                return decode_error(value);
            }
            return value;
        }) as Message;
    }

    function post(data: Message): void {
        channel.postMessage(serialize(data));
    }

    async function run_callback(data: Message): Promise<void> {
        const fn = callbacks.get(data.callback as number);
        if (!fn || typeof data.call !== 'number') {
            return;
        }
        try {
            post({ call: data.call, result: await fn(...(data.args ?? [])) });
        } catch (error) {
            post({ call: data.call, error });
        }
    }

    const listener: ChannelListener = event => {
        let data: Message;
        try {
            data = unserialize(event.data);
        } catch {
            return;
        }
        if (typeof data.callback === 'number') {
            void run_callback(data);
            return;
        }
        if (typeof data.id !== 'number') {
            return;
        }
        const entry = pending.get(data.id);
        if (!entry) {
            return;
        }
        pending.delete(data.id);
        if (data.error) {
            entry.reject(data.error);
        } else {
            entry.resolve(data.result);
        }
    };

    channel.addEventListener('message', listener);

    function call(root: Root, ops: Op[]): Promise<unknown> {
        return new Promise((resolve, reject) => {
            const id = ++rpc_id;
            let payload: string;
            try {
                payload = serialize({ id, ...root, ops });
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

    // -------------------------------------------------------------------------
    // Records property accesses and calls without touching the channel. The
    // whole chain is sent once, when something awaits it.
    // -------------------------------------------------------------------------
    function make_chain(root: Root, ops: Op[] = []): Remote {
        const target = function () {} as unknown as Remote;
        return new Proxy(target, {
            apply(_target, _this_arg, args: unknown[]) {
                return make_chain(root, [...ops, { type: 'call', args }]);
            },
            get(_target, key) {
                if (key === HANDLE) {
                    return { root, ops };
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
                return make_chain(root, [...ops, { type: 'get', key }]);
            },
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
        },
    };
}
