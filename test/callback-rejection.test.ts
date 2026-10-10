import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, module_pair } from './helpers';

afterEach(cleanup);

describe('callback rejection values', () => {
    it.each([
        { label: 'undefined', reason: undefined, message: 'undefined' },
        { label: 'null', reason: null, message: 'null' },
        { label: 'false', reason: false, message: 'false' },
        { label: 'zero', reason: 0, message: '0' },
        { label: 'an empty string', reason: '', message: '' },
        { label: 'a string', reason: 'callback failed', message: 'callback failed' },
        {
            label: 'a null-prototype object',
            reason: Object.create(null),
            message: 'Callback failed'
        },
        {
            label: 'an object whose toString throws',
            reason: {
                toString() {
                    throw new Error('cannot stringify');
                }
            },
            message: 'Callback failed'
        }
    ])(
        'propagates a callback rejection with $label as an Error',
        async ({ reason, message }) => {
            const { client } = module_pair('app', {
                run: async (callback: () => unknown) => {
                    try {
                        await callback();
                        return { rejected: false };
                    } catch (error) {
                        return {
                            rejected: true,
                            isError: error instanceof Error,
                            message: (error as Error).message
                        };
                    }
                }
            });
            const result = await client.require('app').run(() => Promise.reject(reason));
            expect(result).toEqual({
                rejected: true,
                isError: true,
                message
            });
        }
    );

    it('preserves an existing callback Error and its metadata', async () => {
        const { client } = module_pair('app', {
            run: async (callback: () => unknown) => {
                try {
                    await callback();
                    return { rejected: false };
                } catch (error) {
                    const failure = error as Error & { code?: number };
                    return {
                        rejected: true,
                        isError: failure instanceof Error,
                        name: failure.name,
                        message: failure.message,
                        stack: failure.stack,
                        code: failure.code
                    };
                }
            }
        });
        const failure = Object.assign(new TypeError('callback failed'), { code: 42 });
        const result = await client.require('app').run(() => {
            throw failure;
        });
        expect(result).toEqual({
            rejected: true,
            isError: true,
            name: failure.name,
            message: failure.message,
            stack: failure.stack,
            code: failure.code
        });
    });
});
