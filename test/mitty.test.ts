import { afterEach, describe, expect, it } from 'vitest';
import type { Description, Host, HostOptions } from '../src/index';
// aliased: mitty's describe() and vitest's describe() share a name
import { CODES, describe as describe_value, dir, is_remote } from '../src/index';
import { cleanup, module_pair, pair } from './helpers';

afterEach(() => {
    cleanup();
});

class Counter {
    private _n = 0;
    increment(by = 1) {
        this._n += by;
        return this;
    }
    get value() {
        return this._n;
    }
    label(prefix: string) {
        return `${prefix}: ${this._n}`;
    }
}

describe('modules', () => {
    it('calls a function on a resolved module', async () => {
        const { client } = module_pair('math', {
            add: (a: number, b: number) => a + b
        });
        expect(await client.require('math').add(2, 3)).toBe(5);
    });

    it('awaits async functions on the host', async () => {
        const { client } = module_pair('math', {
            slow: async (n: number) => n * 2
        });
        expect(await client.require('math').slow(21)).toBe(42);
    });

    it('resolves a whole property chain in one round trip', async () => {
        const { client } = module_pair('app', {
            nested: { deep: { value: 42, greet: (n: string) => `hi ${n}` } }
        });
        const { require } = client;
        expect(await require('app').nested.deep.value).toBe(42);
        expect(await require('app').nested.deep.greet('bob')).toBe('hi bob');
    });

    it('rejects when resolve() returns null', async () => {
        const { client } = module_pair('known', {});
        await expect(client.require('nope').anything()).rejects.toThrow(/nope/);
    });

    it('rejects when calling a non-function', async () => {
        const { client } = module_pair('app', { value: 1 });
        await expect(client.require('app').value()).rejects.toThrow(/not a function/);
    });

    it('does not make a bare module reference thenable', () => {
        const { client } = module_pair('app', { a: 1 });
        const mod = client.require('app');
        expect(mod.then).toBeUndefined();
    });
});

describe('remote handles', () => {
    function counter_pair() {
        const counter = new Counter();
        const result = pair({
            resolve: (name: string) =>
                name === 'counter'
                    ? {
                          get: () => counter,
                          is_same: (other: unknown) => other === counter
                      }
                    : null,
            serialize(this: Host, value: unknown) {
                if (value instanceof Counter) {
                    return this.remote(value);
                }
                return value;
            }
        });
        return { ...result, counter };
    }

    it('exposes a class instance with methods over the channel', async () => {
        const { client } = counter_pair();
        const remote = await client.require('counter').get();
        expect(await remote.label('count')).toBe('count: 0');
    });

    it('operates on the real object, not a copy', async () => {
        const { client, counter } = counter_pair();
        const remote = await client.require('counter').get();
        await remote.increment(5);
        expect(counter.value).toBe(5);
    });

    it('chains methods on a handle in a single round trip', async () => {
        const { client } = counter_pair();
        const remote = await client.require('counter').get();
        expect(await remote.increment(3).increment(4).label('total')).toBe('total: 7');
    });

    it('reads getters on a handle', async () => {
        const { client } = counter_pair();
        const remote = await client.require('counter').get();
        await remote.increment(9);
        expect(await remote.value).toBe(9);
    });

    it('does not make a bare handle thenable', async () => {
        const { client } = counter_pair();
        const remote = await client.require('counter').get();
        expect(remote.then).toBeUndefined();
    });

    it('passes a handle back to the host as an argument', async () => {
        const { client } = counter_pair();
        const remote = await client.require('counter').get();
        expect(await client.require('counter').is_same(remote)).toBe(true);
    });

    it('refuses to serialize an unresolved chain as an argument', async () => {
        const { client } = counter_pair();
        const { require } = client;
        await expect(
            require('counter').is_same(require('counter').get())
        ).rejects.toThrow(/unresolved/i);
    });

    it('rejects a circular argument with a mitty error, not a JSON one', async () => {
        const { client } = module_pair('app', { echo: (value: unknown) => value });
        const circular: Record<string, unknown> = { name: 'selection' };
        circular.self = circular;
        await expect(client.require('app').echo(circular)).rejects.toThrow(
            /mitty: cannot send ops\.1\.args\.0 .*circular/
        );
    });

    it('names the host-side object smuggled in as an argument', async () => {
        // what jquery.terminal's echo() does to an awaitable proxy: it treats
        // it as a function, calls .bind(realJQuery)() on it, and the real
        // jQuery selection lands in the chain's call args
        const { client } = module_pair('app', { echo: (value: unknown) => value });
        class FnInit {
            self: unknown;
            constructor() {
                this.self = this;
            }
        }
        const selection = new FnInit();
        const echo = client.require('app').echo;
        await expect(echo.bind(selection)()).rejects.toThrow(/FnInit/);
    });

    it('rejects a bigint argument with a mitty error', async () => {
        const { client } = module_pair('app', { echo: (value: unknown) => value });
        await expect(client.require('app').echo(10n)).rejects.toThrow(
            /mitty: cannot send ops\.1\.args\.0 .*a bigint/
        );
    });

    it('blames the argument, not the inner property that closes the circle', async () => {
        const { client } = module_pair('app', { echo: (value: unknown) => value });
        const selection: Record<string, unknown> = { length: 1 };
        selection[0] = { nodeType: 1, nodeName: 'DIV', jQuery1: { terminal: selection } };
        const error = await client
            .require('app')
            .echo(selection)
            .catch((e: Error) => e);
        // the argument is what the caller can act on; the path to the edge
        // where JSON noticed the loop only tells them where it looked
        expect(error.message).toMatch(/cannot send ops\.1\.args\.0 across the channel/);
        expect(error.message).toContain('ops.1.args.0.0.jQuery1.terminal');
    });

    it('names a DOM node by its tag', async () => {
        const { client } = module_pair('app', { echo: (value: unknown) => value });
        const node: Record<string, unknown> = { nodeType: 1, nodeName: 'DIV' };
        node.parentNode = node;
        await expect(client.require('app').echo(node)).rejects.toThrow(
            /a circular DOM node <DIV>/
        );
    });

    it('lets a throwing toJSON report itself', async () => {
        // the value is not unsendable - the caller's own hook failed, and
        // relabelling that as a channel problem would send them looking in
        // the wrong place
        const { client } = module_pair('app', { echo: (value: unknown) => value });
        const hostile = {
            toJSON() {
                throw new Error('toJSON said no');
            }
        };
        await expect(client.require('app').echo(hostile)).rejects.toThrow(
            'toJSON said no'
        );
    });

    it('finds the circle in a structure larger than any fixed budget', async () => {
        const { client } = module_pair('app', { echo: (value: unknown) => value });
        // wide rather than deep - JSON.stringify recurses, and a deep enough
        // structure runs out of stack before anything here gets a say
        const root: Record<string, unknown> = {};
        for (let i = 0; i < 20000; i++) {
            root['sibling' + i] = { id: i, text: 'x'.repeat(16) };
        }
        root.loop = root;
        await expect(client.require('app').echo(root)).rejects.toThrow(
            /cannot send ops\.1\.args\.0 across the channel/
        );
    });
});

describe('is_remote', () => {
    it('tells a chain apart from an ordinary function', async () => {
        const { client } = module_pair('app', { thing: { method: () => 1 } });
        const chain = client.require('app').thing;
        // a chain is a function to `typeof`, which is what makes a library
        // duck-typing for a callable reach for .bind() or .call() on it
        expect(typeof chain).toBe('function');
        expect(is_remote(chain)).toBe(true);
        expect(is_remote(() => 1)).toBe(false);
        expect(is_remote({})).toBe(false);
        expect(is_remote(null)).toBe(false);
        expect(is_remote('handle')).toBe(false);
    });

    it('recognises a resolved handle', async () => {
        const { client } = module_pair('app', { thing: { method: () => 1 } });
        const handle = await client.require('app').thing;
        expect(is_remote(handle)).toBe(true);
    });

    it('works through the bare symbol, without importing mitty', async () => {
        // how a library that does not depend on mitty can still tell:
        // Symbol.for() means a second copy of the library agrees
        const { client } = module_pair('app', { thing: { method: () => 1 } });
        const chain = client.require('app').thing as unknown as Record<symbol, unknown>;
        expect(chain[Symbol.for('@jcubic/mitty/handle')]).toBeTruthy();
    });
});

describe('release', () => {
    function counter_pair() {
        const counter = new Counter();
        return pair({
            resolve: (name: string) =>
                name === 'counter' ? { get: () => counter } : null,
            serialize(this: Host, value: unknown) {
                return value instanceof Counter ? this.remote(value) : value;
            }
        });
    }

    it('invalidates a handle released from the client', async () => {
        const { client } = counter_pair();
        const remote = await client.require('counter').get();
        expect(await remote.value).toBe(0);
        client.release(remote);
        await expect(remote.value).rejects.toThrow(/handle/i);
    });

    it('invalidates a handle released from the host', () => {
        const { host } = counter_pair();
        const handle = host.remote(new Counter());
        host.release(handle);
        expect(host.release(handle)).toBe(false);
    });

    it('throws when releasing something that is not a handle', () => {
        const { client } = counter_pair();
        expect(() => client.release({} as never)).toThrow(/handle/i);
    });

    it('exposes the numeric handle id behind a proxy', async () => {
        const { client } = counter_pair();
        const remote = await client.require('counter').get();
        expect(typeof client.handle(remote)).toBe('number');
    });

    it('releases by id, so nothing needs to hold the proxy', async () => {
        const { client } = counter_pair();
        const remote = await client.require('counter').get();
        // this is what a FinalizationRegistry callback gets to keep
        const id = client.handle(remote);
        client.release(id);
        await expect(remote.value).rejects.toThrow(/handle/i);
    });

    it('throws when reading the handle of a module chain', () => {
        const { client } = counter_pair();
        expect(() => client.handle(client.require('counter'))).toThrow(/handle/i);
    });
});

describe('callbacks', () => {
    it('invokes a client function from the host', async () => {
        const { client } = module_pair('app', {
            each: async (items: number[], fn: (n: number) => Promise<number>) => {
                const out = [];
                for (const item of items) {
                    out.push(await fn(item));
                }
                return out;
            }
        });
        const result = await client.require('app').each([1, 2, 3], (n: number) => n * 2);
        expect(result).toEqual([2, 4, 6]);
    });

    it('truncates arguments to the callback arity', async () => {
        const { client } = module_pair('app', {
            run: (fn: (...args: unknown[]) => Promise<unknown>) => fn('a', 'b', 'c')
        });
        const seen = await client.require('app').run((first: string) => [first]);
        expect(seen).toEqual(['a']);
    });

    it('supports an async callback', async () => {
        const { client } = module_pair('app', {
            run: (fn: () => Promise<string>) => fn()
        });
        const value = await client.require('app').run(async () => 'later');
        expect(value).toBe('later');
    });

    it('keeps concurrent invocations of one callback separate', async () => {
        const { client } = module_pair('app', {
            both: (fn: (n: number) => Promise<number>) => Promise.all([fn(1), fn(2)])
        });
        const result = await client
            .require('app')
            .both(
                async (n: number) =>
                    new Promise(resolve => setTimeout(() => resolve(n * 10), n * 10))
            );
        expect(result).toEqual([10, 20]);
    });
});

describe('errors', () => {
    it('rejects with a real Error carrying the message', async () => {
        const { client } = module_pair('app', {
            boom: () => {
                throw new Error('kaboom');
            }
        });
        await expect(client.require('app').boom()).rejects.toThrow('kaboom');
    });

    it('preserves the error stack across the channel', async () => {
        const { client } = module_pair('app', {
            boom: () => {
                throw new Error('kaboom');
            }
        });
        try {
            await client.require('app').boom();
            expect.unreachable('should have thrown');
        } catch (error) {
            expect(error).toBeInstanceOf(Error);
            const err = error as Error;
            expect(err.message).toBe('kaboom');
            expect(typeof err.stack).toBe('string');
            expect(err.stack).toContain('kaboom');
        }
    });

    it('preserves the error name', async () => {
        class CustomError extends Error {
            override name = 'CustomError';
        }
        const { client } = module_pair('app', {
            boom: () => {
                throw new CustomError('nope');
            }
        });
        try {
            await client.require('app').boom();
            expect.unreachable('should have thrown');
        } catch (error) {
            expect((error as Error).name).toBe('CustomError');
        }
    });

    it('propagates a rejected promise from the host', async () => {
        const { client } = module_pair('app', {
            boom: async () => {
                throw new Error('async kaboom');
            }
        });
        await expect(client.require('app').boom()).rejects.toThrow('async kaboom');
    });
});

describe('promise interface', () => {
    function boom_pair() {
        return module_pair('app', {
            boom: () => {
                throw new Error('kaboom');
            },
            ok: () => 7
        });
    }

    it('handles a rejection through catch()', async () => {
        const { client } = boom_pair();
        let message = '';
        await client
            .require('app')
            .boom()
            .catch((error: Error) => {
                message = error.message;
            });
        expect(message).toBe('kaboom');
    });

    it('leaves a successful value alone in catch()', async () => {
        const { client } = boom_pair();
        expect(
            await client
                .require('app')
                .ok()
                .catch(() => -1)
        ).toBe(7);
    });

    it('runs finally() and passes the value through', async () => {
        const { client } = boom_pair();
        let ran = false;
        const value = await client
            .require('app')
            .ok()
            .finally(() => {
                ran = true;
            });
        expect(ran).toBe(true);
        expect(value).toBe(7);
    });

    it('runs finally() when the call rejects', async () => {
        const { client } = boom_pair();
        let ran = false;
        await expect(
            client
                .require('app')
                .boom()
                .finally(() => {
                    ran = true;
                })
        ).rejects.toThrow('kaboom');
        expect(ran).toBe(true);
    });

    it('chains catch() after then()', async () => {
        const { client } = boom_pair();
        const value = await client
            .require('app')
            .boom()
            .then(() => 'no')
            .catch(() => 'caught');
        expect(value).toBe('caught');
    });

    // with nothing recorded there is nothing to run, so these stay ordinary
    // remote property accesses rather than promise methods
    it('still calls a remote method named catch', async () => {
        const { client } = module_pair('app', { catch: () => 'remote catch' });
        expect(await client.require('app').catch()).toBe('remote catch');
    });

    it('still calls a remote method named finally', async () => {
        const { client } = module_pair('app', { finally: () => 'remote finally' });
        expect(await client.require('app').finally()).toBe('remote finally');
    });
});

describe('serialize hooks', () => {
    it('passes values through unserialize on the host', async () => {
        const { client } = pair({
            resolve: () => ({ echo: (value: unknown) => value }),
            unserialize: (value: unknown) => (value === '__MARKER__' ? 'unpacked' : value)
        });
        expect(await client.require('app').echo('__MARKER__')).toBe('unpacked');
    });

    it('leaves plain JSON values untouched', async () => {
        const { client } = module_pair('app', {
            echo: (value: unknown) => value
        });
        const value = { a: 1, b: [1, 2, { c: 'three' }], d: null, e: true };
        expect(await client.require('app').echo(value)).toEqual(value);
    });
});

describe('repr', () => {
    class Selection {
        constructor(public length: number) {}
        text() {
            return 'hi';
        }
    }

    function repr_pair(repr?: (value: unknown) => string) {
        return pair({
            resolve: (name: string) =>
                name === 'app' ? { get: () => new Selection(3) } : null,
            ...(repr ? { repr } : {})
        });
    }

    it('gives a handle a string form the host chose', async () => {
        const { client } = repr_pair(value =>
            value instanceof Selection ? `#<jQuery [${value.length}]>` : String(value)
        );
        const handle = await client.require('app').get();
        expect(String(handle)).toBe('#<jQuery [3]>');
        expect(`${handle}`).toBe('#<jQuery [3]>');
        expect('' + handle).toBe('#<jQuery [3]>');
    });

    it('names the constructor when no repr is configured', async () => {
        const { client } = repr_pair();
        const handle = await client.require('app').get();
        expect(String(handle)).toBe('#<Selection>');
    });

    it('calls repr on the host, with the real object and the host as this', async () => {
        const seen: unknown[] = [];
        const receivers: unknown[] = [];
        const { client, host } = pair({
            resolve: (name: string) =>
                name === 'app' ? { get: () => new Selection(1) } : null,
            repr(this: Host, value: unknown) {
                seen.push(value);
                receivers.push(this);
                return 'ok';
            }
        });
        await client.require('app').get();
        // the real object, not a handle - which is the whole point of doing
        // this on the host
        expect(seen[0]).toBeInstanceOf(Selection);
        expect(receivers[0]).toBe(host);
    });

    it('refuses to stringify a chain that has not run', async () => {
        const { client } = repr_pair();
        const chain = client.require('app').get();
        expect(() => String(chain)).toThrow(/mitty:.*await/i);
    });

    it('labels a bare module reference', async () => {
        const { client } = repr_pair();
        expect(String(client.require('app'))).toBe("#<module 'app'>");
    });

    it('throws when repr answers with something other than a string', async () => {
        const { client } = repr_pair((() => 42) as unknown as (v: unknown) => string);
        // not expect().rejects: that helper sees `typeof chain === 'function'`
        // and calls the chain, which records a second call onto it
        const error = await client
            .require('app')
            .get()
            .catch((e: Error) => e);
        expect(error.message).toMatch(/repr\(\).*string/i);
    });

    it('sends a handle back as the integer alone, without its repr', async () => {
        const seen: string[] = [];
        const { client } = pair({
            resolve: (name: string) =>
                name === 'app'
                    ? {
                          get: () => new Selection(2),
                          same: (other: unknown) => other instanceof Selection
                      }
                    : null,
            repr: () => '#<jQuery [2]>',
            unserialize(value: unknown) {
                if (typeof value === 'string') {
                    seen.push(value);
                }
                return value;
            }
        });
        const handle = await client.require('app').get();
        expect(String(handle)).toBe('#<jQuery [2]>');
        expect(await client.require('app').same(handle)).toBe(true);
        // the repr is the host's own text - it has no business travelling back
        expect(seen.some(text => text.includes('jQuery'))).toBe(false);
    });
});

describe('dir', () => {
    class Widget {
        label = 'w';
        constructor(public size: number) {}
        find(selector: string) {
            return selector;
        }
        append(node: unknown, mode = 'after') {
            return [node, mode];
        }
        get computed() {
            throw new Error('a getter must not be invoked to describe it');
        }
    }

    function widget_pair(options: Partial<HostOptions> = {}) {
        return pair({
            resolve: (name: string) =>
                name === 'app' ? { get: () => new Widget(2) } : null,
            ...options
        } as Omit<HostOptions, 'channel'>);
    }

    it('lists the methods of a handle', async () => {
        const { client } = widget_pair();
        const handle = await client.require('app').get();
        const listed = await dir(handle);
        expect(listed.methods.map(m => m.name)).toEqual(['append', 'find']);
    });

    it('lists properties beside methods, in a list of their own', async () => {
        const { client } = widget_pair();
        const handle = await client.require('app').get();
        const { methods, properties } = await dir(handle);
        expect(methods.map(m => m.name)).toEqual(['append', 'find']);
        // label and size are data, computed is a getter
        expect(properties.map(p => p.name)).toEqual(['computed', 'label', 'size']);
    });

    it('reports what a data property holds, and whether it can be written', async () => {
        const { client } = widget_pair();
        const handle = await client.require('app').get();
        const { properties } = await dir(handle);
        const by = (name: string) => properties.find(p => p.name === name);
        expect(by('label')).toEqual({ name: 'label', readonly: false, type: ['string'] });
        expect(by('size')).toEqual({ name: 'size', readonly: false, type: ['number'] });
    });

    it('says a getter is readonly but will not guess its type', async () => {
        const { client } = widget_pair();
        const handle = await client.require('app').get();
        const { properties } = await dir(handle);
        // `computed` has a getter and no setter, and throws if read - the
        // type is unknowable without invoking it, so it goes unstated
        expect(properties.find(p => p.name === 'computed')).toEqual({
            name: 'computed',
            readonly: true
        });
    });

    it('calls a property remote when reading it would give a handle', async () => {
        const { client } = pair({
            resolve: (name: string) =>
                name === 'app'
                    ? {
                          // the container needs a method of its own, or the
                          // host copies it instead of keeping a handle
                          get: () => ({
                              touch() {},
                              plain: { a: 1 },
                              rich: new Widget(1)
                          })
                      }
                    : null
        });
        const handle = await client.require('app').get();
        expect(is_remote(handle)).toBe(true);
        const { properties } = await dir(handle);
        const by = (name: string) => properties.find(p => p.name === name);
        expect(by('plain')?.type).toEqual(['object']);
        expect(by('rich')?.type).toEqual(['remote']);
    });

    it('runs a chain first, then describes what it produced', async () => {
        const { client } = widget_pair();
        const listed = await dir(client.require('app').get());
        expect(listed.methods.map(m => m.name)).toEqual(['append', 'find']);
    });

    it('reports the required arity, which is all Function.length knows', async () => {
        const { client } = widget_pair();
        const handle = await client.require('app').get();
        const listed = (await dir(handle)).methods;
        const append = listed.find(m => m.name === 'append');
        // append(node, mode = 'after') - length stops at the first default
        expect(append?.params?.arity).toEqual({ required: 1 });
        expect(listed.find(m => m.name === 'find')?.params?.arity).toEqual({
            required: 1
        });
    });

    it('leaves out Object.prototype, and keeps data out of the methods', async () => {
        const { client } = widget_pair();
        const handle = await client.require('app').get();
        const { methods, properties } = await dir(handle);
        const every = [...methods, ...properties].map(m => m.name);
        expect(every).not.toContain('toString');
        expect(every).not.toContain('hasOwnProperty');
        expect(methods.map(m => m.name)).not.toContain('label');
        expect(methods.map(m => m.name)).not.toContain('size');
    });

    it('does not invoke a getter to describe it', async () => {
        const { client } = widget_pair();
        const handle = await client.require('app').get();
        // `computed` throws when read - reaching here at all is the assertion
        const { properties } = await dir(handle);
        expect(properties.map(p => p.name)).toContain('computed');
    });

    it('keeps to the host key policy', async () => {
        const { client } = widget_pair({ get: (key: string) => key !== 'find' });
        const handle = await client.require('app').get();
        const names = (await dir(handle)).methods.map(m => m.name);
        expect(names).toContain('append');
        expect(names).not.toContain('find');
    });

    it('never lists the keys a chain reaches a prototype through', async () => {
        const { client } = widget_pair();
        const handle = await client.require('app').get();
        const { methods, properties } = await dir(handle);
        const names = [...methods, ...properties].map(m => m.name);
        for (const unsafe of ['constructor', '__proto__', 'prototype']) {
            expect(names).not.toContain(unsafe);
        }
    });

    it('lets the host describe a value itself', async () => {
        const described = {
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
            properties: [{ name: 'innerHTML', readonly: false, type: ['string'] }]
        };
        const { client } = widget_pair({ dir: () => described });
        const handle = await client.require('app').get();
        expect(await dir(handle)).toEqual(described);
    });

    it('refuses an entry the dir hook did not give a name', async () => {
        // every other hook return is checked loudly - repr must be a string,
        // get/set must be boolean - and this one has teeth: the key filter is
        // safe_key(entry.name), and safe_key answers true for anything that is
        // not a string, so a malformed name walks past the policy
        const bad = [
            { methods: [null], properties: [] },
            { methods: [{ name: 42 }], properties: [] },
            { methods: [], properties: [{ name: { toString: () => '__proto__' } }] }
        ];
        for (const described of bad) {
            const { client } = widget_pair({
                dir: () => described as unknown as Description
            });
            const handle = await client.require('app').get();
            const error = (await dir(handle).catch((e: Error) => e)) as Error;
            expect(error.message).toMatch(/dir\(\).*name/i);
        }
    });

    it('does not advertise a method that a nearer member hides', () => {
        // a nearer data property or accessor is what a `get` would actually
        // reach, so the method further along the chain is not there to call
        const base = {
            shadowed() {
                return 'method';
            },
            plain() {
                return 'ok';
            }
        };
        const near: Record<string, unknown> = Object.create(base);
        near.shadowed = 'a string now';
        const described = describe_value(near);
        expect(described.methods.map(m => m.name)).toEqual(['plain']);
        expect(described.properties.map(p => p.name)).toEqual(['shadowed']);

        const accessor: Record<string, unknown> = Object.create(base);
        Object.defineProperty(accessor, 'shadowed', { get: () => 5, configurable: true });
        const second = describe_value(accessor);
        expect(second.methods.map(m => m.name)).toEqual(['plain']);
        expect(second.properties.map(p => p.name)).toEqual(['shadowed']);
    });

    it('reports a host that does not offer introspection', async () => {
        const { client } = widget_pair({ dir: () => null });
        const handle = await client.require('app').get();
        const error = (await dir(handle).catch((e: Error) => e)) as Error & {
            code?: number;
        };
        expect(error.message).toMatch(/introspect/i);
        expect(error.code).toBe(CODES.NO_INTROSPECTION);
    });

    it('rejects anything that is not a remote value', async () => {
        await expect(dir({ find: () => 1 })).rejects.toThrow(/remote/i);
        await expect(dir(42)).rejects.toThrow(/remote/i);
    });
});
