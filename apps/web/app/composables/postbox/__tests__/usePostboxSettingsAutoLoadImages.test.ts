/**
 * usePostboxSettings `autoLoadImages`: ON for an unset preference, but only
 * once the settings row has answered. While the query loads (or after it
 * fails without an answer) it is OFF, because a remote load cannot be taken
 * back if the saved preference turns out to be "ask first".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';
import { usePostboxSettings } from '../usePostboxSettings';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

const settingsRow = ref<Record<string, unknown> | null | undefined>(undefined);
const runSpy = vi.fn(async (): Promise<unknown> => ({ ok: true, result: null }));

beforeEach(() => {
	settingsRow.value = undefined;
	runSpy.mockClear();
	vi.stubGlobal('useConvexQuery', () => ({ data: settingsRow, isLoading: ref(false) }));
	vi.stubGlobal('useBackendOperation', () => ({ run: runSpy, isLoading: ref(false) }));
	vi.stubGlobal('useFeatureFlag', () => ({ isEnabled: () => false }));
});

describe('usePostboxSettings autoLoadImages', () => {
	it('stays off until the settings query answers', () => {
		const { autoLoadImages } = usePostboxSettings();
		expect(autoLoadImages.value).toBe(false);

		settingsRow.value = { isAutoLoadImagesOn: false };
		expect(autoLoadImages.value).toBe(false);
	});

	it('defaults on for a user with no row or an unset preference', () => {
		const { autoLoadImages } = usePostboxSettings();
		settingsRow.value = null;
		expect(autoLoadImages.value).toBe(true);
		settingsRow.value = {};
		expect(autoLoadImages.value).toBe(true);
	});

	it('persists the switch through the update mutation', async () => {
		const { setAutoLoadImages } = usePostboxSettings();
		await setAutoLoadImages(false);
		expect(runSpy).toHaveBeenCalledWith({ isAutoLoadImagesOn: false });
	});
});
