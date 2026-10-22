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

const {
	useBriefEnsure,
	resetBriefEnsure,
	ENSURE_MAX_TRIES,
	ENSURE_RETRY_MS,
	ENSURE_RUNNING_RECHECK_MS,
	ENSURE_MAX_RUNNING_RECHECKS,
} = await import('../useBriefEnsure');

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
	history?: () => 'running' | 'stalled' | undefined,
	deferredSources?: () => number | undefined
) {
	const scope = effectScope();
	scopes.push(scope);
	scope.run(() =>
		useBriefEnsure({
			threadRef: () => threadRef as never,
			completeness,
			...(history ? { history } : {}),
			...(deferredSources ? { deferredSources } : {}),
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

	describe('D10: messages whose reading waited for the open', () => {
		const mail = { kind: 'mail', id: 'mt1' };

		it('asks on open while deferred sources wait, also on a thread read through before', async () => {
			run.mockResolvedValue({ ok: true, result: { isEnqueued: false, reason: 'has_brief' } });
			const deferred = ref(0);
			mount(
				mail,
				() => 'complete',
				undefined,
				() => deferred.value
			);
			await flushPromises();
			expect(run).not.toHaveBeenCalled();
			// The thread was read through long ago: remembered as taken.
			mount(mail, () => 'none');
			await flushPromises();
			expect(run).toHaveBeenCalledTimes(1);
			run.mockResolvedValue({ ok: true, result: { isEnqueued: true, runs: 1 } });
			deferred.value = 1;
			await nextTick();
			await flushPromises();
			expect(run).toHaveBeenCalledTimes(2);
			expect(run).toHaveBeenLastCalledWith({ threadRef: mail });
		});

		it('keeps asking after `running` while deferred sources remain, within its bound', async () => {
			run.mockResolvedValue({ ok: true, result: { isEnqueued: false, reason: 'running' } });
			const deferred = ref(2);
			mount(
				mail,
				() => 'pending',
				undefined,
				() => deferred.value
			);
			await flushPromises();
			expect(run).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(ENSURE_RUNNING_RECHECK_MS);
			await flushPromises();
			expect(run).toHaveBeenCalledTimes(2);
			// The run in flight settled and took the last one: the next look asks no more.
			run.mockResolvedValue({ ok: true, result: { isEnqueued: true, runs: 1 } });
			await vi.advanceTimersByTimeAsync(ENSURE_RUNNING_RECHECK_MS);
			await flushPromises();
			expect(run).toHaveBeenCalledTimes(3);
			deferred.value = 0;
			await nextTick();
			await vi.advanceTimersByTimeAsync(ENSURE_RUNNING_RECHECK_MS * 3);
			await flushPromises();
			expect(run).toHaveBeenCalledTimes(3);
		});

		it('stops rechecking a run that never settles', async () => {
			run.mockResolvedValue({ ok: true, result: { isEnqueued: false, reason: 'running' } });
			mount(
				mail,
				() => 'pending',
				undefined,
				() => 1
			);
			await flushPromises();
			for (let i = 0; i < ENSURE_MAX_RUNNING_RECHECKS + 5; i++) {
				await vi.advanceTimersByTimeAsync(ENSURE_RUNNING_RECHECK_MS);
				await flushPromises();
			}
			// The first ask, then the bounded rechecks.
			expect(run).toHaveBeenCalledTimes(1 + ENSURE_MAX_RUNNING_RECHECKS);
		});

		it('does not count accepted asks against the refusal bound', async () => {
			const deferred = ref(1);
			mount(
				mail,
				() => 'partial',
				undefined,
				() => deferred.value
			);
			await flushPromises();
			for (let i = 2; i <= ENSURE_MAX_TRIES + 2; i++) {
				deferred.value = i;
				await nextTick();
				await flushPromises();
			}
			expect(run).toHaveBeenCalledTimes(ENSURE_MAX_TRIES + 2);
		});

		it('retries a refusal (AI off, budget) like any other', async () => {
			run.mockResolvedValue({ ok: true, result: { isEnqueued: false, reason: 'budget' } });
			mount(
				mail,
				() => 'pending',
				undefined,
				() => 1
			);
			await flushPromises();
			for (let i = 1; i < ENSURE_MAX_TRIES + 2; i++) {
				await vi.advanceTimersByTimeAsync(ENSURE_RETRY_MS * i);
				await flushPromises();
			}
			expect(run).toHaveBeenCalledTimes(ENSURE_MAX_TRIES);
		});

		it('asks nothing more once the reader closed before the answer came (F5)', async () => {
			let answer!: (value: unknown) => void;
			run.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						answer = resolve;
					})
			);
			const scope = mount(
				mail,
				() => 'pending',
				undefined,
				() => 1
			);
			await flushPromises();
			expect(run).toHaveBeenCalledTimes(1);
			scope.stop();
			answer({ ok: true, result: { isEnqueued: false, reason: 'running' } });
			await flushPromises();
			expect(vi.getTimerCount()).toBe(0);
			await vi.advanceTimersByTimeAsync(ENSURE_RUNNING_RECHECK_MS * 5);
			expect(run).toHaveBeenCalledTimes(1);
		});

		it('drops a refusal retry the reader no longer waits for', async () => {
			run.mockResolvedValue({ ok: true, result: { isEnqueued: false, reason: 'busy' } });
			const scope = mount(team, () => 'none');
			await flushPromises();
			scope.stop();
			await vi.advanceTimersByTimeAsync(ENSURE_RETRY_MS * 10);
			expect(run).toHaveBeenCalledTimes(1);
		});

		it('never asks for a team thread on a deferred count', async () => {
			mount(
				team,
				() => 'complete',
				undefined,
				() => 3
			);
			await flushPromises();
			expect(run).not.toHaveBeenCalled();
		});
	});
});
