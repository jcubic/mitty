import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Client, Host } from '../src/index';
import { cleanup, pair } from './helpers';

// cheerio is jQuery's API on top of a parsed document, so it stands in for the
// real target of this library: objects that only exist on the main thread and
// cannot be structured-cloned into a worker.
const HTML = `
<html>
  <body>
    <ul id="fruit">
      <li class="selected">Apple</li>
      <li>Banana</li>
      <li>Cherry</li>
    </ul>
    <div id="out"></div>
  </body>
</html>`;

function is_cheerio(value: unknown): boolean {
    return (
        typeof value === 'object' &&
        value !== null &&
        (value as { cheerio?: string }).cheerio === '[cheerio object]'
    );
}

describe('cheerio over the channel', () => {
    let $: cheerio.CheerioAPI;
    let client: Client;

    beforeEach(() => {
        $ = cheerio.load(HTML);
        ({ client } = pair({
            resolve: (name: string) => (name === '$' ? $ : null),
            serialize(this: Host, value: unknown) {
                if (is_cheerio(value)) {
                    return this.remote(value);
                }
                return value;
            }
        }));
    });

    afterEach(() => {
        cleanup();
    });

    it('runs a selector and reads a scalar property', async () => {
        const $remote = client.require('$');
        expect(await $remote('li').length).toBe(3);
    });

    it('reads text through a chain of calls', async () => {
        const $remote = client.require('$');
        expect(await $remote('li.selected').text()).toBe('Apple');
    });

    it('chains traversal methods in a single round trip', async () => {
        const $remote = client.require('$');
        expect(await $remote('#fruit').find('li').first().text()).toBe('Apple');
        expect(await $remote('#fruit').find('li').last().text()).toBe('Cherry');
    });

    it('reads an attribute', async () => {
        const $remote = client.require('$');
        expect(await $remote('ul').attr('id')).toBe('fruit');
    });

    it('holds a selection as a handle and keeps querying it', async () => {
        const $remote = client.require('$');
        const list = await $remote('#fruit');
        expect(await list.find('li').length).toBe(3);
        expect(await list.find('li').eq(1).text()).toBe('Banana');
    });

    it('mutates the real document on the host', async () => {
        const $remote = client.require('$');
        await $remote('#out').text('written from the client');
        expect($('#out').text()).toBe('written from the client');
    });

    it('adds a class that is visible on the host', async () => {
        const $remote = client.require('$');
        await $remote('li').addClass('touched');
        expect($('li.touched').length).toBe(3);
        expect(await $remote('li.touched').length).toBe(3);
    });

    it('collects text from each element via a client callback', async () => {
        const $remote = client.require('$');
        const texts: string[] = [];
        const count = await $remote('li').length;
        for (let i = 0; i < count; i++) {
            texts.push(await $remote('li').eq(i).text());
        }
        expect(texts).toEqual(['Apple', 'Banana', 'Cherry']);
    });

    it('continues a chain onto a primitive returned by the host', async () => {
        const $remote = client.require('$');
        // .text() resolves to a string on the host, .toUpperCase() is then
        // applied to that string in the same round trip
        expect(await $remote('li.selected').text().toUpperCase()).toBe('APPLE');
    });
});
