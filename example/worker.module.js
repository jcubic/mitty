// Module worker: mitty is imported (the ESM build). Started from the page with
// new Worker(url, { type: 'module' }).
import { connect } from '../dist/index.js';
import './demo.js';

self.addEventListener(
    'message',
    event => {
        self.demo(connect, event.data.channel);
    },
    { once: true },
);
