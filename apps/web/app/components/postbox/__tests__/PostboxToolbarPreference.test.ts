// @vitest-environment happy-dom
/**
 * Toolbar preference semantics (the state the composer's "Aa" toggle drives).
 * The preference defaults to the minimal floating bar and flips reactively when
 * toggled; durable persistence is delegated to `useLocalStorage` (browser-only,
 * so not exercised here).
 */
import { describe, it, expect } from 'vitest';
import { useLocalStorage } from '~/composables/useLocalStorage';

const KEY = 'postbox-composer-persistent-toolbar';

describe('composer toolbar preference', () => {
	it('defaults to the minimal floating bar (false)', () => {
		const { data } = useLocalStorage(KEY, false);
		expect(data.value).toBe(false);
	});

	it('toggling switches the mode reactively', () => {
		const { data, set } = useLocalStorage(KEY, false);
		set(!data.value);
		expect(data.value).toBe(true);
		set(!data.value);
		expect(data.value).toBe(false);
	});
});
