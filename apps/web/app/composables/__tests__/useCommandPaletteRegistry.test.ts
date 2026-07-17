// @vitest-environment happy-dom
/**
 * Lifecycle semantics for the reactive command-palette registration wrapper.
 *
 * The pure registry (`~/lib/commandPaletteRegistry`) guarantees first-claimant-
 * wins on id collisions; this wrapper must not contradict it. Exercised with
 * real mounted components (the repo's standard component-test setup) so the
 * `onMounted`/`onBeforeUnmount` wiring is driven end to end:
 *   - a provider registers on mount and is removed on unmount;
 *   - a second component reusing a live id is ignored (first registrant wins);
 *   - unmount removes by reference, so a stale same-id unmount can never delete
 *     the still-mounted survivor's registration (the defect the old remove-by-id
 *     path had).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ref, defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';
import type { CommandPaletteProvider } from '~/lib/commandPaletteRegistry';

// `useState` (Nuxt auto-import) gets per-key buckets so each test starts from an
// empty registry; the Vue lifecycle hooks and `toRaw` come from the shared setup.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let stateBuckets: Map<string, any>;
vi.stubGlobal('useState', (key: string, init: () => unknown) => {
	if (!stateBuckets.has(key)) stateBuckets.set(key, ref(init()));
	return stateBuckets.get(key);
});

import {
	useCommandPaletteRegistry,
	registerCommandPaletteProvider,
} from '../useCommandPaletteRegistry';

function makeProvider(id: string, priority = 0): CommandPaletteProvider {
	return { id, priority, build: () => [] };
}

/** A minimal component whose setup registers `provider` for its lifetime. */
function harness(provider: CommandPaletteProvider) {
	return defineComponent({
		setup() {
			registerCommandPaletteProvider(provider);
			return () => h('div');
		},
	});
}

beforeEach(() => {
	stateBuckets = new Map();
});

describe('registerCommandPaletteProvider', () => {
	it('registers on mount and removes on unmount', () => {
		const registry = useCommandPaletteRegistry();
		const provider = makeProvider('surface:a');

		const wrapper = mount(harness(provider));
		expect(registry.value).toEqual([provider]);

		wrapper.unmount();
		expect(registry.value).toEqual([]);
	});

	it('keeps independent providers registered until each one unmounts', () => {
		const registry = useCommandPaletteRegistry();
		const a = makeProvider('surface:a');
		const b = makeProvider('surface:b');

		const wrapperA = mount(harness(a));
		const wrapperB = mount(harness(b));
		expect(registry.value.map((entry) => entry.id)).toEqual(['surface:a', 'surface:b']);

		wrapperA.unmount();
		expect(registry.value).toEqual([b]);

		wrapperB.unmount();
		expect(registry.value).toEqual([]);
	});

	it('ignores a duplicate id from a second live component (first registrant wins)', () => {
		const registry = useCommandPaletteRegistry();
		const original = makeProvider('surface:x', 0);
		const duplicate = makeProvider('surface:x', 99);

		const wrapperOriginal = mount(harness(original));
		const wrapperDuplicate = mount(harness(duplicate));

		// The first claimant stays; the duplicate never enters the registry.
		expect(registry.value).toEqual([original]);

		wrapperDuplicate.unmount();
		wrapperOriginal.unmount();
	});

	it('removes by reference, so a stale duplicate unmount leaves the survivor intact', () => {
		const registry = useCommandPaletteRegistry();
		const original = makeProvider('surface:x', 0);
		const duplicate = makeProvider('surface:x', 99);

		const wrapperOriginal = mount(harness(original));
		const wrapperDuplicate = mount(harness(duplicate));
		expect(registry.value).toEqual([original]);

		// Unmounting the ignored duplicate must not delete the original's entry
		// (the old remove-by-id path deleted the survivor here).
		wrapperDuplicate.unmount();
		expect(registry.value).toEqual([original]);

		wrapperOriginal.unmount();
		expect(registry.value).toEqual([]);
	});
});
