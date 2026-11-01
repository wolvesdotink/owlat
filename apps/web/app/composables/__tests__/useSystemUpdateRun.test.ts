import { describe, it, expect, vi, beforeEach } from 'vitest';
import { nextTick } from 'vue';
import { getFunctionName } from 'convex/server';
import { createFetchError } from 'ofetch';
import { createI18n } from 'vue-i18n';
import en from '../../../i18n/locales/en.json';
import de from '../../../i18n/locales/de.json';

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
const { ROLLOUT_HEARTBEAT_MS } = await import('~/lib/backendConnection');

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
		// The route took the refused run back; the open run belongs to the
		// rollout that refused it and must not be closed as failed.
		expect(queryMock).not.toHaveBeenCalled();
		expect(mutationMock).not.toHaveBeenCalled();
	});

	it('leaves the open run alone when the updater rate-limits the update', async () => {
		apiFetchMock.mockRejectedValue(
			createFetchError({
				request: '/api/system/update',
				response: new Response(null, { status: 429, statusText: 'Too Many Requests' }),
				options: { method: 'POST' },
			} as Parameters<typeof createFetchError>[0])
		);
		const run = startedRun();

		await run.confirmUpdate();

		expect(run.updateState.value).toBe('failed');
		expect(mutationMock).not.toHaveBeenCalled();
	});

	it.each([
		[412, 'Precondition Failed'],
		[503, 'Service Unavailable'],
	])(
		'leaves the open run alone when the route refused on the migration check (%i)',
		async (status, statusText) => {
			apiFetchMock.mockRejectedValue(
				createFetchError({
					request: '/api/system/update',
					response: new Response(null, { status, statusText }),
					options: { method: 'POST' },
				} as Parameters<typeof createFetchError>[0])
			);
			const run = startedRun();

			await run.confirmUpdate();

			expect(run.updateState.value).toBe('failed');
			expect(mutationMock).not.toHaveBeenCalled();
		}
	);

	it.each([
		['de', 503, 'Die Datenmigrationen, die dieses Update braucht, konnten nicht geprüft werden'],
		['en', 503, 'Could not check the data migrations this update needs'],
		['de', 412, 'Schließe zuerst die Datenmigrationen ab'],
	])(
		"words a migration-check refusal in the reader's language (%s, %i), not the server's English",
		async (locale, status, expected) => {
			const i18n = createI18n({ legacy: false, locale, messages: { en, de } });
			vi.stubGlobal('useI18n', () => i18n.global);
			try {
				apiFetchMock.mockRejectedValue(
					createFetchError({
						request: '/api/system/update',
						response: new Response(
							JSON.stringify({ message: 'Could not check the data migrations (server)' }),
							{ status, headers: { 'content-type': 'application/json' } }
						),
						options: { method: 'POST' },
					} as Parameters<typeof createFetchError>[0])
				);
				const run = startedRun();

				await run.confirmUpdate();

				expect(run.updateState.value).toBe('failed');
				expect(run.updateError.value).toContain(expected);
				expect(run.updateError.value).not.toContain('(server)');
			} finally {
				vi.stubGlobal('useI18n', () => ({ t: (key: string) => key }));
			}
		}
	);

	it('still closes the open run as failed when the update itself failed', async () => {
		apiFetchMock.mockRejectedValue(
			createFetchError({
				request: '/api/system/update',
				response: new Response(null, { status: 400, statusText: 'Bad Request' }),
				options: { method: 'POST' },
			} as Parameters<typeof createFetchError>[0])
		);
		const run = startedRun();

		await run.confirmUpdate();
		await vi.waitFor(() => expect(mutationMock).toHaveBeenCalled());

		expect((mutationMock.mock.calls[0] as unknown[])[1]).toMatchObject({
			runId: 'run-1',
			status: 'failed',
		});
	});

	it('holds Update now while a run is in flight, and releases it on a verdict', async () => {
		let answer!: (value: unknown) => void;
		apiFetchMock.mockReturnValue(new Promise((resolve) => (answer = resolve)));
		const run = startedRun();
		expect(run.updateInProgress.value).toBe(false);

		const request = run.confirmUpdate();
		expect(run.updateInProgress.value).toBe(true);

		// A second click neither swaps the progress card for a confirm nor
		// starts another attempt.
		run.startUpdate();
		expect(run.updateState.value).toBe('running');
		expect(apiFetchMock).toHaveBeenCalledTimes(1);

		answer({ steps: [] });
		await request;
		run.onUpdateFailed('Timed out');
		expect(run.updateInProgress.value).toBe(false);
		run.startUpdate();
		expect(run.updateState.value).toBe('confirming');
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
		expect(getFunctionName(ref)).toBe('maintenance/updates:recordUpdateFinish');
		expect(args).toEqual({
			runId: 'run-1',
			status: 'success',
			error: 'Not ready after 665s: still starting: clamav.',
		});
	});

	describe('rollout heartbeat', () => {
		const beats = () =>
			mutationMock.mock.calls.filter(
				([ref]) =>
					getFunctionName(ref as Parameters<typeof getFunctionName>[0]) ===
					'maintenance/updates:recordUpdateActivity'
			).length;

		/** Confirm an update whose request stays out, as a real rollout's does. */
		async function following() {
			apiFetchMock.mockReturnValue(new Promise(() => {}));
			const run = startedRun();
			void run.confirmUpdate();
			await nextTick();
			return run;
		}

		it('confirms the rollout every heartbeat while it follows one, and stops on a verdict', async () => {
			vi.useFakeTimers();
			try {
				const run = await following();
				expect(beats()).toBe(0);

				await vi.advanceTimersByTimeAsync(ROLLOUT_HEARTBEAT_MS * 2);
				expect(beats()).toBe(2);

				run.onUpdateFailed('Timed out');
				await nextTick();
				await vi.advanceTimersByTimeAsync(ROLLOUT_HEARTBEAT_MS * 3);
				expect(beats()).toBe(2);
			} finally {
				vi.useRealTimers();
			}
		});

		it('sends one beat at a time, so beats queued while the backend restarts cannot pile up', async () => {
			vi.useFakeTimers();
			try {
				mutationMock.mockImplementation(() => new Promise(() => {}));
				await following();

				await vi.advanceTimersByTimeAsync(ROLLOUT_HEARTBEAT_MS * 3);
				expect(beats()).toBe(1);
			} finally {
				vi.useRealTimers();
			}
		});
	});
});
