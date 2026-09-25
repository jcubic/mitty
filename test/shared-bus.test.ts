import { afterEach, describe, expect, it } from 'vitest';
import { Host, connect } from '../src/index';
import type { Channel, ChannelListener } from '../src/index';

// A bus every participant hears, the way sysend or a BroadcastChannel behaves
// once more than two ends share it. Unlike a worker pipe there is no "other
// side" - a tab that runs both a Host and a client hears the replies meant for
// the other tab's client.
class Bus {
    readonly sent: string[] = [];
    private _peers = new Set<Endpoint>();

    endpoint(): Endpoint {
        const endpoint = new Endpoint(this);
        this._peers.add(endpoint);
        return endpoint;
    }

    publish(from: Endpoint, message: string) {
        this.sent.push(message);
        for (const peer of [...this._peers]) {
            // sysend does not deliver to the tab that sent
            if (peer !== from) {
                peer.receive(message);
            }
        }
    }
}

class Endpoint implements Channel {
    private _listeners: ChannelListener[] = [];
    constructor(private _bus: Bus) {}
    postMessage(message: string) {
        this._bus.publish(this, message);
    }
    addEventListener(_type: 'message', listener: ChannelListener) {
        this._listeners.push(listener);
    }
    removeEventListener(_type: 'message', listener: ChannelListener) {
        this._listeners = this._listeners.filter(fn => fn !== listener);
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

function tab(bus: Bus, modules: Record<string, unknown>) {
    // one endpoint per tab, carrying that tab's host and its client, which is
    // what a cross-tab page looks like: every peer is symmetric
    const endpoint = bus.endpoint();
    const host = new Host({
        channel: endpoint,
        resolve: (name: string) => modules[name] ?? null
    });
    const client = connect(endpoint);
    open.push(() => {
        host.close();
        client.close();
    });
    return { host, client };
}

describe('a host on a shared bus', () => {
    // a reply carries an id, exactly as a request does. A host that reads one
    // as a request answers with an error that carries the same id, which the
    // other host reads as a request in turn - two tabs, one click, no end
    it('does not answer a reply it overhears', async () => {
        const bus = new Bus();
        const a = tab(bus, { doc: { title: () => 'page a' } });
        tab(bus, { doc: { title: () => 'page b' } });

        // the client talks to the other tab - the bus does not echo, so tab
        // b is the only host that hears it. That is the point of cross-tab
        expect(await a.client.require('doc').title()).toBe('page b');
        await new Promise(resolve => setTimeout(resolve, 50));

        // one request out, one reply back, and nothing else
        expect(bus.sent).toHaveLength(2);
    });

    it('stays quiet when handed a reply out of nowhere', async () => {
        const bus = new Bus();
        tab(bus, { doc: {} });
        const stray = bus.endpoint();
        stray.postMessage(JSON.stringify({ id: 1, result: 'not for you' }));
        await new Promise(resolve => setTimeout(resolve, 50));
        // only the stray message itself
        expect(bus.sent).toEqual([JSON.stringify({ id: 1, result: 'not for you' })]);
    });

    it('still answers a real request', async () => {
        const bus = new Bus();
        const a = tab(bus, { doc: { title: () => 'page a' } });
        tab(bus, { doc: { title: () => 'page b' } });
        expect(await a.client.require('doc').title()).toBe('page b');
    });
});

describe('a client on a shared bus', () => {
    it('does not mistake an overheard request for its reply', async () => {
        // no host here, so the only thing that could settle the call is the
        // stray request - which carries the very id the call is waiting on
        const bus = new Bus();
        const endpoint = bus.endpoint();
        const client = connect(endpoint);
        open.push(() => client.close());

        const answer = client.require('doc').title();
        const settled = answer.then(
            () => 'resolved',
            () => 'rejected'
        );
        bus.endpoint().postMessage(
            JSON.stringify({ id: 1, namespace: 'doc', ops: [{ type: 'get', key: 'x' }] })
        );
        const outcome = await Promise.race([
            settled,
            new Promise(resolve => setTimeout(() => resolve('still waiting'), 50))
        ]);
        expect(outcome).toBe('still waiting');
    });

    // What the guard cannot fix: two clients on one bus number their requests
    // from counters of their own, both starting at 1, so a reply to one peer's
    // request is indistinguishable from a reply to the other's. Give each pair
    // of ends a channel of its own when a bus carries more than one.
    it('shares an id space with every other client on the bus', async () => {
        const bus = new Bus();
        const a = tab(bus, { doc: { title: () => 'page a' } });
        const b = tab(bus, { doc: { title: () => 'page b' } });
        // each asks the other, and both requests go out as id 1
        const [first, second] = await Promise.all([
            a.client.require('doc').title(),
            b.client.require('doc').title()
        ]);
        // the answers are right here, but only because each arrives while its
        // own request is the one in flight - this is not a guarantee
        expect([first, second].sort()).toEqual(['page a', 'page b']);
    });
});
