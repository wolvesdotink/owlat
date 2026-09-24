import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getFunctionName } from 'convex/server';
import { createFetchError } from 'ofetch';

/**
 * The in-app update run, from "Update now" to a verdict.
 *
 * A release that the updater applied and started, but whose stack did not pass
 * the readiness check in time, used to end in the red "Update failed" banner
 * that invites a retry. Retrying changes nothing: the release is live. It is a
 * warning state of its own now, and a busy updater (409) says so.
 */

const { apiFetchMock, queryMock, mutationMock } = vi.hoisted(() => ({
	apiFetchMock: vi.fn(),
	queryMock: vi.fn(),
	mutationMock: vi.fn(),
}));

vi.mock('~/lib/csrfFetch', () => ({ apiFetch: apiFetchMock }));
vi.stubGlobal('useI18n', () => ({ t: (key: string) => key }));
vi.stubGlobal('useConvex', () => ({ query: queryMock, mutation: mutationMock }));

const { useSystemUpdateRun } = await import('../useSystemUpdateRun');

beforeEach(() => {
	apiFetchMock.mockReset();
	queryMock.mockReset().mockResolvedValue({ runId: 'run-1' });
	mutationMock.mockReset().mockResolvedValue(undefined);
});

function startedRun() {
	const run = useSystemUpdateRun(() => '0.4.17');
	run.startUpdate();
	return run;
}

describe('useSystemUpdateRun', () => {
	it('sends an attempt id with the update, a new one per attempt', async () => {
		apiFetchMock.mockResolvedValue({ steps: [] });
		const run = startedRun();

		await run.confirmUpdate();
		const first = run.updateAttempt.value;
		await run.confirmUpdate();

		const bodies = apiFetchMock.mock.calls.map(
			(call) => (call[1] as { body: Record<string, string> }).body
		);
		expect(first).toMatch(/^[0-9a-f]{32}$/);
		expect(bodies[0]).toEqual({ targetVersion: '0.4.17', attempt: first });
		expect(bodies[1]?.['attempt']).not.toBe(first);
	});

	it('shows a started rollout as its own warning state, not a failure', async () => {
		apiFetchMock.mockResolvedValue({
			success: true,
			rollout: 'started',
			warning: 'Not ready after 665s: still starting: clamav.',
			steps: [],
		});
		const run = startedRun();

		await run.confirmUpdate();

		expect(run.updateState.value).toBe('started');
		expect(run.updateWarning.value).toContain('still starting: clamav');
		expect(run.updateError.value).toBe('');
	});

	it('says the updater is busy when another rollout holds it', async () => {
		apiFetchMock.mockRejectedValue(
			createFetchError({
				request: '/api/system/update',
				response: new Response(null, { status: 409, statusText: 'Conflict' }),
				options: { method: 'POST' },
			} as Parameters<typeof createFetchError>[0])
		);
		const run = startedRun();

		await run.confirmUpdate();

		expect(run.updateState.value).toBe('failed');
		expect(run.updateError.value).toBe('dashboard.admin.system.index.updateBusy');
	});

	it('closes the open run as a success carrying the note when the card reports started', async () => {
		const run = startedRun();

		run.onUpdateStarted('Not ready after 665s: still starting: clamav.');
		await vi.waitFor(() => expect(mutationMock).toHaveBeenCalled());

		expect(run.updateState.value).toBe('started');
		const [ref, args] = mutationMock.mock.calls[0] as [
			Parameters<typeof getFunctionName>[0],
			Record<string, unknown>,
		];
		expect(getFunctionName(ref)).toBe('systemUpdates:recordUpdateFinish');
		expect(args).toEqual({
			runId: 'run-1',
			status: 'success',
			error: 'Not ready after 665s: still starting: clamav.',
		});
	});
});
