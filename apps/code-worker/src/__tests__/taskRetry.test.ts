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

/**
 * The worker drives internal Convex functions, so it only starts when a working
 * Convex credential reaches the container. A VPS install shipped without one for
 * a while: the sidecar threw at startup and every code task sat queued forever,
 * silently. As of security review M4 that credential is NOT the admin key — the
 * worker holds only the `CODE_WORKER_PROXY_TOKEN` and reaches Convex through the
 * `convex-fn-proxy` sidecar, which holds the admin key. Pin BOTH the worker's
 * proxy wiring and the proxy's admin-key wiring in BOTH shipped stacks.
 */
describe('code-worker compose wiring', () => {
	const composeFiles = ['docker-compose.yml', 'infra/templates/docker-compose.vps.yml'];

	/** A named service block of a compose file (up to the next service key). */
	const serviceBlock = (compose: string, name: string): string => {
		const start = compose.indexOf(`\n  ${name}:\n`);
		expect(start).toBeGreaterThan(-1);
		const rest = compose.slice(start + 1);
		const next = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
		return next === -1 ? rest : rest.slice(0, next);
	};
	const codeWorkerService = (compose: string): string => serviceBlock(compose, 'code-worker');

	it.each(composeFiles)(
		'%s routes the worker through convex-fn-proxy with the proxy token, NOT the admin key',
		(path) => {
			const service = codeWorkerService(readFileSync(resolve(REPO_ROOT, path), 'utf8'));
			// The worker points at the allowlist proxy and authenticates with the
			// proxy token — the admin key never enters the worker container.
			expect(service).toMatch(/^ {6}CONVEX_URL: http:\/\/convex-fn-proxy:3220$/m);
			expect(service).toMatch(/^ {6}CODE_WORKER_CONVEX_KEY: \$\{CODE_WORKER_PROXY_TOKEN(:-)?\}$/m);
			expect(service).not.toMatch(/^ {6}CONVEX_ADMIN_KEY:/m);
			// Egress is forced through the allowlisted forward-proxy.
			expect(service).toMatch(/^ {6}HTTPS_PROXY: http:\/\/code-worker-egress:8888$/m);
		}
	);

	it.each(composeFiles)(
		'%s gives the admin key to convex-fn-proxy, which validates the proxy token',
		(path) => {
			const proxy = serviceBlock(readFileSync(resolve(REPO_ROOT, path), 'utf8'), 'convex-fn-proxy');
			expect(proxy).toMatch(/^ {6}CONVEX_URL: http:\/\/convex:3210$/m);
			expect(proxy).toMatch(/^ {6}CONVEX_ADMIN_KEY: \$\{CONVEX_ADMIN_KEY(:-)?\}$/m);
			expect(proxy).toMatch(/^ {6}CODE_WORKER_PROXY_TOKEN: \$\{CODE_WORKER_PROXY_TOKEN(:-)?\}$/m);
		}
	);

	// `codeWorkTasks.reclaimStale` requeues every running/testing row whenever a
	// worker starts, on the premise that a fresh process owns none of them. A
	// second replica would therefore rip the first one's in-flight task away.
	it.each(composeFiles)('%s pins the code-worker to a single replica', (path) => {
		const service = codeWorkerService(readFileSync(resolve(REPO_ROOT, path), 'utf8'));
		expect(service).toMatch(/^ {4}deploy:\n {6}replicas: 1$/m);
	});
});
