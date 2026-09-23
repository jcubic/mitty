import { afterEach, describe, expect, it } from 'vitest';
import type { Host } from '../src/index';
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
            add: (a: number, b: number) => a + b,
        });
        expect(await client.require('math').add(2, 3)).toBe(5);
    });

    it('awaits async functions on the host', async () => {
        const { client } = module_pair('math', {
            slow: async (n: number) => n * 2,
        });
        expect(await client.require('math').slow(21)).toBe(42);
    });

    it('resolves a whole property chain in one round trip', async () => {
        const { client } = module_pair('app', {
            nested: { deep: { value: 42, greet: (n: string) => `hi ${n}` } },
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
                          is_same: (other: unknown) => other === counter,
                      }
                    : null,
            serialize(this: Host, value: unknown) {
                if (value instanceof Counter) {
                    return this.remote(value);
                }
                return value;
            },
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
            require('counter').is_same(require('counter').get()),
        ).rejects.toThrow(/unresolved/i);
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
            },
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
            },
        });
        const result = await client.require('app').each([1, 2, 3], (n: number) => n * 2);
        expect(result).toEqual([2, 4, 6]);
    });

    it('truncates arguments to the callback arity', async () => {
        const { client } = module_pair('app', {
            run: (fn: (...args: unknown[]) => Promise<unknown>) => fn('a', 'b', 'c'),
        });
        const seen = await client.require('app').run((first: string) => [first]);
        expect(seen).toEqual(['a']);
    });

    it('supports an async callback', async () => {
        const { client } = module_pair('app', {
            run: (fn: () => Promise<string>) => fn(),
        });
        const value = await client.require('app').run(async () => 'later');
        expect(value).toBe('later');
    });

    it('keeps concurrent invocations of one callback separate', async () => {
        const { client } = module_pair('app', {
            both: (fn: (n: number) => Promise<number>) => Promise.all([fn(1), fn(2)]),
        });
        const result = await client
            .require('app')
            .both(
                async (n: number) =>
                    new Promise(resolve => setTimeout(() => resolve(n * 10), n * 10)),
            );
        expect(result).toEqual([10, 20]);
    });
});

describe('errors', () => {
    it('rejects with a real Error carrying the message', async () => {
        const { client } = module_pair('app', {
            boom: () => {
                throw new Error('kaboom');
            },
        });
        await expect(client.require('app').boom()).rejects.toThrow('kaboom');
    });

    it('preserves the error stack across the channel', async () => {
        const { client } = module_pair('app', {
            boom: () => {
                throw new Error('kaboom');
            },
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
            },
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
            },
        });
        await expect(client.require('app').boom()).rejects.toThrow('async kaboom');
    });
});

describe('serialize hooks', () => {
    it('passes values through unserialize on the host', async () => {
        const { client } = pair({
            resolve: () => ({ echo: (value: unknown) => value }),
            unserialize: (value: unknown) =>
                value === '__MARKER__' ? 'unpacked' : value,
        });
        expect(await client.require('app').echo('__MARKER__')).toBe('unpacked');
    });

    it('leaves plain JSON values untouched', async () => {
        const { client } = module_pair('app', {
            echo: (value: unknown) => value,
        });
        const value = { a: 1, b: [1, 2, { c: 'three' }], d: null, e: true };
        expect(await client.require('app').echo(value)).toEqual(value);
    });
});
