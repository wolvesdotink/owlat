// @vitest-environment happy-dom
/**
 * First-open interpretation (D5): a thread whose brief reads `none` is handed
 * to `lazy.ensure` once per tab, for a personal and a team thread alike, and
 * never while AI is off or once a brief exists.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import { createTestI18n } from '~/__tests__/i18n';

vi.mock('@owlat/api', () => ({
	api: { mail: { interpret: { lazy: { ensure: 'lazy.ensure' } } } },
}));

const run = vi.fn(async () => ({ ok: true }));
const isAiOn = ref(true);

beforeAll(() => {
	const i18n = createTestI18n().global;
	vi.stubGlobal('useI18n', () => i18n);
	vi.stubGlobal('useFeatureFlag', () => ({ isEnabled: () => isAiOn.value }));
	vi.stubGlobal('useBackendOperation', () => ({ run, isLoading: ref(false) }));
});

beforeEach(() => {
	run.mockClear();
	isAiOn.value = true;
});

const { useBriefEnsure } = await import('../useBriefEnsure');

describe('useBriefEnsure', () => {
	it('asks once per thread when the brief reads none, team threads included', async () => {
		const completeness = ref<string | undefined>(undefined);
		const team = { kind: 'team' as const, id: 'ct1' as never };
		useBriefEnsure({ threadRef: () => team, completeness: () => completeness.value });
		expect(run).not.toHaveBeenCalled();
		completeness.value = 'none';
		await nextTick();
		expect(run).toHaveBeenCalledWith({ threadRef: team });
		useBriefEnsure({ threadRef: () => team, completeness: () => 'none' });
		expect(run).toHaveBeenCalledTimes(1);
	});

	it('leaves a thread with a brief, or with AI off, alone', () => {
		useBriefEnsure({
			threadRef: () => ({ kind: 'mail', id: 'm1' as never }),
			completeness: () => 'pending',
		});
		isAiOn.value = false;
		useBriefEnsure({
			threadRef: () => ({ kind: 'mail', id: 'm2' as never }),
			completeness: () => 'none',
		});
		expect(run).not.toHaveBeenCalled();
	});
});
