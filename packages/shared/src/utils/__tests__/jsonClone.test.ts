import { describe, expect, it } from 'vitest';
import { jsonClone } from '../jsonClone';

describe('jsonClone', () => {
	it('copies as a JSON round trip would', () => {
		const value = {
			kept: 1,
			dropped: undefined,
			fn: () => 1,
			list: [1, undefined, Number.NaN, Number.POSITIVE_INFINITY, () => 1],
			when: new Date('2026-10-01T00:00:00.000Z'),
			nested: { deep: [{ x: 'y', flag: false, none: null }] },
			custom: { toJSON: () => ({ replaced: true }) },
		};
		const copy = jsonClone(value);
		expect(copy).toEqual(JSON.parse(JSON.stringify(value)));
		expect('dropped' in copy).toBe(false);
	});

	it('returns an independent copy', () => {
		const source = { nested: { value: 1 }, list: [{ value: 1 }] };
		const copy = jsonClone(source);
		copy.nested.value = 2;
		copy.list[0]!.value = 2;
		expect(source).toEqual({ nested: { value: 1 }, list: [{ value: 1 }] });
	});

	it('copies through a proxy, which structuredClone refuses', () => {
		const target = { id: 'a', content: { items: [{ id: 'b' }] } };
		const proxied = new Proxy(target, {});
		expect(() => structuredClone(proxied)).toThrow();
		expect(jsonClone(proxied)).toEqual(target);
	});

	it('keeps a "__proto__" key as an own property, as JSON.parse does', () => {
		const parsed = JSON.parse('{"__proto__":{"polluted":true},"id":"a"}') as Record<
			string,
			unknown
		>;
		const copy = jsonClone(parsed);
		expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
		expect(Object.keys(copy)).toEqual(['__proto__', 'id']);
		expect(copy).toEqual(JSON.parse(JSON.stringify(parsed)));
		expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
	});
});
