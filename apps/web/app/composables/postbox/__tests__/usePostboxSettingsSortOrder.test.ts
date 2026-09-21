/**
 * usePostboxSettings message-list sort order:
 *   - derives 'newest' when the settings row is unset/loading (the order the
 *     list had before the control existed), reflects a saved order, and
 *     normalises an unknown stored value, and
 *   - setSortOrder persists through the mail-settings update mutation and
 *     reports whether the save landed, so the header can snap its optimistic
 *     flip back.
 *
 * Same harness as the view-mode suite: the Convex query/operation composables
 * are stubbed as globals over a shared settings-row ref.
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
const runSpy = vi.fn(async (): Promise<unknown> => ({ ok: false }));

beforeEach(() => {
	settingsRow.value = null;
	runSpy.mockClear();
	vi.stubGlobal('useConvexQuery', () => ({ data: settingsRow, isLoading: ref(false) }));
	vi.stubGlobal('useBackendOperation', () => ({ run: runSpy, isLoading: ref(false) }));
	vi.stubGlobal('useFeatureFlag', () => ({ isEnabled: () => false }));
});

describe('usePostboxSettings sortOrder', () => {
	it('defaults to newest while unset/loading', () => {
		const { sortOrder } = usePostboxSettings();
		expect(sortOrder.value).toBe('newest');
	});

	it('reflects a saved order', () => {
		settingsRow.value = { sortOrder: 'oldest' };
		const { sortOrder } = usePostboxSettings();
		expect(sortOrder.value).toBe('oldest');
	});

	it('normalises an unknown stored order to newest', () => {
		settingsRow.value = { sortOrder: 'largest' };
		const { sortOrder } = usePostboxSettings();
		expect(sortOrder.value).toBe('newest');
	});

	it('setSortOrder persists through the update mutation and reports success', async () => {
		runSpy.mockResolvedValueOnce({ ok: true, result: 'settingsRowId' });
		const { setSortOrder } = usePostboxSettings();
		await expect(setSortOrder('oldest')).resolves.toBe(true);
		expect(runSpy).toHaveBeenCalledWith({ sortOrder: 'oldest' });
	});

	it('setSortOrder reports failure when the save does not land', async () => {
		const { setSortOrder } = usePostboxSettings();
		await expect(setSortOrder('oldest')).resolves.toBe(false);
	});
});
