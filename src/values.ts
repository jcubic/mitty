/*
 * Mitty - use main thread objects from inside a Web Worker
 *
 * Copyright (c) 2026 Jakub T. Jankiewicz <https://jakub.jankiewicz.org>
 * Released under MIT license
 */

// -----------------------------------------------------------------------------
// Does this value only make sense with its methods attached?
//
// This is what the host decides by, unless a `remote` predicate says
// otherwise: a value it says yes to stays on the host behind a handle, and
// everything else is copied as JSON.
//
// Own properties are not enough to go by. A class keeps its methods on the
// prototype, so an instance looks like plain data right up until the worker
// calls a method on the copy and finds nothing there - which is the failure
// this default exists to prevent.
//
// Values JSON already carries faithfully are data even though their prototypes
// are full of methods: an array is still an array on the other side, and
// anything with toJSON() has already said how it wants to travel.
// -----------------------------------------------------------------------------
export function has_methods(value: unknown): boolean {
    if (value === null || typeof value !== 'object') {
        return false;
    }
    if (Array.isArray(value) || ArrayBuffer.isView(value)) {
        return false;
    }
    if (typeof (value as { toJSON?: unknown }).toJSON === 'function') {
        return false;
    }
    let proto: object | null = value;
    while (proto && proto !== Object.prototype) {
        for (const key of Object.getOwnPropertyNames(proto)) {
            if (key === 'constructor') {
                continue;
            }
            // read the descriptor rather than the property: a getter is not a
            // method, and invoking one to find that out could do anything
            const descriptor = Object.getOwnPropertyDescriptor(proto, key);
            if (typeof descriptor?.value === 'function') {
                return true;
            }
        }
        proto = Object.getPrototypeOf(proto) as object | null;
    }
    return false;
}
