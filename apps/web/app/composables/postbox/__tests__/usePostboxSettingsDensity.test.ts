/**
 * usePostboxSettings density preference:
 *   - derives 'comfortable' when the settings row is unset/loading, reflects a
 *     saved 'compact', and normalises an unknown stored value, and
 *   - setDensity persists via the mail-settings update mutation.
 *
 * The Convex query/operation composables are stubbed as globals; a shared ref
 * stands in for the settings row so the density derivation can be driven.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';
import { usePostboxSettings } from '../usePostboxSettings';
import { optimisticUpdateSettings } from '~/lib/mailOptimistic/settingsUpdater';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

const settingsRow = ref<Record<string, unknown> | null>(null);
const runSpy = vi.fn(async () => undefined);
let operationOptions: Record<string, unknown> = {};

beforeEach(() => {
	settingsRow.value = null;
	runSpy.mockClear();
	vi.stubGlobal('useConvexQuery', () => ({ data: settingsRow, isLoading: ref(false) }));
	vi.stubGlobal('useBackendOperation', (_fn: unknown, opts: Record<string, unknown>) => {
		operationOptions = opts;
		return { run: runSpy, isLoading: ref(false) };
	});
	vi.stubGlobal('useFeatureFlag', () => ({ isEnabled: () => false }));
});

describe('usePostboxSettings density', () => {
	it('defaults to comfortable while unset/loading', () => {
		const { density } = usePostboxSettings();
		expect(density.value).toBe('comfortable');
	});

	it('reflects a saved compact density', () => {
		settingsRow.value = { density: 'compact' };
		const { density } = usePostboxSettings();
		expect(density.value).toBe('compact');
	});

	it('normalises an unknown stored density to comfortable', () => {
		settingsRow.value = { density: 'ultra' };
		const { density } = usePostboxSettings();
		expect(density.value).toBe('comfortable');
	});

	it('setDensity persists through the update mutation', async () => {
		const { setDensity } = usePostboxSettings();
		await setDensity('compact');
		expect(runSpy).toHaveBeenCalledWith({ density: 'compact' });
	});

	it('repaints the switch before the server answers (plan 2.2)', () => {
		usePostboxSettings();
		expect(operationOptions.optimisticUpdate).toBe(optimisticUpdateSettings);
	});
});
