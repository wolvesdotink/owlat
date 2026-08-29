/**
 * usePostboxSettings reading-pane preference:
 *   - derives 'right' + the 384px list width when the settings row is unset
 *     (exactly the geometry the layout had before the control existed),
 *   - reflects a saved pane and seam, clamping an out-of-range stored size, and
 *   - setReadingPane / setListSize persist through the update mutation, with
 *     setListSize clamping before it writes.
 *
 * The Convex query/operation composables are stubbed as globals; a shared ref
 * stands in for the settings row so the derivations can be driven.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';
import { usePostboxSettings } from '../usePostboxSettings';
import { POSTBOX_LIST_SIZE_LIMITS } from '~/utils/postboxReadingPane';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

const settingsRow = ref<Record<string, unknown> | null>(null);
const runSpy = vi.fn(async () => ({ ok: true }));

beforeEach(() => {
	settingsRow.value = null;
	runSpy.mockClear();
	vi.stubGlobal('useConvexQuery', () => ({ data: settingsRow, isLoading: ref(false) }));
	vi.stubGlobal('useBackendOperation', () => ({ run: runSpy, isLoading: ref(false) }));
	vi.stubGlobal('useFeatureFlag', () => ({ isEnabled: () => false }));
});

describe('usePostboxSettings reading pane', () => {
	it('defaults to the side-by-side pane at the hardcoded 384px width', () => {
		const { readingPane, listWidth, listHeight } = usePostboxSettings();
		expect(readingPane.value).toBe('right');
		expect(listWidth.value).toBe(384);
		expect(listHeight.value).toBe(POSTBOX_LIST_SIZE_LIMITS.height.default);
	});

	it('reflects a saved pane and seam', () => {
		settingsRow.value = { readingPane: 'bottom', listWidth: 500, listHeight: 260 };
		const { readingPane, listWidth, listHeight } = usePostboxSettings();
		expect(readingPane.value).toBe('bottom');
		expect(listWidth.value).toBe(500);
		expect(listHeight.value).toBe(260);
	});

	it('normalises an unknown pane and clamps an out-of-range stored seam', () => {
		settingsRow.value = { readingPane: 'diagonal', listWidth: 99_999 };
		const { readingPane, listWidth } = usePostboxSettings();
		expect(readingPane.value).toBe('right');
		expect(listWidth.value).toBe(POSTBOX_LIST_SIZE_LIMITS.width.max);
	});

	it('setReadingPane persists through the update mutation', async () => {
		const { setReadingPane } = usePostboxSettings();
		await expect(setReadingPane('off')).resolves.toBe(true);
		expect(runSpy).toHaveBeenCalledWith({ readingPane: 'off' });
	});

	it('setListSize writes the axis field, clamped', async () => {
		const { setListSize } = usePostboxSettings();
		await setListSize('width', 420);
		expect(runSpy).toHaveBeenCalledWith({ listWidth: 420 });
		await setListSize('height', 5);
		expect(runSpy).toHaveBeenCalledWith({
			listHeight: POSTBOX_LIST_SIZE_LIMITS.height.min,
		});
	});
});
