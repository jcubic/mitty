import { Host, connect } from '../src/index';
import type { Client, HostOptions } from '../src/index';

let counter = 0;
const cleanups: Array<() => void> = [];

// a host and a client talking over two BroadcastChannel endpoints that share a
// name. In Node (as in the browser) a channel never receives its own messages
// but does receive the other endpoint's, so this is a faithful stand-in for
// main-thread <-> worker without spawning a worker.
export function pair(options: Omit<HostOptions, 'channel'>): {
    host: Host;
    client: Client;
} {
    const name = `mitty-test-${++counter}-${Math.random().toString(36).slice(2)}`;
    const host_channel = new BroadcastChannel(name);
    const client_channel = new BroadcastChannel(name);
    const host = new Host({ channel: host_channel, ...options });
    const client = connect(client_channel);
    cleanups.push(() => {
        host.close();
        client.close();
        host_channel.close();
        client_channel.close();
    });
    return { host, client };
}

export function cleanup(): void {
    while (cleanups.length) {
        const fn = cleanups.pop();
        fn?.();
    }
}

// a single module under a fixed name, the shape most tests need
export function module_pair(name: string, value: unknown) {
    return pair({
        resolve: (requested: string) => (requested === name ? value : null),
    });
}
