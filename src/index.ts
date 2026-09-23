/*
 * Mitty - use main thread objects from inside a Web Worker
 *
 * Copyright (c) 2026 Jakub T. Jankiewicz <https://jakub.jankiewicz.org>
 * Released under MIT license
 */
export { Host } from './host';
export type { HostOptions } from './host';
export { connect } from './client';
export type {
    Channel,
    ChannelEvent,
    ChannelListener,
    Client,
    ErrorMarker,
    FunctionMarker,
    Marker,
    ObjectMarker,
    Op,
    Remote,
} from './types';
