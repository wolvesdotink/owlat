import { describe, it, expect, vi } from 'vitest';
import { ref } from 'vue';

/**
 * Upgrade guard for the persisted sidebar section map.
 *
 * The section keys were renamed and extended ('settings' → 'administration',
 * 'preferences' added, 'delivery' removed), so every existing user's stored
 * object is missing the new keys. `useLocalStorage` returns stored JSON verbatim
 * and the sidebar tests each key for truthiness, so a verbatim read would render
 * the new sections collapsed exactly once — silently, right after an upgrade.
 *
 * `useSidebarState` reads its storage at module scope, so the stub (seeded with a
 * pre-rename object) has to be installed before the dynamic import below.
 */
const LEGACY_STORED_SECTIONS = {
	inbox: true,
	postbox: true,
	chat: true,
	assistant: true,
	// A section the user had deliberately collapsed — must survive the merge.
	send: false,
	knowledge: true,
	audience: true,
	// Pre-rename / removed keys: no 'administration', no 'preferences'.
	settings: true,
	delivery: false,
};

const store: Record<string, unknown> = {
	'sidebar-sections': { ...LEGACY_STORED_SECTIONS },
};

vi.stubGlobal('useLocalStorage', <T>(key: string, defaultValue: T) => {
	const data = ref<T>((key in store ? store[key] : defaultValue) as T);
	return {
		data,
		set: (value: T) => {
			data.value = value;
			store[key] = value;
		},
	};
});

const { useSidebarState } = await import('../useSidebarState');

describe('useSidebarState persisted sections', () => {
	it('falls back to the default for keys the stored object predates', () => {
		const s = useSidebarState();
		// The regression: 'administration' replaced 'settings', so it is absent
		// from every pre-upgrade stored object and must not read as collapsed.
		expect(s.isSectionExpanded('administration')).toBe(true);
		expect(s.isSectionExpanded('preferences')).toBe(true);
	});

	it('keeps the stored value for keys that are still sections', () => {
		const s = useSidebarState();
		expect(s.isSectionExpanded('send')).toBe(false);
		expect(s.isSectionExpanded('inbox')).toBe(true);
	});

	it('exposes only current section keys', () => {
		const s = useSidebarState();
		expect(Object.keys(s.sectionStates.value).sort()).toEqual([
			'administration',
			'assistant',
			'audience',
			'chat',
			'inbox',
			'knowledge',
			'postbox',
			'preferences',
			'send',
		]);
	});

	it('drops keys for sections that no longer exist on the next write', () => {
		const s = useSidebarState();
		s.toggleSection('inbox');
		const persisted = store['sidebar-sections'] as Record<string, unknown>;
		expect(persisted).not.toHaveProperty('settings');
		expect(persisted).not.toHaveProperty('delivery');
		expect(persisted.administration).toBe(true);
		expect(persisted.inbox).toBe(false);
		expect(s.isSectionExpanded('inbox')).toBe(false);
	});
});
