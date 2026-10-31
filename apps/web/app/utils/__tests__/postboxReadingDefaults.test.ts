/**
 * The Reading card's defaults are what `usePostboxSettings` resolves a
 * never-saved settings row to. The switches have no option module of their
 * own, so this is what keeps the card's "changed" marker and its Reset from
 * drifting away from the composable's `?? true` / `?? false` fallbacks.
 */
import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { POSTBOX_READING_DEFAULTS } from '../postboxReadingDefaults';
import { usePostboxSettings } from '~/composables/postbox/usePostboxSettings';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

describe('POSTBOX_READING_DEFAULTS', () => {
	it('matches what an empty settings row resolves to', () => {
		vi.stubGlobal('useConvexQuery', () => ({ data: ref({}), isLoading: ref(false) }));
		vi.stubGlobal('useBackendOperation', () => ({ run: vi.fn(), isLoading: ref(false) }));
		vi.stubGlobal('useFeatureFlag', () => ({ isEnabled: () => true }));

		const settings = usePostboxSettings() as unknown as Record<string, { value: unknown }>;
		const resolved = Object.fromEntries(
			Object.keys(POSTBOX_READING_DEFAULTS).map((field) => [field, settings[field]?.value])
		);
		expect(resolved).toEqual(POSTBOX_READING_DEFAULTS);
	});
});
