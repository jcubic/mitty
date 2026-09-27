/*
 * Mitty - use main thread objects from inside a Web Worker
 *
 * Copyright (c) 2026 Jakub T. Jankiewicz <https://jakub.jankiewicz.org>
 * Released under MIT license
 */
import type { ErrorMarker, FunctionMarker, Marker, ObjectMarker } from './types';

// key used to read the root/ops out of a chain proxy without going through the
// get trap's normal "record another step" behaviour. Symbol.for() so two copies
// of the library (e.g. a bundled one and one from a CDN) still recognise each
// other's proxies.
export const HANDLE = Symbol.for('@jcubic/mitty/handle');

// -----------------------------------------------------------------------------
// A chain is a Proxy around a function, because any step in it may turn out to
// be a call. So `typeof chain` is 'function' and a library that duck-types for
// a callable will treat it as one - jQuery Terminal's echo() calls .bind() on
// it with one of its own objects, and that object then has to cross the
// channel. This is the way to tell the two apart. It reads the same symbol
// `connect()` answers, so a library need not import mitty to use it:
//
//     const HANDLE = Symbol.for('@jcubic/mitty/handle');
//     if (typeof value === 'function' && !value[HANDLE]) { ... }
//
// -----------------------------------------------------------------------------
export function is_remote(value: unknown): boolean {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
        return false;
    }
    const info = (value as Record<symbol, unknown>)[HANDLE];
    return typeof info === 'object' && info !== null;
}

// -----------------------------------------------------------------------------
// The RO/RPC version carried by every message - see rpc/SPEC.md §5. Peers are
// compatible when the MAJOR parts match; a MINOR increment only ever adds.
// -----------------------------------------------------------------------------
export const VERSION = '1.0';

const MAJOR = VERSION.slice(0, VERSION.indexOf('.'));
const WELL_FORMED = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function compatible(version: unknown): boolean {
    if (typeof version !== 'string' || !WELL_FORMED.test(version)) {
        return false;
    }
    return version.slice(0, version.indexOf('.')) === MAJOR;
}

// -----------------------------------------------------------------------------
// Machine-readable causes (§9.2). -32768..-32000 is reserved for the protocol;
// an application may carry any other integer on an error of its own.
// -----------------------------------------------------------------------------
export const CODES = {
    INVALID_REQUEST: -32600,
    MODULE_NOT_FOUND: -32601,
    INVALID_HANDLE: -32602,
    INTERNAL: -32603,
    NO_INTROSPECTION: -32014,
    KEY_DENIED: -32013,
    VERSION_MISMATCH: -32012,
    CANNOT_SET: -32011,
    NOT_A_FUNCTION: -32010,
    APPLICATION: -32000
} as const;

export type Coded = Error & { code?: number };

// -----------------------------------------------------------------------------
function coded<E extends Error>(error: E, code: number): E & Coded {
    (error as E & Coded).code = code;
    return error as E & Coded;
}

export function invalid_request(message: string): Coded {
    return coded(new Error(`mitty: ${message}`), CODES.INVALID_REQUEST);
}

export function unknown_module(name: string): Coded {
    return coded(new Error(`mitty: unknown module '${name}'`), CODES.MODULE_NOT_FOUND);
}

export function invalid_handle(id: number): Coded {
    return coded(
        new Error(`mitty: invalid handle #${id} (released or never created)`),
        CODES.INVALID_HANDLE
    );
}

export function not_a_function(label: string): Coded {
    return coded(
        new TypeError(`mitty: ${label} is not a function`),
        CODES.NOT_A_FUNCTION
    );
}

export function cannot_set(label: string, key: string, target: unknown): Coded {
    return coded(
        new TypeError(`mitty: cannot set ${label}.${key} of ${String(target)}`),
        CODES.CANNOT_SET
    );
}

export function key_denied(label: string, key: string, action: string): Coded {
    return coded(
        new Error(`mitty: ${action} of ${label}.${key} is not permitted`),
        CODES.KEY_DENIED
    );
}

export function no_introspection(label: string): Coded {
    return coded(
        new Error(`mitty: the host does not introspect ${label}`),
        CODES.NO_INTROSPECTION
    );
}

export function internal(message: string): Coded {
    return coded(new TypeError(`mitty: ${message}`), CODES.INTERNAL);
}

export function version_mismatch(seen: unknown): Coded {
    const named = typeof seen === 'string' ? `'${seen}'` : 'none';
    return coded(
        new Error(`mitty: RO/RPC version ${named}, expected ${MAJOR}.x`),
        CODES.VERSION_MISMATCH
    );
}

// -----------------------------------------------------------------------------
// §6.3. `stack` and `code` are optional members - absent rather than null,
// which is what an object payload buys over the positional array it replaced.
// `fallback` is the code to use when the error carries none of its own.
// -----------------------------------------------------------------------------
export function encode_error(error: Error, fallback?: number): ErrorMarker {
    const own = (error as Coded).code;
    const code = typeof own === 'number' ? own : fallback;
    const data: ErrorMarker['__data__'] = {
        name: error.name,
        message: error.message
    };
    if (typeof error.stack === 'string') {
        data.stack = error.stack;
    }
    if (typeof code === 'number') {
        data.code = code;
    }
    return { __type__: 'error', __data__: data };
}

export function decode_error(marker: ErrorMarker): Coded {
    const { name, message, stack, code } = marker.__data__;
    // §6.3 says both are strings, but the peer decides what it sends. Without
    // this an object message becomes "[object Object]" and a numeric name
    // survives as a number, so a caller reading error.name gets something no
    // Error ever has
    const error: Coded = new Error(typeof message === 'string' ? message : '');
    error.name = typeof name === 'string' ? name : 'Error';
    if (typeof stack === 'string') {
        // keep the far side's stack - it points at where the call actually
        // failed, which is far more useful than a stack inside this library
        error.stack = stack;
    }
    if (typeof code === 'number') {
        // so a caller can branch on the cause rather than match the message
        error.code = code;
    }
    return error;
}

// -----------------------------------------------------------------------------
// §6. A marker is `{ __type__: string, __data__: object }`. The payload is an
// object rather than an array so that its members are named on the wire.
// -----------------------------------------------------------------------------
function is_marker(value: unknown): value is Marker {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const data = (value as Marker).__data__;
    return (
        typeof (value as Marker).__type__ === 'string' &&
        typeof data === 'object' &&
        data !== null &&
        !Array.isArray(data)
    );
}

export function is_function_marker(value: unknown): value is FunctionMarker {
    return is_marker(value) && value.__type__ === 'function';
}

export function is_object_marker(value: unknown): value is ObjectMarker {
    return is_marker(value) && value.__type__ === 'object';
}

export function is_error_marker(value: unknown): value is ErrorMarker {
    return is_marker(value) && value.__type__ === 'error';
}
