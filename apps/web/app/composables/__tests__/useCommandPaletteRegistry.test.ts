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
import { describe, it, expect, afterEach } from 'vitest';
import { computed, defineComponent, h, isProxy, isReactive } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import type { CommandPaletteProvider } from '~/lib/commandPaletteRegistry';
import {
	useCommandPaletteRegistry,
	registerCommandPaletteProvider,
} from '../useCommandPaletteRegistry';

// The registry is module state, so isolation comes from
// unmounting every harness after each test: an unmount is the only way out.
const mounted: VueWrapper[] = [];
function mountTracked(component: ReturnType<typeof defineComponent>): VueWrapper {
	const wrapper = mount(component);
	mounted.push(wrapper);
	return wrapper;
}
afterEach(() => {
	while (mounted.length) {
		const wrapper = mounted.pop()!;
		if (wrapper.vm.$.isUnmounted) continue;
		wrapper.unmount();
	}
	expect(useCommandPaletteRegistry().value).toEqual([]);
});

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

describe('registerCommandPaletteProvider', () => {
	it('registers on mount and removes on unmount', () => {
		const registry = useCommandPaletteRegistry();
		const provider = makeProvider('surface:a');

		const wrapper = mountTracked(harness(provider));
		expect(registry.value).toEqual([provider]);

		wrapper.unmount();
		expect(registry.value).toEqual([]);
	});

	it('keeps independent providers registered until each one unmounts', () => {
		const registry = useCommandPaletteRegistry();
		const a = makeProvider('surface:a');
		const b = makeProvider('surface:b');

		const wrapperA = mountTracked(harness(a));
		const wrapperB = mountTracked(harness(b));
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

		const wrapperOriginal = mountTracked(harness(original));
		const wrapperDuplicate = mountTracked(harness(duplicate));

		// The first claimant stays; the duplicate never enters the registry.
		expect(registry.value).toEqual([original]);

		wrapperDuplicate.unmount();
		wrapperOriginal.unmount();
	});

	it('removes by reference, so a stale duplicate unmount leaves the survivor intact', () => {
		const registry = useCommandPaletteRegistry();
		const original = makeProvider('surface:x', 0);
		const duplicate = makeProvider('surface:x', 99);

		const wrapperOriginal = mountTracked(harness(original));
		const wrapperDuplicate = mountTracked(harness(duplicate));
		expect(registry.value).toEqual([original]);

		// Unmounting the ignored duplicate must not delete the original's entry
		// (the old remove-by-id path deleted the survivor here).
		wrapperDuplicate.unmount();
		expect(registry.value).toEqual([original]);

		wrapperOriginal.unmount();
		expect(registry.value).toEqual([]);
	});
});

describe('registry state', () => {
	it('stores providers raw, so their closures are never wrapped in reactive proxies', () => {
		const registry = useCommandPaletteRegistry();
		const provider = makeProvider('surface:raw');
		mountTracked(harness(provider));

		const stored = registry.value[0]!;
		expect(stored).toBe(provider);
		expect(isProxy(stored)).toBe(false);
		expect(isReactive(registry.value)).toBe(false);
	});

	it('re-runs a reader on registration and removal, not on edits inside a provider', () => {
		const registry = useCommandPaletteRegistry();
		let runs = 0;
		const ids = computed(() => {
			runs += 1;
			return registry.value.map((entry) => entry.id);
		});
		expect(ids.value).toEqual([]);

		const wrapper = mountTracked(harness(makeProvider('surface:a')));
		expect(ids.value).toEqual(['surface:a']);
		const afterRegister = runs;

		// Touching a field inside a registered provider is not a registry change.
		(registry.value[0] as { priority: number }).priority = 42;
		expect(ids.value).toEqual(['surface:a']);
		expect(runs).toBe(afterRegister);

		wrapper.unmount();
		expect(ids.value).toEqual([]);
	});

	it('lets a surface that unmounts and remounts claim its id again', () => {
		const registry = useCommandPaletteRegistry();
		const first = makeProvider('surface:again');
		mountTracked(harness(first)).unmount();
		const second = makeProvider('surface:again');
		mountTracked(harness(second));
		expect(registry.value).toEqual([second]);
		expect(registry.value[0]).toBe(second);
	});
});
