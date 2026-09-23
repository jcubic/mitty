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

export function encode_error(error: Error): ErrorMarker {
    return {
        type: 'error',
        data: [error.name, error.message, error.stack ?? null],
    };
}

export function decode_error(marker: ErrorMarker): Error {
    const [name, message, stack] = marker.data;
    const error = new Error(message);
    error.name = name;
    if (stack !== null) {
        // keep the host's stack - it points at where the call actually failed,
        // which is far more useful than a stack inside this library
        error.stack = stack;
    }
    return error;
}

function is_marker(value: unknown): value is Marker {
    return (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as Marker).type === 'string' &&
        Array.isArray((value as Marker).data)
    );
}

export function is_function_marker(value: unknown): value is FunctionMarker {
    return is_marker(value) && value.type === 'function';
}

export function is_object_marker(value: unknown): value is ObjectMarker {
    return is_marker(value) && value.type === 'object';
}

export function is_error_marker(value: unknown): value is ErrorMarker {
    return is_marker(value) && value.type === 'error';
}

export function invalid_handle(id: number): Error {
    return new Error(`mitty: invalid handle #${id} (released or never created)`);
}
