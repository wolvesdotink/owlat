// @vitest-environment happy-dom
/**
 * First-open interpretation (D5): a thread whose brief reads `none` is handed
 * to `lazy.ensure`, for a personal and a team thread alike. Only a request
 * the server took is remembered; a refusal is retried a bounded number of
 * times, and AI turning on asks again.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';
import { flushPromises } from '@vue/test-utils';
import { createTestI18n } from '~/__tests__/i18n';

vi.mock('@owlat/api', () => ({
	api: { mail: { interpret: { lazy: { ensure: 'lazy.ensure' } } } },
}));

const run = vi.fn();
const isAiOn = ref(true);

beforeAll(() => {
	const i18n = createTestI18n().global;
	vi.stubGlobal('useI18n', () => i18n);
	vi.stubGlobal('useFeatureFlag', () => ({ isEnabled: () => isAiOn.value }));
	vi.stubGlobal('useBackendOperation', () => ({ run, isLoading: ref(false) }));
});

const { useBriefEnsure, resetBriefEnsure, ENSURE_MAX_TRIES, ENSURE_RETRY_MS } =
	await import('../useBriefEnsure');

beforeEach(() => {
	vi.useFakeTimers();
	run.mockReset();
	run.mockResolvedValue({ ok: true, result: { isEnqueued: true, runs: 1 } });
	isAiOn.value = true;
	resetBriefEnsure();
});
const scopes: ReturnType<typeof effectScope>[] = [];
afterEach(() => {
	for (const scope of scopes.splice(0)) scope.stop();
	vi.useRealTimers();
});

function mount(
	threadRef: unknown,
	completeness: () => string | undefined,
	history?: () => 'running' | 'stalled' | undefined
) {
	const scope = effectScope();
	scopes.push(scope);
	scope.run(() =>
		useBriefEnsure({
			threadRef: () => threadRef as never,
			completeness,
			...(history ? { history } : {}),
		})
	);
	return scope;
}

const team = { kind: 'team', id: 'ct1' };

describe('useBriefEnsure', () => {
	it('asks when the brief reads none, and remembers only a history read through', async () => {
		const completeness = ref<string | undefined>(undefined);
		mount(team, () => completeness.value);
		expect(run).not.toHaveBeenCalled();
		completeness.value = 'none';
		await nextTick();
		await flushPromises();
		expect(run).toHaveBeenCalledWith({ threadRef: team });
		// Accepted is not done: a later look asks again.
		mount(team, () => 'none');
		await flushPromises();
		expect(run).toHaveBeenCalledTimes(2);
		run.mockResolvedValue({ ok: true, result: { isEnqueued: false, reason: 'has_brief' } });
		mount(team, () => 'none');
		await flushPromises();
		mount(team, () => 'none');
		await flushPromises();
		expect(run).toHaveBeenCalledTimes(3);
	});

	it('resumes a stalled history, never a running one, within the bound (F2)', async () => {
		const history = ref<'running' | 'stalled' | undefined>('running');
		mount(
			{ kind: 'mail', id: 'm3' },
			() => 'partial',
			() => history.value
		);
		await flushPromises();
		expect(run).not.toHaveBeenCalled();
		history.value = 'stalled';
		await nextTick();
		await flushPromises();
		expect(run).toHaveBeenCalledTimes(1);
		for (let i = 0; i < ENSURE_MAX_TRIES + 2; i++) {
			history.value = 'running';
			await nextTick();
			history.value = 'stalled';
			await nextTick();
			await flushPromises();
		}
		expect(run).toHaveBeenCalledTimes(ENSURE_MAX_TRIES);
	});

	it('retries a refusal a bounded number of times', async () => {
		run.mockResolvedValue({ ok: true, result: { isEnqueued: false, reason: 'busy' } });
		mount(team, () => 'none');
		await flushPromises();
		for (let i = 1; i < ENSURE_MAX_TRIES + 2; i++) {
			await vi.advanceTimersByTimeAsync(ENSURE_RETRY_MS * i);
			await flushPromises();
		}
		expect(run).toHaveBeenCalledTimes(ENSURE_MAX_TRIES);
	});

	it('waits for AI, and asks once it turns on', async () => {
		isAiOn.value = false;
		mount({ kind: 'mail', id: 'm1' }, () => 'none');
		await flushPromises();
		expect(run).not.toHaveBeenCalled();
		isAiOn.value = true;
		await nextTick();
		await flushPromises();
		expect(run).toHaveBeenCalledTimes(1);
	});

	it('leaves a thread with a brief alone', async () => {
		mount({ kind: 'mail', id: 'm2' }, () => 'pending');
		await flushPromises();
		expect(run).not.toHaveBeenCalled();
	});
});
