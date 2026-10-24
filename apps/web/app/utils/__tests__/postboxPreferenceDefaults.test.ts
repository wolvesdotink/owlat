/**
 * The Preferences defaults outside the Reading card are what
 * `usePostboxSettings` resolves a never-saved settings row to. The switches
 * have no option module of their own, so this is what keeps each card's
 * "changed" marker and its Reset from drifting away from the composable's
 * `?? true` / `?? false` fallbacks.
 */
import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { POSTBOX_PREFERENCE_DEFAULTS, isSameQuietHours } from '../postboxPreferenceDefaults';
import { defaultPostboxNotifyAbout } from '../postboxNotify';
import { usePostboxSettings } from '~/composables/postbox/usePostboxSettings';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

function resolveEmptyRow(aiEnabled: boolean) {
	vi.stubGlobal('useConvexQuery', () => ({ data: ref({}), isLoading: ref(false) }));
	vi.stubGlobal('useBackendOperation', () => ({ run: vi.fn(), isLoading: ref(false) }));
	vi.stubGlobal('useFeatureFlag', () => ({
		isEnabled: (flag: string) => aiEnabled && flag === 'ai',
	}));
	return usePostboxSettings() as unknown as Record<string, { value: unknown }>;
}

describe('POSTBOX_PREFERENCE_DEFAULTS', () => {
	it('matches what an empty settings row resolves to', () => {
		const settings = resolveEmptyRow(true);
		const resolved = Object.fromEntries(
			Object.keys(POSTBOX_PREFERENCE_DEFAULTS).map((field) => [field, settings[field]?.value])
		);
		expect(resolved).toEqual(POSTBOX_PREFERENCE_DEFAULTS);
	});

	it('leaves the notification scope to the categories-aware default', () => {
		expect(resolveEmptyRow(true).notifyAbout?.value).toBe(defaultPostboxNotifyAbout(true));
		expect(resolveEmptyRow(false).notifyAbout?.value).toBe(defaultPostboxNotifyAbout(false));
	});
});

describe('isSameQuietHours', () => {
	const copyDefault = () => {
		const fallback = POSTBOX_PREFERENCE_DEFAULTS.quietHours;
		return { ...fallback, days: [...fallback.days] };
	};
	const base = copyDefault();

	it('compares by window, not by object identity', () => {
		expect(isSameQuietHours(base, copyDefault())).toBe(true);
	});

	it('tells any changed part apart', () => {
		expect(isSameQuietHours(base, { ...base, enabled: !base.enabled })).toBe(false);
		expect(isSameQuietHours(base, { ...base, startMinute: base.startMinute + 1 })).toBe(false);
		expect(isSameQuietHours(base, { ...base, endMinute: base.endMinute + 1 })).toBe(false);
		expect(isSameQuietHours(base, { ...base, days: base.days.slice(1) })).toBe(false);
	});
});
