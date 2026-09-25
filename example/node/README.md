# Mitty over a WebSocket

cheerio lives on the server. The browser drives it with the same `require('$')` chains the
worker example uses on jQuery — no markup is sent to the page, and cheerio never runs in
the browser.

This is the worker example turned inside out. There the page held the objects and the
worker reached for them; here Node holds them and the browser reaches across a socket.

## Running it

```bash
npm run build      # in the repo root - the page imports the local build
cd example/node
npm install
npm start          # PORT=3001 npm start to use another port
```

Then open <http://localhost:3000>.

## What it shows

|                                  |                                                                                                                                               |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **A socket is a channel**        | Only `send()` needs renaming to `postMessage()`; the three members in `Channel` are all mitty asks for.                                       |
| **One message per chain**        | `$(sel).first().text().toUpperCase()` is four steps and one frame. `.toUpperCase()` runs in Node.                                             |
| **Handles**                      | A cheerio object has methods, so it stays on the server and arrives as a handle you call back into.                                           |
| **Callbacks**                    | `$(sel).each(index => …)` runs the callback _in the browser_, called from Node.                                                               |
| **Arity trimming**               | cheerio passes the element to `each()` too. The callback declares only `index`, so the element — which cannot cross a socket — is never sent. |
| **Errors**                       | A bad selector arrives as a real `Error` with cheerio's own message.                                                                          |
| **Mutation sticks**              | "mark the first item" edits the server's document; `$.html()` shows it changed.                                                               |
| **One socket, one conversation** | Each connection gets its own `Host` and its own document, so a second tab sees a pristine page.                                               |

## Two things to note

**`host.close()` is called when the socket drops.** mitty never closes a channel it was
handed and cannot see a socket go away, so the handles a host is holding would otherwise
stay alive for the life of the process.

**Anything `resolve()` answers is fully reachable.** Returning `$` lets a connected client
run any cheerio chain against that document — which is the point here, but on a real
server it is the whole security boundary. Return a narrow object of the operations you
mean to allow rather than a whole library.
