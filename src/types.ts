/* eslint-disable @typescript-eslint/no-explicit-any */

// -----------------------------------------------------------------------------
// The transport. Both ends take a channel rather than creating one, so the
// caller decides what the two sides talk over - a BroadcastChannel, a
// MessagePort wrapper, or a stub in tests. Only the three members below are
// used; a channel is never closed by this library, since it is owned by
// whoever created it.
// -----------------------------------------------------------------------------
export interface ChannelEvent {
    data: string;
}

export type ChannelListener = (event: ChannelEvent) => void;

export interface Channel {
    postMessage(message: string): void;
    addEventListener(type: 'message', listener: ChannelListener): void;
    removeEventListener(type: 'message', listener: ChannelListener): void;
}

// -----------------------------------------------------------------------------
// Wire markers: values that JSON cannot carry on its own. They are plain
// objects so the payload stays JSON, which means an application object that
// happens to have this exact `{ type, data }` shape would be mistaken for one -
// see the README for the reserved shape.
// -----------------------------------------------------------------------------
export interface FunctionMarker {
    type: 'function';
    data: [id: number, length: number];
}

export interface ObjectMarker {
    type: 'object';
    data: [id: number];
}

export interface ErrorMarker {
    type: 'error';
    data: [name: string, message: string, stack: string | null];
}

export type Marker = FunctionMarker | ObjectMarker | ErrorMarker;

// -----------------------------------------------------------------------------
// A chain step recorded on the client and replayed on the host. `$('li').text()`
// is [{ type: 'call', args: ['li'] }, { type: 'get', key: 'text' },
// { type: 'call', args: [] }] - one message for the whole chain.
// -----------------------------------------------------------------------------
export type Op = { type: 'get'; key: string } | { type: 'call'; args: unknown[] };

// -----------------------------------------------------------------------------
// The proxy handed back by require(). Every property access and call returns
// another Remote; awaiting one sends the accumulated chain to the host. The
// type is deliberately loose - what a chain resolves to is only known on the
// host, so there is nothing here for TypeScript to check against.
// -----------------------------------------------------------------------------
export interface Remote {
    (...args: any[]): Remote;
    then<R1 = any, R2 = never>(
        onfulfilled?: ((value: any) => R1 | PromiseLike<R1>) | null,
        onrejected?: ((reason: any) => R2 | PromiseLike<R2>) | null,
    ): Promise<R1 | R2>;
    catch<R = any>(onrejected?: ((reason: any) => R | PromiseLike<R>) | null): Promise<R>;
    finally(onfinally?: (() => void) | null): Promise<any>;
    [key: string]: any;
}

export interface Client {
    // look up a module by name; the host's resolve() decides what that means
    require(name: string): Remote;
    // the host-side id a handle stands for. Needed to release a handle without
    // holding on to it - a FinalizationRegistry callback that captured the
    // proxy would keep it alive and never fire.
    handle(remote: unknown): number;
    // tell the host it can drop the object behind this handle, by proxy or by id
    release(remote: unknown | number): void;
    // stop listening on the channel (the channel itself is left open)
    close(): void;
}
