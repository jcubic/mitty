/*
 * Mitty - use main thread objects from inside a Web Worker
 *
 * Copyright (c) 2026 Jakub T. Jankiewicz <https://jakub.jankiewicz.org>
 * Released under MIT license
 */
export { Host } from './host';
export type { HostOptions } from './host';
export { connect, dir } from './client';
export { describe, has_methods, repr, safe_key } from './values';
// RO/RPC protocol constants - see rpc/SPEC.md
export { CODES, VERSION, is_remote } from './protocol';
export type {
    Channel,
    ChannelEvent,
    ChannelListener,
    Client,
    ClientOptions,
    ErrorMarker,
    FunctionMarker,
    Arity,
    Description,
    Marker,
    Method,
    ObjectMarker,
    Param,
    Op,
    Remote,
    TypeName
} from './types';
