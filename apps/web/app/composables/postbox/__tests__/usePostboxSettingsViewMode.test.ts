/**
 * usePostboxSettings inbox view-mode preference:
 *   - derives 'flat' when the settings row is unset/loading, reflects a saved
 *     mode, and normalises an unknown stored value, and
 *   - setViewMode persists via the mail-settings update mutation and reports
 *     whether the save landed (a failed run() resolves to undefined).
 *
 * The Convex query/operation composables are stubbed as globals; a shared ref
 * stands in for the settings row so the view-mode derivation can be driven.
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

const settingsRow = ref<Record<string, unknown> | null>(null);
const runSpy = vi.fn(async (): Promise<unknown> => undefined);

beforeEach(() => {
	settingsRow.value = null;
	runSpy.mockClear();
	vi.stubGlobal('useConvexQuery', () => ({ data: settingsRow, isLoading: ref(false) }));
	vi.stubGlobal('useBackendOperation', () => ({ run: runSpy, isLoading: ref(false) }));
	vi.stubGlobal('useFeatureFlag', () => ({ isEnabled: () => false }));
});

describe('usePostboxSettings viewMode', () => {
	it('defaults to flat while unset/loading', () => {
		const { viewMode } = usePostboxSettings();
		expect(viewMode.value).toBe('flat');
	});

	it('reflects a saved mode', () => {
		settingsRow.value = { viewMode: 'conversations' };
		const { viewMode } = usePostboxSettings();
		expect(viewMode.value).toBe('conversations');
	});

	it('normalises an unknown stored mode to flat', () => {
		settingsRow.value = { viewMode: 'stacked' };
		const { viewMode } = usePostboxSettings();
		expect(viewMode.value).toBe('flat');
	});

	it('setViewMode persists through the update mutation and reports success', async () => {
		runSpy.mockResolvedValueOnce('settingsRowId');
		const { setViewMode } = usePostboxSettings();
		await expect(setViewMode('categories')).resolves.toBe(true);
		expect(runSpy).toHaveBeenCalledWith({ viewMode: 'categories' });
	});

	it('setViewMode reports failure when the save does not land', async () => {
		// useBackendOperation.run resolves to undefined on error (after toasting).
		const { setViewMode } = usePostboxSettings();
		await expect(setViewMode('categories')).resolves.toBe(false);
	});
});
