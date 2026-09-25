import { describe, expect, it } from 'vitest';
import { has_methods } from '../src/index';

// what decides, by default, whether a value is copied to the worker or stays
// here behind a handle. JSON drops every function, so a value whose methods
// are the point of it cannot travel as data
describe('has_methods', () => {
    // the case that made this the default: LightningFS hands back a Stat
    // whose isFile() lives on the prototype, so a copy of the own properties
    // arrives in the worker with none of the behaviour
    class Stat {
        type: string;
        size: number;
        constructor(type: string, size: number) {
            this.type = type;
            this.size = size;
        }
        isFile() {
            return this.type === 'file';
        }
    }

    it('sees a method inherited from the prototype', () => {
        expect(has_methods(new Stat('file', 10))).toBe(true);
    });

    it('sees a method further up the chain', () => {
        class Special extends Stat {}
        expect(has_methods(new Special('file', 10))).toBe(true);
    });

    it('sees a method on a plain object', () => {
        expect(has_methods({ run: () => 1 })).toBe(true);
    });

    it('leaves a plain object of data alone', () => {
        expect(has_methods({ type: 'file', nested: { size: 1 } })).toBe(false);
    });

    it('leaves an array alone', () => {
        // Array.prototype is nothing but methods, yet an array is still an
        // array on the other side
        expect(has_methods([1, 2, 3])).toBe(false);
        expect(has_methods([{ a: 1 }])).toBe(false);
    });

    it('leaves binary data alone', () => {
        expect(has_methods(new Uint8Array([1, 2, 3]))).toBe(false);
    });

    it('leaves a value that serializes itself alone', () => {
        // toJSON() means the value has already said how it wants to travel
        expect(has_methods(new Date())).toBe(false);
    });

    it('leaves a null-prototype bag of data alone', () => {
        const value = Object.create(null) as Record<string, number>;
        value.a = 1;
        expect(has_methods(value)).toBe(false);
    });

    it('is not fooled by a getter', () => {
        const value = {
            get label() {
                return 'x';
            }
        };
        expect(has_methods(value)).toBe(false);
    });

    it('does not read a getter to find out', () => {
        let read = 0;
        const value = {
            get boom() {
                read++;
                throw new Error('should not be read');
            }
        };
        expect(() => has_methods(value)).not.toThrow();
        expect(read).toBe(0);
    });

    it('says no for a function', () => {
        // Function.prototype is full of methods, but a function is not an
        // object with behaviour bolted on - it is the behaviour
        expect(has_methods(() => 1)).toBe(false);
    });

    it('says no for primitives and null', () => {
        expect(has_methods(null)).toBe(false);
        expect(has_methods(undefined)).toBe(false);
        expect(has_methods('string')).toBe(false);
        expect(has_methods(42)).toBe(false);
    });
});
