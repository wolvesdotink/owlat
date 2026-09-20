import { getFunctionName } from 'convex/server';
import { describe, it, expect, vi } from 'vitest';
import { reportTaskFailure } from '../taskRunner.js';
import { getConvexClient } from '../convexClient.js';
import type { CodeTaskFailureOutcome } from '../convexClient.js';

/** Records every mutation call and answers `markFailed` with a canned outcome. */
function fakeClient(outcome: CodeTaskFailureOutcome) {
	const calls: Array<{ name: string; args: unknown }> = [];
	const client = {
		mutation: vi.fn(async (reference: unknown, args: unknown) => {
			calls.push({
				name: getFunctionName(reference as never)
					.split(':')
					.pop()!,
				args,
			});
			return outcome;
		}),
	};
	return { calls, client: client as unknown as ReturnType<typeof getConvexClient> };
}

describe('reportTaskFailure', () => {
	it('reports the failure and logs the retry the backend scheduled', async () => {
		const { calls, client } = fakeClient({
			status: 'queued',
			retried: true,
			attempts: 1,
			nextAttemptAt: Date.now() + 60_000,
		});
		const logged = vi.spyOn(console, 'info').mockImplementation(() => {});

		await reportTaskFailure('task_1', 'Coding agent failed', client);

		expect(calls).toEqual([
			{ name: 'markFailed', args: { taskId: 'task_1', errorMessage: 'Coding agent failed' } },
		]);
		expect(logged.mock.calls.at(-1)?.[0]).toContain('retrying in ~60s');
		logged.mockRestore();
	});

	it('marks a deterministic failure terminal so the backend does not retry it', async () => {
		const { calls, client } = fakeClient({ status: 'failed', retried: false, attempts: 1 });
		const logged = vi.spyOn(console, 'info').mockImplementation(() => {});

		await reportTaskFailure('task_3', 'Coding agent produced no changes', client, {
			terminal: true,
		});

		expect(calls).toEqual([
			{
				name: 'markFailed',
				args: {
					taskId: 'task_3',
					errorMessage: 'Coding agent produced no changes',
					terminal: true,
				},
			},
		]);
		logged.mockRestore();
	});

	it('logs a terminal failure once the backend stops retrying', async () => {
		const { client } = fakeClient({ status: 'failed', retried: false, attempts: 3 });
		const logged = vi.spyOn(console, 'info').mockImplementation(() => {});

		await reportTaskFailure('task_2', 'Coding agent failed', client);

		expect(logged.mock.calls.at(-1)?.[0]).toContain('failed permanently after 3 attempt(s)');
		logged.mockRestore();
	});
});
