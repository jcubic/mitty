import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, module_pair, pair } from './helpers';

afterEach(() => {
    cleanup();
});

// shaped like the DOM the cross-tab example drives: an element with methods on
// the prototype, so it crosses as a handle, holding a style object of its own
class Style {
    color = 'black';
    background = 'white';
    setProperty(name: string, value: string) {
        (this as unknown as Record<string, string>)[name] = value;
    }
}

class Element {
    readonly style = new Style();
    name = '';
    getAttribute(key: string) {
        return key;
    }
}

function dom_pair() {
    const body = new Element();
    const { client } = module_pair('document', { querySelector: () => body });
    return { body, client };
}

// an assignment cannot be awaited - `a.b = c` evaluates to `c` and the trap has
// to answer synchronously - so a set is sent the moment it happens
describe('setting a property', () => {
    it('sets a property on a handle', async () => {
        const { body, client } = dom_pair();
        const element = await client.require('document').querySelector('body');
        element.name = 'the-body';
        await vi.waitUntil(() => body.name === 'the-body');
        expect(body.name).toBe('the-body');
    });

    it('sets a property reached through a chain', async () => {
        const { body, client } = dom_pair();
        const element = await client.require('document').querySelector('body');
        element.style.color = 'rebeccapurple';
        await vi.waitUntil(() => body.style.color === 'rebeccapurple');
        expect(body.style.color).toBe('rebeccapurple');
    });

    it('sets a property on a module', async () => {
        const config = { debug: false };
        const { client } = module_pair('config', config);
        client.require('config').debug = true;
        await vi.waitUntil(() => config.debug === true);
        expect(config.debug).toBe(true);
    });

    it('is visible to a read that follows it', async () => {
        // ordering: the set is already on the wire when the get is sent
        const { client } = dom_pair();
        const element = await client.require('document').querySelector('body');
        element.style.color = 'red';
        expect(await element.style.color).toBe('red');
    });

    it('evaluates to the assigned value, as an assignment does', async () => {
        const { client } = dom_pair();
        const element = await client.require('document').querySelector('body');
        // not a promise - this is what `a.b = c` means in JavaScript
        expect((element.style.color = 'blue')).toBe('blue');
    });

    it('sets a name or length without tripping a proxy invariant', async () => {
        // the chain's target is a function, and those carry their own
        // non-writable `name` and `length`
        const { body, client } = dom_pair();
        const element = await client.require('document').querySelector('body');
        expect(() => {
            element.name = 'nom';
        }).not.toThrow();
        await vi.waitUntil(() => body.name === 'nom');
        expect(body.name).toBe('nom');
    });

    it('still lets setProperty() work, awaited', async () => {
        const { body, client } = dom_pair();
        const element = await client.require('document').querySelector('body');
        await element.style.setProperty('color', 'green');
        expect(body.style.color).toBe('green');
    });
});

describe('a set that fails', () => {
    it('reports to onerror instead of vanishing', async () => {
        const errors: unknown[] = [];
        const { client } = pair(
            { resolve: () => ({ nothing: null }) },
            { onerror: error => errors.push(error) }
        );
        // setting a property of null cannot work on the host
        client.require('m').nothing.oops = 1;
        await vi.waitUntil(() => errors.length > 0);
        expect(String(errors[0])).toMatch(/cannot set/i);
    });

    it('reports on the console when no handler is given', async () => {
        // the failure is caught either way - an uncaught rejection here would
        // be unreachable, since no caller holds the promise
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const { client } = pair({ resolve: () => ({ nothing: null }) });
        client.require('m').nothing.oops = 1;
        await vi.waitUntil(() => spy.mock.calls.length > 0);
        expect(String(spy.mock.calls[0])).toMatch(/cannot set/i);
        spy.mockRestore();
    });
});
