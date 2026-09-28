/*
 * Mitty - use main thread objects from inside a Web Worker
 *
 * Copyright (c) 2026 Jakub T. Jankiewicz <https://jakub.jankiewicz.org>
 * Released under MIT license
 */
import type { Description, Method, Property, TypeName } from './types';

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

// -----------------------------------------------------------------------------
// May a chain walk through this key? This is the default for the Host's `get`
// and `set` options, and it is mitty's answer to RO/RPC §13.2, which leaves
// the policy to the implementation because the dangerous names differ by
// language.
//
// These three are the ways a JavaScript chain reaches a prototype object, and
// a `set` on a prototype reaches every object in the program - including ones
// the peer was never given. Reading is refused as well as writing, because the
// write that does the damage is `{get constructor}{get prototype}{set admin}`,
// whose own key is innocent.
//
// The cost is that `value.constructor.name` cannot be read across a channel.
// Compose this with a rule of your own to change that; see the README.
// -----------------------------------------------------------------------------
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function safe_key(key: string): boolean {
    return !UNSAFE_KEYS.has(key);
}

// -----------------------------------------------------------------------------
// The default `repr`: what a handle looks like when something asks the client
// for a string. A handle has no data on the client side, so there is nothing
// there to build a name from - this runs on the host, against the real object,
// and the result travels with the handle.
//
// The constructor name is all a general rule can honestly offer. An
// application that knows its own types should say so itself:
//
//     import { repr } from '@jcubic/mitty';
//
//     new Host({ channel, resolve, repr(value) {
//         if (value instanceof $.fn.init) return `#<jQuery [${value.length}]>`;
//         if (value instanceof Element) return `<${value.tagName} />`;
//         return repr(value);   // this one, not the option - a method
//     }});                      // shorthand does not bind its own name
// -----------------------------------------------------------------------------
export function repr(value: unknown): string {
    if (value === null || typeof value !== 'object') {
        return `#<${typeof value}>`;
    }
    const name = (value as { constructor?: { name?: unknown } }).constructor?.name;
    return `#<${typeof name === 'string' && name ? name : 'object'}>`;
}

// -----------------------------------------------------------------------------
// Name a value the way RO/RPC §8.3.1 names types. `remote` rather than
// `object` when the value is one the host would keep behind a handle, because
// that is what the client will actually receive.
// -----------------------------------------------------------------------------
// Is `toJSON` something that can be looked at without being run? has_methods()
// reads it plainly, to spot a value that has already said how it travels, and
// a plain read invokes an accessor. That is the right thing when serializing,
// where JSON.stringify is about to read it anyway - but describing a value must
// run nothing at all, so this is asked first.
function reads_cleanly(value: object): boolean {
    let proto: object | null = value;
    while (proto) {
        const descriptor = Object.getOwnPropertyDescriptor(proto, 'toJSON');
        if (descriptor) {
            // the nearest definition is the one a read would reach
            return !descriptor.get && !descriptor.set;
        }
        proto = Object.getPrototypeOf(proto) as object | null;
    }
    return true;
}

function type_of(value: unknown): TypeName | undefined {
    if (value === null) {
        return 'null';
    }
    if (Array.isArray(value)) {
        return 'array';
    }
    switch (typeof value) {
        case 'string':
        case 'number':
        case 'boolean':
        case 'function':
            return typeof value;
        case 'object':
            if (!reads_cleanly(value)) {
                // whether this travels as data or as a handle turns on what
                // that accessor gives back, and finding out means running it
                return undefined;
            }
            return has_methods(value) ? 'remote' : 'object';
        default:
            // undefined, symbol, bigint - nothing JSON carries, and nothing
            // §8.3.1 names. Better unstated than wrong
            return undefined;
    }
}

// -----------------------------------------------------------------------------
// The default for the Host's `describe` option: what `value` can do and what
// holds, each sorted by name.
//
// The prototype chain is walked for the same reason has_methods() walks it - a
// class keeps its methods there, so own properties alone would describe almost
// nothing. Object.prototype and Function.prototype are the floor: `toString`
// and `call` are on everything and say nothing about this value.
//
// What goes unsaid is as deliberate as what is said. A method's `result` is
// absent because a JavaScript function does not carry a return type. A
// parameter's name and type are absent because they are not recoverable - a
// minified `find(e, t)` has lost them. `arity.required` is Function.length,
// which counts the parameters before the first default, so
// `append(node, mode = 'after')` reports 1 and cannot say a second is taken.
// A host that knows its own API should supply its own `describe`.
// -----------------------------------------------------------------------------
export function describe(value: unknown): Description {
    const methods = new Map<string, Method>();
    const properties = new Map<string, Property>();
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
        return { methods: [], properties: [] };
    }
    let proto: object | null = value as object;
    while (proto && proto !== Object.prototype && proto !== Function.prototype) {
        for (const key of Object.getOwnPropertyNames(proto)) {
            // a nearer definition shadows a further one, so the first sighting
            // of a name is the one that would actually be reached
            if (key === 'constructor' || methods.has(key) || properties.has(key)) {
                continue;
            }
            // the descriptor, not the property: reading a getter to find out
            // what it is could do anything
            const descriptor = Object.getOwnPropertyDescriptor(proto, key);
            if (!descriptor) {
                continue;
            }
            if (typeof descriptor.value === 'function') {
                methods.set(key, {
                    name: key,
                    params: { arity: { required: descriptor.value.length } }
                });
                continue;
            }
            if (descriptor.get || descriptor.set) {
                // an accessor: writable is knowable, the type is not
                properties.set(key, { name: key, readonly: !descriptor.set });
                continue;
            }
            const type = type_of(descriptor.value);
            properties.set(key, {
                name: key,
                readonly: !descriptor.writable,
                ...(type ? { type: [type] } : {})
            });
        }
        proto = Object.getPrototypeOf(proto) as object | null;
    }
    const by_name = <T extends { name: string }>(entries: Map<string, T>): T[] =>
        [...entries.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
    return { methods: by_name(methods), properties: by_name(properties) };
}
