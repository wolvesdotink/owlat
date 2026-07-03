/**
 * usePostboxRailCollapsed: the folder-rail collapse state toggles and persists.
 * `useLocalStorage` is stubbed with an in-memory backing store so the persist
 * round-trip can be asserted without a real localStorage.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';
import { usePostboxRailCollapsed } from '../usePostboxRailCollapsed';

const store = new Map<string, unknown>();

beforeEach(() => {
	store.clear();
	vi.stubGlobal('useLocalStorage', (key: string, def: unknown) => {
		const data = ref(store.has(key) ? store.get(key) : def);
		const set = (value: unknown) => {
			data.value = value;
			store.set(key, value);
		};
		return { data, set };
	});
});

describe('usePostboxRailCollapsed', () => {
	it('defaults to expanded (not collapsed)', () => {
		const { collapsed } = usePostboxRailCollapsed();
		expect(collapsed.value).toBe(false);
	});

	it('toggle flips the state and persists it', () => {
		const { collapsed, toggle } = usePostboxRailCollapsed();
		toggle();
		expect(collapsed.value).toBe(true);
		expect(store.get('postbox-rail-collapsed')).toBe(true);
		toggle();
		expect(collapsed.value).toBe(false);
		expect(store.get('postbox-rail-collapsed')).toBe(false);
	});

	it('reads the persisted value back on a fresh call', () => {
		store.set('postbox-rail-collapsed', true);
		const { collapsed } = usePostboxRailCollapsed();
		expect(collapsed.value).toBe(true);
	});

	it('setCollapsed sets an explicit value', () => {
		const { collapsed, setCollapsed } = usePostboxRailCollapsed();
		setCollapsed(true);
		expect(collapsed.value).toBe(true);
		expect(store.get('postbox-rail-collapsed')).toBe(true);
	});
});
