// The body of the example worker, shared by both loading styles. It assigns a
// global rather than exporting, because a classic worker pulls it in with
// importScripts() and that cannot load an ES module.
//
// Nothing here touches the DOM: `$` is a proxy, and every await is one message
// to the main thread.
self.demo = async function demo(connect, channel_name) {
    const { require, release } = connect(new BroadcastChannel(channel_name));

    const $ = require('$');
    const log = require('log');

    await log.write('worker started - no DOM in here');

    // build the list on the page from inside the worker
    await $('#list').empty();
    for (let i = 1; i <= 5; i++) {
        await $('#list').append(`<li>item ${i}</li>`);
    }

    // a whole chain is one round trip, not one per step
    const first = await $('#list li').first().text();
    await log.write(`first item: ${first}`);

    // keep a selection as a handle and go on querying it
    const list = await $('#list');
    const count = await list.find('li').length;
    await $('#count').text(`${count} items`);
    await log.write(`counted ${count} items through a handle`);

    // a callback that runs *in the worker*, called from the main thread
    const doubled = await require('util').map([1, 2, 3], n => n * 2);
    await log.write(`callback ran in the worker: ${doubled.join(', ')}`);

    // errors keep their message and stack
    try {
        await $('#list').nosuchmethod();
    } catch (error) {
        await log.write(`caught from the main thread: ${error.message}`);
    }

    // handles are never collected on their own - drop it when done
    release(list);
    await log.write('handle released, worker exiting');

    self.postMessage({ done: true });
    self.close();
};
