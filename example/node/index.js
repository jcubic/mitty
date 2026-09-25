/*
 * Mitty over a WebSocket: cheerio lives on the server, the browser drives it.
 *
 * This is the worker example turned inside out. There, the page held jQuery
 * and the worker reached for it. Here the server holds a cheerio document and
 * the browser reaches for that instead - the same `require('$')` chains, with
 * a socket in place of a channel.
 */
import express from 'express';
import { WebSocketServer } from 'ws';
import * as cheerio from 'cheerio';
import { fileURLToPath } from 'url';
import path from 'path';
import { Host } from '@jcubic/mitty';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const port = process.env.PORT ?? 3000;

// -----------------------------------------------------------------------------
// The document the browser will be querying. It only ever exists here: no
// markup is sent to the page, and cheerio never runs in the browser.
// -----------------------------------------------------------------------------
const PAGE = `
<!doctype html>
<html>
  <head><title>A page that lives on the server</title></head>
  <body>
    <h1>Groceries</h1>
    <ul id="list">
      <li class="item">Coffee</li>
      <li class="item">Oat milk</li>
      <li class="item">Cardamom</li>
    </ul>
    <p class="note">Nothing here was ever parsed in a browser.</p>
  </body>
</html>
`;

// -----------------------------------------------------------------------------
// A WebSocket is already a two-way stream of messages, which is all a mitty
// channel has to be. The only mismatch is the name: a socket sends with
// send(), a channel with postMessage().
// -----------------------------------------------------------------------------
function channel(socket) {
    return {
        postMessage: message => socket.send(message),
        addEventListener: (type, listener) => socket.addEventListener(type, listener),
        removeEventListener: (type, listener) =>
            socket.removeEventListener(type, listener)
    };
}

const app = express();

app.get('/', (req, res) => {
    res.sendFile('./index.html', { root: __dirname });
});

// the page imports mitty from here. Built from this repo, so `npm run build`
// in the repo root has to have run at least once; a published version would
// come from a CDN instead
app.get('/mitty.js', (req, res) => {
    res.type('application/javascript');
    res.sendFile(path.join(__dirname, '../../dist/index.js'));
});

const server = app.listen(port, () => {
    console.log(`mitty websocket example on http://localhost:${port}`);
});

// -----------------------------------------------------------------------------
// One socket is one conversation, so every connection gets a Host and a
// document of its own. Two browsers editing the same cheerio tree would
// otherwise see each other's changes, and their request ids would collide.
// -----------------------------------------------------------------------------
new WebSocketServer({ server }).on('connection', socket => {
    const $ = cheerio.load(PAGE);

    const modules = {
        // the whole cheerio API, the way the worker example exposes jQuery
        $: () => $,
        // a plain object, to show what gets copied rather than kept here
        server: () => ({
            node: process.version,
            pid: process.pid,
            now: () => new Date().toISOString()
        })
    };

    const host = new Host({
        channel: channel(socket),
        resolve(name) {
            return Object.hasOwn(modules, name) ? modules[name]() : null;
        }
    });

    // mitty never closes a channel it was handed, and it cannot see the socket
    // drop - so the handles this host is holding are released here
    socket.on('close', () => host.close());
});
