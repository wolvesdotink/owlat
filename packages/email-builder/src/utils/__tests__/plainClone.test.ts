import { describe, it, expect } from 'vitest';
import { isProxy, reactive, ref } from 'vue';
import { plainClone } from '../plainClone';
import type { EditorBlock } from '../../types';

/**
 * History used `structuredClone` with a JSON fallback. The canvas is deeply
 * reactive, so the clone threw on every call and the fallback always ran; and
 * `toRaw` is not a fix on its own, because a block the canvas swaps in is a
 * raw object that still holds proxies spread out of the block it replaced.
 */

function collectProxies(value: unknown, found: string[] = [], path = '$'): string[] {
	if (value === null || typeof value !== 'object') return found;
	if (isProxy(value)) found.push(path);
	for (const [key, child] of Object.entries(value)) collectProxies(child, found, `${path}.${key}`);
	return found;
}

describe('plainClone', () => {
	it('copies a canvas whose swapped-in block still holds proxies', () => {
		const canvas = ref<EditorBlock[]>([
			{
				id: 'a',
				type: 'container',
				content: { items: [{ id: 'i', type: 'text', content: { html: 'x' } }] },
				savedBlockRef: { blockId: 's', groupId: 'g', blockName: 'Footer' },
			} as unknown as EditorBlock,
		]);
		// The property-update path: a new raw object built from the proxy.
		const old = canvas.value[0]!;
		canvas.value[0] = { ...old, content: { ...old.content } } as EditorBlock;

		expect(() => structuredClone(canvas.value)).toThrow();

		const copy = plainClone(canvas.value);
		expect(collectProxies(copy)).toEqual([]);
		expect(copy).toEqual(JSON.parse(JSON.stringify(canvas.value)));
		expect(copy).not.toBe(canvas.value);
	});

	it('keeps the JSON round trip rules the editor has always stored', () => {
		const state = reactive({
			kept: 1,
			dropped: undefined,
			list: [1, undefined, Number.NaN],
			when: new Date('2026-09-29T00:00:00.000Z'),
			nested: { deep: [{ x: 'y' }] },
		});
		expect(plainClone(state)).toEqual(JSON.parse(JSON.stringify(state)));
		expect('dropped' in plainClone(state)).toBe(false);
	});

	it('returns an independent copy', () => {
		const source = reactive({ nested: { value: 1 } });
		const copy = plainClone(source);
		copy.nested.value = 2;
		expect(source.nested.value).toBe(1);
	});
});
