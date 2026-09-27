/*
 * Conformance with rpc/SPEC.md — RO/RPC 1.0.
 *
 * These assert on the bytes, not on behaviour: the protocol is the contract
 * between implementations, and an implementation that behaves correctly while
 * emitting the wrong wire format is not interoperable with anything.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Host, connect, is_remote, safe_key } from '../src/index';
import type { Channel, ChannelListener, HostOptions } from '../src/index';

const VERSION = '1.0';

// records what each end puts on the wire, and lets a test inject a raw frame
class Wire implements Channel {
    readonly sent: string[] = [];
    peer!: Wire;
    private _listeners = new Set<ChannelListener>();
    postMessage(message: string) {
        this.sent.push(message);
        this.peer.receive(message);
    }
    addEventListener(_type: 'message', listener: ChannelListener) {
        this._listeners.add(listener);
    }
    removeEventListener(_type: 'message', listener: ChannelListener) {
        this._listeners.delete(listener);
    }
    receive(message: string) {
        for (const listener of [...this._listeners]) {
            queueMicrotask(() => listener({ data: message }));
        }
    }
}

const open: Array<() => void> = [];

afterEach(() => {
    while (open.length) {
        open.pop()?.();
    }
});

function wired(options: Omit<HostOptions, 'channel'>) {
    const host_wire = new Wire();
    const client_wire = new Wire();
    host_wire.peer = client_wire;
    client_wire.peer = host_wire;
    const host = new Host({ channel: host_wire, ...options });
    const client = connect(client_wire);
    open.push(() => {
        host.close();
        client.close();
    });
    return {
        host,
        client,
        // what the host sent / what the client sent
        replies: host_wire.sent,
        requests: client_wire.sent,
        // deliver a frame to the host as if a peer had sent it
        inject: (frame: unknown) => client_wire.postMessage(JSON.stringify(frame)),
        // and the other way: a frame the client receives as if from a host
        inject_reply: (frame: unknown) => host_wire.postMessage(JSON.stringify(frame))
    };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const frames = (raw: string[]): any[] => raw.map(text => JSON.parse(text));
// Array#at is ES2022 and this package targets ES2020
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const last = (raw: string[]): any => frames(raw)[raw.length - 1];

// -----------------------------------------------------------------------------
describe('§5 protocol version', () => {
    it('puts rorpc on every message either end sends', async () => {
        const { client, replies, requests } = wired({
            resolve: () => ({ run: (fn: () => unknown) => fn(), value: 1 })
        });
        await client.require('m').run(() => 1);
        client.require('m').value = 2;
        await settle();

        const all = [...frames(replies), ...frames(requests)];
        // request, reply, callback invocation, callback result, set, its reply
        expect(all.length).toBeGreaterThanOrEqual(5);
        for (const frame of all) {
            expect(frame.rorpc).toBe(VERSION);
        }
    });

    it('puts rorpc on a release, which expects no reply', async () => {
        const { client, requests } = wired({
            resolve: () => ({ get: () => ({ run: () => 1 }) })
        });
        const handle = await client.require('m').get();
        client.release(handle);
        await settle();
        const release = frames(requests).find(frame => 'release' in frame);
        expect(release.rorpc).toBe(VERSION);
    });

    it('§5.2 refuses a request with no version', async () => {
        const { inject, replies } = wired({ resolve: () => ({ ok: () => 1 }) });
        inject({ id: 1, namespace: 'm', ops: [{ type: 'get', key: 'ok' }] });
        await settle();
        expect(frames(replies)[0].error.__data__.code).toBe(-32012);
    });

    it('§5.2 refuses a request from a different major', async () => {
        const { inject, replies } = wired({ resolve: () => ({ ok: () => 1 }) });
        inject({ rorpc: '2.0', id: 1, namespace: 'm', ops: [] });
        await settle();
        expect(frames(replies)[0].error.__data__.code).toBe(-32012);
    });

    it('§5.1 accepts a higher minor of the same major', async () => {
        const { inject, replies } = wired({ resolve: () => ({ ok: () => 'yes' }) });
        inject({
            rorpc: '1.7',
            id: 1,
            namespace: 'm',
            ops: [
                { type: 'get', key: 'ok' },
                { type: 'call', args: [] }
            ]
        });
        await settle();
        expect(frames(replies)[0].result).toBe('yes');
    });

    it('§5.2 stays silent for an unversioned message that is not a request', async () => {
        // replying to an overheard reply is what starts a storm between peers
        const { inject, replies } = wired({ resolve: () => ({}) });
        inject({ id: 1, result: 'overheard' });
        inject({ release: 99 });
        await settle();
        expect(replies).toEqual([]);
    });
});

// -----------------------------------------------------------------------------
describe('§6 markers carry a named object', () => {
    it('§6.1 an object marker names its handle', async () => {
        const { client, replies } = wired({
            resolve: () => ({ get: () => ({ run: () => 1 }) })
        });
        await client.require('m').get();
        const reply = last(replies);
        expect(reply.result).toEqual({
            __type__: 'object',
            __data__: { handle: 1, repr: '#<Object>' }
        });
    });

    it('§6.1.1 the Host builds repr, and the Client sends it back to no one', async () => {
        const { client, requests } = wired({
            resolve: () => ({
                get: () => ({ run: () => 1 }),
                same: (other: unknown) => typeof other === 'object'
            }),
            repr: () => '#<thing>'
        });
        const handle = await client.require('m').get();
        expect(String(handle)).toBe('#<thing>');
        await client.require('m').same(handle);
        const request = frames(requests).filter(
            frame => 'ops' in frame && frame.ops.length === 2
        )[1];
        // §6.1.1: Client to Host is the integer alone
        expect(request.ops[1].args[0]).toEqual({
            __type__: 'object',
            __data__: { handle: 1 }
        });
    });

    it('§6.1.1 a Client works against a Host that sends no repr', async () => {
        // what a 1.0 Host looks like from here. The real host never answers,
        // so the injected reply is the only one - and the chain has to be
        // awaited before it is sent at all, hence the settle()
        const { client, inject_reply } = wired({
            resolve: () => ({ get: () => new Promise(() => {}) })
        });
        const pending = Promise.resolve(client.require('m').get());
        await settle();
        inject_reply({
            rorpc: VERSION,
            id: 1,
            result: { __type__: 'object', __data__: { handle: 7 } }
        });
        const handle = await pending;
        expect(is_remote(handle)).toBe(true);
        expect(String(handle)).toBe('#<object>');
    });

    it('§6.2 a function marker names its callback and arity', async () => {
        const { client, requests } = wired({
            resolve: () => ({
                run: (fn: (a: unknown, b: unknown) => unknown) => fn(1, 2)
            })
        });
        await client.require('m').run((a: unknown) => a);
        const request = frames(requests).filter(frame => 'ops' in frame)[0];
        expect(request.ops[1].args[0]).toEqual({
            __type__: 'function',
            __data__: { callback: 1, arity: 1 }
        });
    });

    it('§6.3 an error marker names its parts', async () => {
        const { client, replies } = wired({
            resolve: () => ({
                boom: () => {
                    throw new TypeError('kaboom');
                }
            })
        });
        await expect(client.require('m').boom()).rejects.toThrow('kaboom');
        const { __data__ } = last(replies).error;
        expect(__data__.name).toBe('TypeError');
        expect(__data__.message).toBe('kaboom');
        expect(typeof __data__.stack).toBe('string');
    });

    it('§6.3 omits stack rather than sending null', async () => {
        const { client, replies } = wired({
            resolve: () => ({
                boom: () => {
                    const error = new Error('no stack here');
                    error.stack = undefined;
                    throw error;
                }
            })
        });
        await expect(client.require('m').boom()).rejects.toThrow('no stack here');
        const { __data__ } = last(replies).error;
        expect('stack' in __data__).toBe(false);
    });

    it('a handle sent back names the same member', async () => {
        const { client, requests } = wired({
            resolve: () => ({
                get: () => ({ run: () => 1 }),
                same: (value: unknown) => typeof value === 'object'
            })
        });
        const handle = await client.require('m').get();
        expect(await client.require('m').same(handle)).toBe(true);
        const request = last(requests);
        expect(request.ops[1].args[0]).toEqual({
            __type__: 'object',
            __data__: { handle: 1 }
        });
    });
});

// -----------------------------------------------------------------------------
describe('§8.3 dir describes a value', () => {
    it('§8.3 answers one entry per method, with what is known of the params', async () => {
        const { inject, replies } = wired({
            resolve: () => ({
                // the parameter lists are the point: find declares one, and
                // append declares one before a default, so both report 1
                thing: {
                    find: (selector: string) => selector,
                    append: (node: unknown, mode = 'after') => [node, mode]
                }
            })
        });
        inject({
            rorpc: VERSION,
            id: 1,
            namespace: 'm',
            ops: [{ type: 'get', key: 'thing' }, { type: 'dir' }]
        });
        await settle();
        expect(frames(replies)[0].result).toEqual([
            { name: 'append', params: { arity: { required: 1 } } },
            { name: 'find', params: { arity: { required: 1 } } }
        ]);
    });

    it('§8.3 refuses a dir that is not the last op', async () => {
        const { inject, replies } = wired({ resolve: () => ({ thing: { a: () => 1 } }) });
        inject({
            rorpc: VERSION,
            id: 1,
            namespace: 'm',
            ops: [{ type: 'dir' }, { type: 'get', key: 'thing' }]
        });
        await settle();
        expect(frames(replies)[0].error.__data__.code).toBe(-32600);
    });

    it('§8.2 an op type the host does not know is refused, not guessed at', async () => {
        // a later minor may define ops this host has never heard of. Falling
        // through to "call" makes the failure say something untrue - the
        // value is not a function, but that was never what was asked
        const { inject, replies } = wired({ resolve: () => ({ thing: { a: () => 1 } }) });
        inject({
            rorpc: VERSION,
            id: 1,
            namespace: 'm',
            ops: [{ type: 'get', key: 'thing' }, { type: 'sniff' }]
        });
        await settle();
        expect(frames(replies)[0].error.__data__.code).toBe(-32600);
        expect(frames(replies)[0].error.__data__.message).toMatch(/sniff/);
    });

    it('§8.3 a host that does not introspect fails rather than answering nothing', async () => {
        const { inject, replies } = wired({
            resolve: () => ({ thing: { a: () => 1 } }),
            dir: () => null
        });
        inject({
            rorpc: VERSION,
            id: 1,
            namespace: 'm',
            ops: [{ type: 'get', key: 'thing' }, { type: 'dir' }]
        });
        await settle();
        expect(frames(replies)[0].error.__data__.code).toBe(-32014);
    });

    it('§8.3 does not name what the key policy hides', async () => {
        const { inject, replies } = wired({
            resolve: () => ({ thing: { open: () => 1, secret: () => 2 } }),
            get: (key: string) => safe_key(key) && key !== 'secret'
        });
        inject({
            rorpc: VERSION,
            id: 1,
            namespace: 'm',
            ops: [{ type: 'get', key: 'thing' }, { type: 'dir' }]
        });
        await settle();
        expect(frames(replies)[0].result.map((m: { name: string }) => m.name)).toEqual([
            'open'
        ]);
    });
});

// -----------------------------------------------------------------------------
describe('§9.2 error codes', () => {
    it('-32601 for a module that does not resolve', async () => {
        const { client, replies } = wired({ resolve: () => null });
        await expect(client.require('ghost').x()).rejects.toThrow();
        expect(last(replies).error.__data__.code).toBe(-32601);
    });

    it('-32602 for a handle that is gone', async () => {
        const { client, replies } = wired({
            resolve: () => ({ get: () => ({ run: () => 1 }) })
        });
        const handle = await client.require('m').get();
        client.release(handle);
        await expect(handle.run()).rejects.toThrow();
        expect(last(replies).error.__data__.code).toBe(-32602);
    });

    it('-32010 for a call against something that is not a function', async () => {
        const { client, replies } = wired({ resolve: () => ({ plain: 42 }) });
        await expect(client.require('m').plain()).rejects.toThrow();
        expect(last(replies).error.__data__.code).toBe(-32010);
    });

    it('-32011 for a set against null', async () => {
        const { client, replies } = wired({ resolve: () => ({ nothing: null }) });
        client.require('m').nothing.oops = 1;
        await settle();
        expect(last(replies).error.__data__.code).toBe(-32011);
    });

    it('-32600 for a request naming neither a module nor a handle', async () => {
        const { inject, replies } = wired({ resolve: () => ({}) });
        inject({ rorpc: VERSION, id: 1, ops: [{ type: 'get', key: 'x' }] });
        await settle();
        expect(frames(replies)[0].error.__data__.code).toBe(-32600);
    });

    it('-32000 when the application itself throws', async () => {
        const { client, replies } = wired({
            resolve: () => ({
                boom: () => {
                    throw new Error('application said no');
                }
            })
        });
        await expect(client.require('m').boom()).rejects.toThrow();
        expect(last(replies).error.__data__.code).toBe(-32000);
    });

    it('passes an application code of its own through', async () => {
        const { client, replies } = wired({
            resolve: () => ({
                boom: () => {
                    const error = new Error('mine');
                    (error as Error & { code: number }).code = 4711;
                    throw error;
                }
            })
        });
        await expect(client.require('m').boom()).rejects.toThrow();
        expect(last(replies).error.__data__.code).toBe(4711);
    });

    it('gives the caught error its code, so it need not be parsed out of a message', async () => {
        // the gap this closes: a Node ENOENT crosses without its own `code`
        const { client } = wired({ resolve: () => null });
        const error = await client
            .require('ghost')
            .x()
            .catch((e: Error & { code?: number }) => e);
        expect(error.code).toBe(-32601);
    });
});

// -----------------------------------------------------------------------------
// A handle made while a callback invocation is prepared belongs to that call.
// The host releases it when the call is complete, so a callback that receives
// objects does not fill the handle table.
describe('§10.4 handles that belong to one call', () => {
    // the shape of every each()/forEach() API: an index, and also the element
    const each = (items: unknown[]) => ({
        each: (fn: (...a: unknown[]) => unknown) =>
            Promise.all(items.map((item, index) => fn(index, item)))
    });
    const thing = (name: string) => ({ name, describe: () => name });

    it('releases the handle when the call is complete', async () => {
        const { host, client, replies } = wired({
            resolve: () => each([thing('one')])
        });
        await client
            .require('m')
            .each((_index: unknown, item: { name: string }) => item.name);
        await settle();
        const invocation = frames(replies).find(frame => 'callback' in frame);
        const handle = invocation.args[1].__data__.handle;
        expect(typeof handle).toBe('number');
        // already gone: the host released it, not the client
        expect(host.release(handle)).toBe(false);
    });

    it('keeps the table small over many calls', async () => {
        const items = Array.from({ length: 50 }, (_, i) => thing(`item ${i}`));
        const { host, client, replies } = wired({ resolve: () => each(items) });
        // two real parameters, so every element is sent and a handle is made
        // for it. `item` is compared, never read, so no chain is triggered
        const callback = (index: unknown, item: unknown) => (item === null ? -1 : index);
        expect(callback.length).toBe(2);
        await client.require('m').each(callback);
        await settle();

        // the scenario is only meaningful if handles were really made
        const made = replies.join('').split('"__type__":"object"').length - 1;
        expect(made).toBe(50);
        // and every one of them has been released
        const alive = Array.from({ length: 60 }, (_, i) => i + 1).filter(id =>
            host.release(id)
        );
        expect(alive).toEqual([]);
    });

    it('leaves a handle the client already held alone', async () => {
        const kept = thing('kept');
        const { host, client } = wired({
            resolve: () => ({
                get: () => kept,
                run: (fn: (...a: unknown[]) => unknown, value: unknown) => fn(value)
            })
        });
        const handle = await client.require('m').get();
        const id = client.handle(handle);
        // the same object goes to a callback, but its handle was not made here
        await client.require('m').run((value: unknown) => typeof value, handle);
        await settle();
        expect(await handle.describe()).toBe('kept');
        expect(host.release(id)).toBe(true);
    });

    it('leaves the result of an ordinary request alone', async () => {
        const { host, client } = wired({ resolve: () => ({ get: () => thing('r') }) });
        const handle = await client.require('m').get();
        await settle();
        expect(host.release(client.handle(handle))).toBe(true);
    });
});

// -----------------------------------------------------------------------------
describe('§11.2 arity', () => {
    const three = { each: (fn: (...a: unknown[]) => unknown) => fn(1, 2, 3) };

    it('declares what the callback takes', async () => {
        const { client, requests } = wired({ resolve: () => three });
        await client.require('m').each((a: unknown, b: unknown) => [a, b]);
        const { __data__ } = frames(requests).filter(f => 'ops' in f)[0].ops[1].args[0];
        expect(__data__).toEqual({ callback: 1, arity: 2 });
    });

    it('the host sends no more than that', async () => {
        const { client } = wired({ resolve: () => three });
        expect(
            await client.require('m').each((a: unknown, b: unknown) => [a, b])
        ).toEqual([1, 2]);
    });

    it('a host honours an absent arity on a raw frame', async () => {
        // another implementation may leave it out; this one never does
        const { inject, replies } = wired({ resolve: () => three });
        inject({
            rorpc: VERSION,
            id: 1,
            namespace: 'm',
            ops: [
                { type: 'get', key: 'each' },
                {
                    type: 'call',
                    args: [{ __type__: 'function', __data__: { callback: 7 } }]
                }
            ]
        });
        await settle();
        const invocation = frames(replies).find(frame => 'callback' in frame);
        expect(invocation.args).toEqual([1, 2, 3]);
    });
});

// The cost of taking the count from Function.length. Both of these are the
// documented limitation, not an accident - see the README.
describe('§11.2 what Function.length cannot express', () => {
    it('never fills an optional parameter', async () => {
        const { client } = wired({
            resolve: () => ({ call: (fn: (...a: unknown[]) => unknown) => fn('a', 'b') })
        });
        // length stops at the first default, so the arity is 1
        const result = await client
            .require('m')
            .call((first: string, second = 'DEFAULT') => `${first}/${second}`);
        expect(result).toBe('a/DEFAULT');
    });

    it('gives a rest-only callback nothing', async () => {
        const { client } = wired({
            resolve: () => ({ call: (fn: (...a: unknown[]) => unknown) => fn(1, 2, 3) })
        });
        // (...args) reports a length of 0
        expect(await client.require('m').call((...args: unknown[]) => args)).toEqual([]);
    });
});

// -----------------------------------------------------------------------------
// §13.2 leaves the key policy to the implementation. This is mitty's, and it is
// on by default: a chain may not walk to a prototype object, because from there
// a `set` reaches every object in the program.
describe('§13.2 which keys a chain may walk', () => {
    const target = () => ({ name: 'ok', nested: { deep: 1 } });

    it.each(['__proto__', 'constructor', 'prototype'])(
        'refuses to read %s',
        async key => {
            const { client, replies } = wired({ resolve: target });
            await expect(client.require('m')[key].anything()).rejects.toThrow(
                /not permitted/i
            );
            expect(last(replies).error.__data__.code).toBe(-32013);
        }
    );

    it.each(['__proto__', 'constructor', 'prototype'])(
        'refuses to write %s',
        async key => {
            const { client, replies } = wired({ resolve: target });
            client.require('m')[key] = 'nope';
            await settle();
            expect(last(replies).error.__data__.code).toBe(-32013);
        }
    );

    // the attack the deny-list is actually for: reach a prototype through an
    // ordinary-looking chain, then write to it
    it('stops a chain from polluting every object in the program', async () => {
        const { client } = wired({ resolve: target });
        client.require('m').constructor.prototype.polluted = 'yes';
        await settle();
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
        expect(Object.prototype).not.toHaveProperty('polluted');
    });

    it('lets ordinary keys through', async () => {
        const { client } = wired({ resolve: target });
        expect(await client.require('m').name).toBe('ok');
        expect(await client.require('m').nested.deep).toBe(1);
    });

    it('takes a rule of its own, which replaces the default', async () => {
        const { client } = wired({
            resolve: target,
            get: key => key !== 'name'
        });
        await expect(client.require('m').name).rejects.toThrow(/not permitted/i);
        expect(await client.require('m').nested.deep).toBe(1);
    });

    it('composes with safe_key when you want both', async () => {
        const { client } = wired({
            resolve: target,
            get: key => safe_key(key) && key !== 'nested'
        });
        expect(await client.require('m').name).toBe('ok');
        await expect(client.require('m').nested).rejects.toThrow(/not permitted/i);
        await expect(client.require('m').__proto__.x()).rejects.toThrow(/not permitted/i);
    });

    it('makes a host read-only with set: () => false', async () => {
        const object = { label: 'ok' };
        const { client, replies } = wired({ resolve: () => object, set: () => false });
        client.require('m').label = 'changed';
        await settle();
        expect(object.label).toBe('ok');
        expect(last(replies).error.__data__.code).toBe(-32013);
    });

    // a `require()` result is typed as callable, so TypeScript resolves .name
    // and .length to Function's own read-only ones. It works at runtime - the
    // set trap intercepts before the target is touched - but the type rejects
    // it unless the handle has been awaited first
    it('assigns name on an awaited handle', async () => {
        // the child needs a method, or it is copied rather than kept and the
        // assignment would only touch a local copy
        const object = { child: { name: 'before', describe: () => 'child' } };
        const { client } = wired({ resolve: () => object });
        const child = await client.require('m').child;
        child.name = 'after';
        await settle();
        expect(object.child.name).toBe('after');
    });

    // these are predicates, not Proxy traps. Someone who writes one as a trap
    // would return a value, and every value is truthy - a silent allow-all
    it('refuses a rule that answers with something other than true or false', async () => {
        const { client, replies } = wired({
            resolve: target,
            get: (() => 'not a boolean') as unknown as (k: string) => boolean
        });
        await expect(client.require('m').name).rejects.toThrow(/true or false/i);
        expect(last(replies).error.__data__.code).toBe(-32603);
    });
});

// -----------------------------------------------------------------------------
// A peer is not required to be well behaved. §6.3 and §6.2 say what a marker
// holds; a receiver that trusts it without looking hands the caller nonsense.
describe('markers that do not keep to the spec', () => {
    it('§6.3 makes a real Error out of a marker with the wrong types', async () => {
        // a host that never answers, so the crafted reply is the only one
        const { client, inject_reply } = wired({ resolve: () => new Promise(() => {}) });
        const pending = client.require('m').thing();
        inject_reply({
            rorpc: VERSION,
            id: 1,
            error: { __type__: 'error', __data__: { name: 42, message: { a: 1 } } }
        });
        const error = await pending.catch((e: Error) => e);
        expect(error).toBeInstanceOf(Error);
        expect(error.name).toBe('Error');
        expect(error.message).toBe('');
    });

    it('§6.2 ignores a negative arity instead of dropping the last argument', async () => {
        // slice(0, -1) would quietly send every argument but the last
        const { inject, replies } = wired({
            resolve: () => ({ each: (fn: (...a: unknown[]) => unknown) => fn(1, 2, 3) })
        });
        inject({
            rorpc: VERSION,
            id: 1,
            namespace: 'm',
            ops: [
                { type: 'get', key: 'each' },
                {
                    type: 'call',
                    args: [{ __type__: 'function', __data__: { callback: 7, arity: -1 } }]
                }
            ]
        });
        await settle();
        expect(frames(replies).find(f => 'callback' in f).args).toEqual([1, 2, 3]);
    });

    it('§6.2 ignores an arity that is not a whole number', async () => {
        const { inject, replies } = wired({
            resolve: () => ({ each: (fn: (...a: unknown[]) => unknown) => fn(1, 2, 3) })
        });
        inject({
            rorpc: VERSION,
            id: 1,
            namespace: 'm',
            ops: [
                { type: 'get', key: 'each' },
                {
                    type: 'call',
                    args: [
                        { __type__: 'function', __data__: { callback: 7, arity: 1.5 } }
                    ]
                }
            ]
        });
        await settle();
        expect(frames(replies).find(f => 'callback' in f).args).toEqual([1, 2, 3]);
    });

    it('§6.2 still honours a well-formed arity, zero included', async () => {
        for (const [arity, expected] of [
            [0, []],
            [2, [1, 2]]
        ] as Array<[number, unknown[]]>) {
            const { inject, replies } = wired({
                resolve: () => ({
                    each: (fn: (...a: unknown[]) => unknown) => fn(1, 2, 3)
                })
            });
            inject({
                rorpc: VERSION,
                id: 1,
                namespace: 'm',
                ops: [
                    { type: 'get', key: 'each' },
                    {
                        type: 'call',
                        args: [{ __type__: 'function', __data__: { callback: 7, arity } }]
                    }
                ]
            });
            await settle();
            expect(frames(replies).find(f => 'callback' in f).args).toEqual(expected);
        }
    });
});
