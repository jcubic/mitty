// Classic worker: mitty is pulled in with importScripts() and shows up as the
// `Mitty` global (the IIFE build).
importScripts('../dist/index.global.js', './demo.js');

self.addEventListener(
    'message',
    event => {
        self.demo(Mitty.connect, event.data.channel);
    },
    { once: true },
);
