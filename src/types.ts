/*
 * Mitty - use main thread objects from inside a Web Worker
 *
 * Copyright (c) 2026 Jakub T. Jankiewicz <https://jakub.jankiewicz.org>
 * Released under MIT license
 */
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
// Wire markers: values that JSON cannot carry on its own. They stay plain
// objects so the payload is still JSON, which means any application value of
// the same shape would be mistaken for one. The dunder names borrow Python's
// convention to make that collision unlikely - `{ type, data }` is an ordinary
// shape to find in application data, `{ __type__, __data__ }` is not.
//
// `__data__` is an object rather than a positional array so that every member
// is named on the wire - see rpc/SPEC.md §6.
// -----------------------------------------------------------------------------
export interface FunctionMarker {
    __type__: 'function';
    // `arity` is the most arguments the client will accept. Absent means no
    // limit, and the host sends every argument the call produced - §11.2
    __data__: { callback: number; arity?: number };
}

export interface ObjectMarker {
    __type__: 'object';
    // `repr` travels Host to Client only, and only when the handle is minted:
    // a string form the host built from the real object. A client referring
    // back to a handle sends the integer alone.
    __data__: { handle: number; repr?: string };
}

export interface ErrorMarker {
    __type__: 'error';
    // stack and code are optional: an object payload lets a member be absent
    // rather than a null holding a place, which a positional array could not
    __data__: { name: string; message: string; stack?: string; code?: number };
}

export type Marker = FunctionMarker | ObjectMarker | ErrorMarker;

// -----------------------------------------------------------------------------
// A chain step recorded on the client and replayed on the host. `$('li').text()`
// is [{ type: 'call', args: ['li'] }, { type: 'get', key: 'text' },
// { type: 'call', args: [] }] - one message for the whole chain.
//
// A `set` only ever comes last: `a.b = c` evaluates to `c` in JavaScript, so
// there is no proxy left to record another step onto.
// -----------------------------------------------------------------------------
export type Op =
    | { type: 'get'; key: string }
    | { type: 'set'; key: string; value: unknown }
    | { type: 'call'; args: unknown[] }
    | { type: 'dir' };

// -----------------------------------------------------------------------------
// What `dir()` answers: one entry per method the host is willing to name.
//
// Everything below `name` is OPTIONAL, because introspection is not something
// every language can do to the same depth. JavaScript can report `required`
// and nothing else - Function.length stops at the first default parameter, so
// the optional count is not merely unknown but unknowable without reading the
// source. A language with real reflection can fill the rest, and a host that
// knows its own API can supply all of it through the `dir` option.
// -----------------------------------------------------------------------------
export interface Param {
    name?: string;
    type?: string;
}

export interface Arity {
    required?: number;
    optional?: number;
    variadic?: boolean;
}

export interface Method {
    name: string;
    params?: {
        arity?: Arity;
        values?: Param[];
    };
}

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
        onrejected?: ((reason: any) => R2 | PromiseLike<R2>) | null
    ): Promise<R1 | R2>;
    catch<R = any>(onrejected?: ((reason: any) => R | PromiseLike<R>) | null): Promise<R>;
    finally(onfinally?: (() => void) | null): Promise<any>;
    [key: string]: any;
}

export interface ClientOptions {
    // Where a failed property assignment goes. `remote.key = value` cannot be
    // awaited, so there is no caller to reject - without this a failure would
    // be silent. Defaults to reporting on the console.
    onerror?(error: unknown): void;
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
