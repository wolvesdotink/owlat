// @vitest-environment happy-dom
/**
 * The in-flight update log (Settings → System & Updates → Update now).
 *
 * Two failures live here, and they are both about a card an operator stares at
 * for minutes while their instance is being replaced.
 *
 * The first is the verdict it paints. It used to read a step's outcome off its
 * `stderr`: non-empty meant failure. Docker writes pull and recreate PROGRESS to
 * stderr on SUCCESS, so a healthy update painted "Pull new container images" and
 * "Recreate containers" red and offered ` web Pulled` as the error message — the
 * operator watched a working update tell them it had failed twice. The updater
 * sidecar reports a real per-step verdict (`ok`, i.e. the docker command exited
 * zero) and that is what the list reads now, falling back to the old reading
 * only for the steps that carry no verdict.
 *
 * The second is everything the card does BEFORE that report exists — which is
 * the whole update, because the sidecar answers in one piece at the very end.
 * The `running` status and its spinner were never assigned to anything, so the
 * card showed four inert circles, and the clock was incremented by the health
 * poller, so it moved in 5-second jumps. A page that looks frozen at exactly
 * the moment the operator is watching hardest:
 *   - the row the updater has not reported on yet is the row that spins;
 *   - the rows are listed in the order the updater actually executes them,
 *     which is what makes that spinner point at the right work;
 *   - a failed run stops the spinner instead of marching it onward;
 *   - the clock ticks every second, off wall time rather than a tally of ticks.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

import UpdateProgress from '../UpdateProgress.vue';

const TARGET = '0.4.17';

/** What the next `/api/internal/updater-health` poll answers. Rewired per test. */
let health: () => Promise<unknown>;
const updaterUnreachable = async () => {
	throw new Error('updater unreachable');
};
/** Health once the new version is up and running — what ends the poll. */
const healthAfterUpdate = async () => ({
	status: 'ok',
	timestamp: 0,
	containers: [{ service: 'web', state: 'running', imageTag: TARGET }],
});

let fetchMock: ReturnType<typeof vi.fn>;

// `useI18n` and `$fetch` are Nuxt auto-imports; the component reaches for both
// during setup/mount (the second to poll updater health). Installed once and
// left in place — `vi.unstubAllGlobals` would take the vitest setup file's Nuxt
// auto-imports (`ref`, `computed`, …) with it.
beforeAll(() => {
	fetchMock = vi.fn(() => health());
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n, $fetch: fetchMock });
});

beforeEach(() => {
	health = updaterUnreachable;
	fetchMock.mockClear();
});

type Step = { step: string; ok?: boolean; stdout?: string; stderr?: string };

/** Exactly what the sidecar returns for a fully successful update. */
const SUCCESSFUL_UPDATE: Step[] = [
	{ step: 'stage-compose', stdout: 'New compose template staged', stderr: '' },
	{ step: 'pull', ok: true, stdout: '', stderr: ' web Pulling\n web Pulled\n' },
	{ step: 'convex-deploy', ok: true, stdout: 'Deployed Convex functions', stderr: '' },
	{ step: 'write-compose', stdout: 'Compose file updated', stderr: '' },
	{ step: 'pin-version', ok: true, stdout: `OWLAT_VERSION pinned to ${TARGET}`, stderr: '' },
	{ step: 'up', ok: true, stdout: '', stderr: ' Container owlat-web-1  Started\n' },
];

function mountLog(steps?: Step[]) {
	return mount(UpdateProgress, {
		props: { targetVersion: TARGET, steps },
		global: { plugins: [createTestI18n()], stubs: { Icon: true } },
	});
}

/** The icon name the row for `step` is painted with. */
function iconFor(wrapper: VueWrapper, label: string): string | undefined {
	const row = wrapper.findAll('li').find((li) => li.text().includes(label));
	return row?.find('icon-stub').attributes('name');
}

/** Every step row's icon, in rendered order. */
function rowIcons(wrapper: VueWrapper): (string | undefined)[] {
	return wrapper.findAll('ol li icon-stub').map((icon) => icon.attributes('name'));
}

function rowLabels(wrapper: VueWrapper): string[] {
	return wrapper.findAll('ol li p').map((p) => p.text().replace(/^\d+\.\s*/, ''));
}

/** The error line under a step, if the row shows one. (`p`, because the row's
 * icon carries `text-error` too when the step failed.) */
function errorTextFor(wrapper: VueWrapper, label: string): string {
	const row = wrapper.findAll('li').find((li) => li.text().includes(label));
	return row?.find('p.text-error').text() ?? '';
}

function clock(wrapper: VueWrapper): string {
	return wrapper.find('h3 + span').text();
}

const SUCCESS = 'lucide:check-circle-2';
const FAILED = 'lucide:x-circle';
const PENDING = 'lucide:circle';
const SPINNER = 'lucide:loader-2';

afterEach(() => {
	vi.clearAllTimers();
});

describe('UpdateProgress — step outcomes', () => {
	it('paints every step of a successful update as done, docker progress and all', () => {
		const wrapper = mountLog(SUCCESSFUL_UPDATE);

		expect(iconFor(wrapper, 'Pull new container images')).toBe(SUCCESS);
		expect(iconFor(wrapper, 'Recreate containers with new versions')).toBe(SUCCESS);
		expect(iconFor(wrapper, 'Deploy backend functions')).toBe(SUCCESS);
		expect(iconFor(wrapper, 'Write pinned compose template')).toBe(SUCCESS);
		// Nothing on stderr is presented as an error.
		expect(wrapper.find('p.text-error').exists()).toBe(false);
		wrapper.unmount();
	});

	it('still paints a step the sidecar reports as failed, with its error', () => {
		const wrapper = mountLog([
			{ step: 'stage-compose', stdout: 'New compose template staged', stderr: '' },
			{
				step: 'pull',
				ok: false,
				stdout: '',
				stderr: 'Error response from daemon: manifest unknown',
			},
		]);

		expect(iconFor(wrapper, 'Pull new container images')).toBe(FAILED);
		expect(errorTextFor(wrapper, 'Pull new container images')).toContain('manifest unknown');
		// The steps the updater never reached stay pending rather than claiming a verdict.
		expect(iconFor(wrapper, 'Recreate containers with new versions')).toBe(PENDING);
		wrapper.unmount();
	});

	it('falls back to reading stderr for a step that carries no verdict', () => {
		const wrapper = mountLog([
			{ step: 'write-compose', stdout: '', stderr: 'Failed to promote compose file' },
		]);

		expect(iconFor(wrapper, 'Write pinned compose template')).toBe(FAILED);
		wrapper.unmount();
	});

	it('treats a warning-only stderr on a verdictless step as done', () => {
		const wrapper = mountLog([
			{ step: 'write-compose', stdout: '', stderr: 'Warning: orphan container removed' },
		]);

		expect(iconFor(wrapper, 'Write pinned compose template')).toBe(SUCCESS);
		wrapper.unmount();
	});
});

describe('UpdateProgress — the in-flight indicator', () => {
	it('spins the first step while the updater has reported nothing', () => {
		const wrapper = mountLog();

		expect(rowIcons(wrapper)).toEqual([SPINNER, PENDING, PENDING, PENDING]);
		wrapper.unmount();
	});

	it('moves the spinner to the first step the updater has not reported on', async () => {
		const wrapper = mountLog();

		await wrapper.setProps({ steps: [{ step: 'pull', ok: true, stdout: '', stderr: '' }] });

		expect(rowIcons(wrapper)).toEqual([SUCCESS, SPINNER, PENDING, PENDING]);
		wrapper.unmount();
	});

	it('lists the steps in the order the updater executes them', () => {
		// apps/updater/src/update.ts handleUpdate: pull, then convex-deploy against
		// the still-running old stack, then the compose promotion, then the
		// container recreation that restarts this very page.
		const wrapper = mountLog();

		expect(rowLabels(wrapper)).toEqual([
			'Pull new container images',
			'Deploy backend functions',
			'Write pinned compose template',
			'Recreate containers with new versions',
		]);
		wrapper.unmount();
	});

	it('stops spinning once a step failed — the run is over, not continuing', () => {
		const wrapper = mountLog([
			{ step: 'pull', ok: true, stdout: '', stderr: '' },
			{ step: 'convex-deploy', ok: false, stdout: '', stderr: 'schema push rejected' },
		]);

		expect(rowIcons(wrapper)).toEqual([SUCCESS, FAILED, PENDING, PENDING]);
		wrapper.unmount();
	});

	it('stops spinning for a failure in a step the list does not show', () => {
		// The Docker API preflight refuses before anything is staged; no row of
		// this list is in flight after that, even though none of them is reported.
		const wrapper = mountLog([
			{ step: 'docker-api-preflight', ok: false, stdout: '', stderr: '403 from socket proxy' },
		]);

		expect(rowIcons(wrapper)).toEqual([PENDING, PENDING, PENDING, PENDING]);
		wrapper.unmount();
	});

	it('keeps a waiting indicator up while it polls for the new version', async () => {
		vi.useFakeTimers();
		const wrapper = mountLog();
		const waiting = () => wrapper.find('[role="status"]');

		expect(waiting().exists()).toBe(true);
		expect(waiting().find('icon-stub').attributes('name')).toBe(SPINNER);

		health = healthAfterUpdate;
		await vi.advanceTimersByTimeAsync(5_000);

		expect(wrapper.emitted('complete')).toHaveLength(1);
		expect(waiting().exists()).toBe(false);
		// Nothing is in flight any more, so no row is left spinning either.
		expect(rowIcons(wrapper)).not.toContain(SPINNER);
		wrapper.unmount();
		vi.useRealTimers();
	});
});

describe('UpdateProgress — the clock', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('ticks every second rather than in poll-sized jumps', async () => {
		const wrapper = mountLog();

		expect(clock(wrapper)).toBe('00:00');

		await vi.advanceTimersByTimeAsync(1_000);
		expect(clock(wrapper)).toBe('00:01');

		await vi.advanceTimersByTimeAsync(1_000);
		expect(clock(wrapper)).toBe('00:02');

		await vi.advanceTimersByTimeAsync(58_000);
		expect(clock(wrapper)).toBe('01:00');
		wrapper.unmount();
	});

	it('reports elapsed wall time, so a throttled tab does not undercount', async () => {
		const wrapper = mountLog();

		// A backgrounded tab coalesces timers: time moves, ticks do not all fire.
		vi.setSystemTime(Date.now() + 90_000);
		await vi.advanceTimersByTimeAsync(1_000);

		expect(clock(wrapper)).toBe('01:31');
		wrapper.unmount();
	});

	it('gives up after five minutes and stops the spinner', async () => {
		const wrapper = mountLog();

		await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

		expect(wrapper.emitted('failed')?.[0]).toEqual([
			'Timed out waiting for new version to appear. Check `owlat logs web` on the host.',
		]);
		expect(rowIcons(wrapper)).toEqual([PENDING, PENDING, PENDING, PENDING]);
		expect(wrapper.find('[role="status"]').exists()).toBe(false);
		wrapper.unmount();
	});

	it('stops polling and ticking once unmounted', async () => {
		const wrapper = mountLog();
		await vi.advanceTimersByTimeAsync(5_000);
		const callsWhileMounted = fetchMock.mock.calls.length;

		wrapper.unmount();
		await vi.advanceTimersByTimeAsync(30_000);

		expect(fetchMock.mock.calls.length).toBe(callsWhileMounted);
	});
});

/**
 * The web container runs the new version during `up`, before the updater has
 * checked the rest of the stack, so that alone ended the card with a success.
 * The updater now serves its verdict for this attempt on /health.
 */
describe('UpdateProgress — the updater verdict', () => {
	const ATTEMPT = 'a1b2c3d4-0000-4000-8000-000000000001';
	const withRecord = (lastRollout: Record<string, unknown>) => async () => ({
		...(await healthAfterUpdate()),
		lastRollout: { attempt: ATTEMPT, targetVersion: TARGET, ...lastRollout },
		rolloutInProgress: null,
	});

	function mountAttempt() {
		return mount(UpdateProgress, {
			props: { targetVersion: TARGET, attempt: ATTEMPT },
			global: { plugins: [createTestI18n()], stubs: { Icon: true } },
		});
	}

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('does not call the update complete while the updater still checks the stack', async () => {
		health = withRecord({ phase: 'verifying' });
		const wrapper = mountAttempt();
		await vi.advanceTimersByTimeAsync(5_000);

		expect(wrapper.emitted('complete')).toBeUndefined();
		expect(wrapper.find('[role="status"]').text()).toContain(
			'Waiting until every service passes its health check'
		);

		health = withRecord({ phase: 'done', outcome: 'healthy' });
		await vi.advanceTimersByTimeAsync(5_000);
		expect(wrapper.emitted('complete')).toHaveLength(1);
		wrapper.unmount();
	});

	it('shows every step done while the updater checks the stack', async () => {
		health = withRecord({ phase: 'verifying' });
		const wrapper = mountAttempt();
		expect(rowIcons(wrapper)).toEqual([SPINNER, PENDING, PENDING, PENDING]);

		await vi.advanceTimersByTimeAsync(5_000);

		// Only the health-check line under the list is still working.
		expect(rowIcons(wrapper)).toEqual([SUCCESS, SUCCESS, SUCCESS, SUCCESS]);
		expect(wrapper.find('[role="status"]').text()).toContain('The new version is running');
		wrapper.unmount();
	});

	it('moves the spinner to the recreate once web runs the new version', async () => {
		health = withRecord({ phase: 'applying' });
		const wrapper = mountAttempt();

		await vi.advanceTimersByTimeAsync(5_000);

		expect(rowIcons(wrapper)).toEqual([SUCCESS, SUCCESS, SUCCESS, SPINNER]);
		wrapper.unmount();
	});

	it('reports a release that started but did not become healthy as started, not failed', async () => {
		health = withRecord({
			phase: 'done',
			outcome: 'started',
			summary: 'Not ready after 665s: still starting: clamav.',
		});
		const wrapper = mountAttempt();
		await vi.advanceTimersByTimeAsync(5_000);

		expect(wrapper.emitted('started')?.[0]).toEqual([
			'Not ready after 665s: still starting: clamav.',
		]);
		expect(wrapper.emitted('failed')).toBeUndefined();
		expect(wrapper.emitted('complete')).toBeUndefined();
		wrapper.unmount();
	});

	it('reports a partially applied rollout as failed, with the updater summary', async () => {
		health = withRecord({
			phase: 'done',
			outcome: 'partially-applied',
			summary: 'docker compose up failed',
		});
		const wrapper = mountAttempt();
		await vi.advanceTimersByTimeAsync(5_000);

		expect(wrapper.emitted('failed')?.[0]).toEqual(['docker compose up failed']);
		wrapper.unmount();
	});

	it('keeps waiting past five minutes while the updater works on this attempt', async () => {
		health = withRecord({ phase: 'verifying' });
		const wrapper = mountAttempt();

		await vi.advanceTimersByTimeAsync(11 * 60 * 1000);

		expect(wrapper.emitted('failed')).toBeUndefined();
		expect(wrapper.find('[role="status"]').exists()).toBe(true);
		wrapper.unmount();
	});
});
