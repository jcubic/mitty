import { afterEach, describe, expect, it } from 'vitest';
import type { Host } from '../src/index';
import { cleanup, module_pair, pair } from './helpers';

afterEach(() => {
    cleanup();
});

// methods on the prototype and data of its own - the shape JSON quietly ruins
class Stat {
    type: string;
    size: number;
    constructor(type: string, size: number) {
        this.type = type;
        this.size = size;
    }
    isFile() {
        return this.type === 'file';
    }
}

// a host with no serialize() at all: the point of the default is that this is
// all it takes for a class instance to keep working in the worker
describe('handles without a serialize hook', () => {
    function fs_pair() {
        return module_pair('fs', {
            stat: (name: string) => new Stat(name.endsWith('/') ? 'dir' : 'file', 12),
            readdir: () => ['one', 'two'],
            config: () => ({ debug: true, paths: ['/bin'] })
        });
    }

    it('keeps a prototype method callable', async () => {
        const { client } = fs_pair();
        const stat = await client.require('fs').stat('/notes.txt');
        expect(await stat.isFile()).toBe(true);
    });

    it('keeps the data readable too', async () => {
        const { client } = fs_pair();
        const stat = await client.require('fs').stat('/notes.txt');
        expect(await stat.size).toBe(12);
        expect(await stat.type).toBe('file');
    });

    it('runs the method against the live object', async () => {
        const { client } = fs_pair();
        const stat = await client.require('fs').stat('/home/');
        expect(await stat.isFile()).toBe(false);
    });

    it('still copies plain data across', async () => {
        const { client } = fs_pair();
        expect(await client.require('fs').readdir()).toEqual(['one', 'two']);
        expect(await client.require('fs').config()).toEqual({
            debug: true,
            paths: ['/bin']
        });
    });

    it('copies a value nested in plain data, as a handle', async () => {
        const { client } = module_pair('fs', {
            entries: () => ({ total: 1, first: new Stat('file', 3) })
        });
        const result = await client.require('fs').entries();
        expect(result.total).toBe(1);
        expect(await result.first.isFile()).toBe(true);
    });

    // an Error inherits toString() from Error.prototype, so the predicate says
    // yes to one - errors are encoded before any of this runs, and a caller
    // has to catch a real Error rather than a handle to one
    it('does not turn an error into a handle', async () => {
        const { client } = module_pair('fs', {
            open: () => {
                throw new Error('ENOENT: no such file or directory');
            }
        });
        await expect(client.require('fs').open()).rejects.toThrow(
            'ENOENT: no such file or directory'
        );
    });
});

describe('choosing what becomes a handle', () => {
    it('lets serialize() win over the default', async () => {
        // the hook returns plain data for a value the default would keep here
        const { client } = pair({
            resolve: () => ({ stat: () => new Stat('file', 12) }),
            serialize(value: unknown) {
                return value instanceof Stat ? { type: value.type } : value;
            }
        });
        expect(await client.require('fs').stat()).toEqual({ type: 'file' });
    });

    it('takes a predicate of its own', async () => {
        const { client } = pair({
            resolve: () => ({ stat: () => new Stat('file', 12) }),
            remote: () => false
        });
        const stat = await client.require('fs').stat();
        // copied, so the data is there and the method is not
        expect(stat).toEqual({ type: 'file', size: 12 });
    });

    it('can be pointed at a type of its own', async () => {
        class Widget {
            name = 'w';
        }
        const { client } = pair({
            resolve: () => ({
                widget: () => new Widget(),
                stat: () => new Stat('file', 12)
            }),
            remote: value => value instanceof Widget
        });
        // Widget has no methods, so only an explicit predicate reaches it
        expect(await client.require('m').widget().name).toBe('w');
        // and the predicate replaces the default rather than adding to it, so
        // the Stat is copied even though it is exactly what the default keeps
        expect(await client.require('m').stat()).toEqual({ type: 'file', size: 12 });
    });

    it('never turns the message itself into a handle', async () => {
        // a predicate this greedy would swallow the envelope the reply
        // travels in, if the root were not left alone
        const { client } = pair({
            resolve: () => ({ get: () => 42 }),
            remote: value => typeof value === 'object' && value !== null
        });
        expect(await client.require('m').get()).toBe(42);
    });

    it('releases an automatic handle like any other', async () => {
        const { client } = module_pair('fs', { stat: () => new Stat('file', 12) });
        const stat = await client.require('fs').stat();
        expect(await stat.isFile()).toBe(true);
        client.release(stat);
        await expect(stat.isFile()).rejects.toThrow(/handle/i);
    });

    it('is still the host that owns the handle', async () => {
        const stat = new Stat('file', 12);
        const { host, client } = module_pair('fs', { stat: () => stat });
        const remote = await client.require('fs').stat();
        expect(host.release(client.handle(remote) as never)).toBe(true);
    });
});

describe('serialize() and the default together', () => {
    it('runs the hook first, then the default', async () => {
        const seen: unknown[] = [];
        const { client } = pair({
            resolve: () => ({ stat: () => new Stat('file', 12) }),
            serialize(this: Host, value: unknown) {
                seen.push(value);
                return value;
            }
        });
        const stat = await client.require('fs').stat();
        // the hook was offered the Stat and passed on it, so the default took it
        expect(seen.some(value => value instanceof Stat)).toBe(true);
        expect(await stat.isFile()).toBe(true);
    });
});
