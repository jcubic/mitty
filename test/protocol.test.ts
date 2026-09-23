import { afterEach, describe, expect, it } from 'vitest';
import { Host, connect } from '../src/index';
import type { Channel, ChannelListener, Client, HostOptions } from '../src/index';

// An in-memory channel pair. Besides letting the tests read the raw wire, this
// is the README's claim that any object with these three members works -
// nothing here is a BroadcastChannel.
class FakeChannel implements Channel {
    public sent: string[] = [];
    public peer!: FakeChannel;
    private _listeners = new Set<ChannelListener>();

    postMessage(message: string): void {
        this.sent.push(message);
        // delivered asynchronously, and never back to the sender
        queueMicrotask(() => {
            for (const listener of [...this.peer._listeners]) {
                listener({ data: message });
            }
        });
    }
    addEventListener(_type: 'message', listener: ChannelListener): void {
        this._listeners.add(listener);
    }
    removeEventListener(_type: 'message', listener: ChannelListener): void {
        this._listeners.delete(listener);
    }
}

const open: Array<() => void> = [];

function wired(options: Omit<HostOptions, 'channel'>): {
    client: Client;
    wire: () => string;
} {
    const host_channel = new FakeChannel();
    const client_channel = new FakeChannel();
    host_channel.peer = client_channel;
    client_channel.peer = host_channel;

    const host = new Host({ channel: host_channel, ...options });
    const client = connect(client_channel);
    open.push(() => {
        host.close();
        client.close();
    });
    return {
        client,
        wire: () => [...host_channel.sent, ...client_channel.sent].join('\n'),
    };
}

afterEach(() => {
    while (open.length) {
        open.pop()?.();
    }
});

describe('wire format', () => {
    it('tags a function with __type__ and __data__', async () => {
        const { client, wire } = wired({
            resolve: () => ({ run: (fn: () => unknown) => fn() }),
        });
        await client.require('app').run(() => 1);
        expect(wire()).toContain('__type__');
        expect(wire()).toContain('__data__');
        expect(wire()).not.toMatch(/"type":\s*"function"/);
    });

    it('tags a handle with __type__ and __data__', async () => {
        class Thing {}
        const { client, wire } = wired({
            resolve: () => ({ get: () => new Thing() }),
            serialize(this: Host, value: unknown) {
                return value instanceof Thing ? this.remote(value) : value;
            },
        });
        await client.require('app').get();
        expect(wire()).toContain('"__type__":"object"');
        expect(wire()).not.toMatch(/"type":\s*"object"/);
    });

    it('tags an error with __type__ and __data__', async () => {
        const { client, wire } = wired({
            resolve: () => ({
                boom: () => {
                    throw new Error('kaboom');
                },
            }),
        });
        await expect(client.require('app').boom()).rejects.toThrow('kaboom');
        expect(wire()).toContain('"__type__":"error"');
        expect(wire()).not.toMatch(/"type":\s*"error"/);
    });
});

// the whole point of the rename: an application object that happens to look
// like a marker must survive untouched in both directions
describe('objects that look like markers', () => {
    const decoys = [
        { type: 'object', data: [1] },
        { type: 'function', data: [1, 0] },
        { type: 'error', data: ['Error', 'nope', null] },
    ];

    it('round-trips a colliding object from the host', async () => {
        const { client } = wired({ resolve: () => ({ get: () => decoys }) });
        expect(await client.require('app').get()).toEqual(decoys);
    });

    it('round-trips a colliding object sent by the client', async () => {
        const { client } = wired({ resolve: () => ({ echo: (v: unknown) => v }) });
        expect(await client.require('app').echo(decoys)).toEqual(decoys);
    });

    it('keeps a colliding object a plain object, not a proxy', async () => {
        const { client } = wired({
            resolve: () => ({ get: () => ({ type: 'object', data: [99] }) }),
        });
        const value = await client.require('app').get();
        expect(typeof value).toBe('object');
        expect(value.type).toBe('object');
        expect(value.data).toEqual([99]);
    });
});
