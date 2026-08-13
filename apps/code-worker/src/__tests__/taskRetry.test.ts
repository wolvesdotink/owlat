import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFunctionName } from 'convex/server';
import { describe, it, expect, vi } from 'vitest';
import { reportTaskFailure } from '../taskRunner.js';
import { getConvexClient } from '../convexClient.js';
import type { CodeTaskFailureOutcome } from '../convexClient.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

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

	it('logs a terminal failure once the backend stops retrying', async () => {
		const { client } = fakeClient({ status: 'failed', retried: false, attempts: 3 });
		const logged = vi.spyOn(console, 'info').mockImplementation(() => {});

		await reportTaskFailure('task_2', 'Coding agent failed', client);

		expect(logged.mock.calls.at(-1)?.[0]).toContain('failed permanently after 3 attempt(s)');
		logged.mockRestore();
	});
});

/**
 * The worker drives internal Convex functions, so it only starts when the
 * deployment admin key reaches the container. A VPS install shipped without it
 * for a while: the sidecar threw at startup and every code task sat queued
 * forever, silently. Pin the wiring in BOTH shipped stacks.
 */
describe('code-worker compose wiring', () => {
	const composeFiles = ['docker-compose.yml', 'infra/templates/docker-compose.vps.yml'];

	/** The `code-worker:` block of a compose file (up to the next service key). */
	const codeWorkerService = (compose: string): string => {
		const start = compose.indexOf('\n  code-worker:\n');
		expect(start).toBeGreaterThan(-1);
		const rest = compose.slice(start + 1);
		const next = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
		return next === -1 ? rest : rest.slice(0, next);
	};

	it.each(composeFiles)('%s passes CONVEX_ADMIN_KEY to the code-worker service', (path) => {
		const service = codeWorkerService(readFileSync(resolve(REPO_ROOT, path), 'utf8'));
		expect(service).toMatch(/^ {6}CONVEX_ADMIN_KEY: \$\{CONVEX_ADMIN_KEY(:-)?\}$/m);
		expect(service).toMatch(/^ {6}CONVEX_URL: http:\/\/convex:3210$/m);
	});
});
