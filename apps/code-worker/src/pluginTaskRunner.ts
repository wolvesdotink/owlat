import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { getConvexClient, pluginFn, type PluginTask } from './convexClient.js';
import { chownDirToSandbox, runUntrusted } from './sandbox.js';
import { removeWorkspace } from './taskRunner.js';

/**
 * Tier-3 plugin-job runner — the generalized half of the code-worker.
 *
 * A plugin job is untrusted compute. It runs through the SAME sandbox seam as
 * the coding agent (`runUntrusted`): dropped to the unprivileged sandbox uid,
 * `shell:false` argv, detached process group, host-clamped wall-clock timeout,
 * and — critically — a job environment stripped of EVERY ambient credential.
 * A plugin job never sees the admin key, GITHUB_TOKEN, or the LLM key; any
 * credentialed capability is mediated by the host over Convex, never by leaking
 * env into the sandbox.
 *
 * Cancellation and retries are host-authoritative: a heartbeat loop proves
 * liveness and learns of an operator cancel (killing the whole process group so
 * a job cannot escape it); the terminal `fail`/`complete` mutations own the
 * retry ceiling and the cancelled-is-never-retried rule.
 */

const WORKSPACE_ROOT = process.env['WORKSPACE_ROOT'] ?? '/workspace';
const DEFAULT_HEARTBEAT_INTERVAL_MS = Number(process.env['PLUGIN_JOB_HEARTBEAT_MS'] ?? 5_000);
const MAX_RESULT_CHARS = 64 * 1024;

function log(msg: string) {
	console.info(`[code-worker] ${new Date().toISOString()} ${msg}`);
}

/** A host-controlled command a job kind maps to. Never built from the payload. */
export interface JobCommandSpec {
	readonly command: string;
	readonly args: string[];
}

/**
 * Resolve a job's untrusted payload into the argv the sandbox runs. The payload
 * is passed as a discrete argv element (or via stdin/a file by later factories),
 * NEVER interpolated into a shell string — same shell-injection isolation the
 * code-worker argv builders rely on.
 */
export type JobCommandFactory = (payload: string) => JobCommandSpec;

/**
 * Built-in job commands, keyed by the LOCAL job id (the suffix of the namespaced
 * `plugin.<pluginId>.<localId>` kind). The registry is host-controlled: a plugin
 * chooses WHICH built-in kind to run, never the command itself. PP-27 ships only
 * the harmless `selftest` diagnostic so the sandbox path is exercised end to end
 * without any plugin code in the worker image; reference plugins (PP-28+) add
 * their real job commands here.
 */
export const BUILTIN_JOB_COMMANDS: Readonly<Record<string, JobCommandFactory>> = Object.freeze({
	// A no-op that exits 0 — proves the uid drop, env stripping, timeout, and
	// cancellation wiring without doing anything a hostile payload could subvert.
	selftest: (): JobCommandSpec => ({ command: 'node', args: ['-e', 'process.exit(0)'] }),
});

const JOB_KIND = /^plugin\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/;

/** The local job id of a well-formed namespaced kind, else null. */
export function jobLocalId(jobKind: string): string | null {
	return JOB_KIND.exec(jobKind)?.[1] ?? null;
}

/**
 * Resolve a namespaced job kind + payload to its host command, or null when the
 * kind is malformed or unregistered — the worker fails such a job closed rather
 * than guessing a command.
 */
export function resolveJobCommand(
	jobKind: string,
	payload: string,
	registry: Readonly<Record<string, JobCommandFactory>> = BUILTIN_JOB_COMMANDS
): JobCommandSpec | null {
	const local = jobLocalId(jobKind);
	if (!local) return null;
	const factory = registry[local];
	return factory ? factory(payload) : null;
}

/**
 * The environment a sandboxed plugin job runs with. It contains NO ambient
 * credentials of any kind — only PATH and a writable HOME inside the job's own
 * workspace. Exported so the no-secret invariant is unit-testable: even if a
 * hostile job reads its entire `process.env`, there is nothing to steal.
 */
export function buildJobEnv(
	workDir: string,
	parentEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
	return {
		PATH: parentEnv['PATH'],
		HOME: workDir,
		CI: 'true',
	};
}

function clampResult(text: string): string {
	return text.length <= MAX_RESULT_CHARS ? text : text.slice(0, MAX_RESULT_CHARS);
}

export interface RunPluginJobDeps {
	readonly client?: ReturnType<typeof getConvexClient>;
	readonly spawnFn?: typeof spawn;
	readonly heartbeatIntervalMs?: number;
	readonly prepareDir?: (dir: string) => void;
	readonly cleanupDir?: (dir: string) => void;
	/** Injected group-kill, threaded into the sandbox for deterministic tests. */
	readonly kill?: (targetPid: number, signal: NodeJS.Signals) => void;
}

/**
 * Prepare a sandbox-writable scratch dir for a job: create it root-owned under
 * /workspace, then chown to the sandbox uid so the untrusted job (uid 10001) can
 * write it. The default in production; injectable in tests.
 */
function defaultPrepareDir(dir: string): void {
	mkdirSync(dir, { recursive: true });
	chownDirToSandbox(dir);
}

/**
 * Run one claimed plugin job end to end: prepare a scratch dir, run the resolved
 * command in the sandbox with a heartbeat-driven cancel watch, and report the
 * terminal outcome to the host. Always cleans up the scratch dir.
 */
export async function runPluginJob(task: PluginTask, deps: RunPluginJobDeps = {}): Promise<void> {
	const client = deps.client ?? getConvexClient();
	const spawnFn = deps.spawnFn ?? spawn;
	const heartbeatIntervalMs = deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
	const prepareDir = deps.prepareDir ?? defaultPrepareDir;
	const cleanupDir = deps.cleanupDir ?? removeWorkspace;
	const workDir = path.join(WORKSPACE_ROOT, `plugin-${task._id}`);

	const spec = resolveJobCommand(task.jobKind, task.payload);
	if (!spec) {
		// Unknown / malformed job kind: fail closed. Nothing is ever spawned.
		await client.mutation(pluginFn.fail, {
			taskId: task._id,
			errorMessage: `Unknown or unregistered job kind: ${task.jobKind}`,
			reasonCode: 'worker_failed',
		});
		return;
	}

	const controller = new AbortController();
	let cancelled = false;
	const heartbeat = setInterval(() => {
		void (async () => {
			try {
				const beat = await client.mutation(pluginFn.heartbeat, { taskId: task._id });
				if (beat.cancelRequested && !cancelled) {
					cancelled = true;
					controller.abort();
				}
			} catch (error) {
				log(`Heartbeat failed for ${task._id}: ${String(error)}`);
			}
		})();
	}, heartbeatIntervalMs);

	try {
		prepareDir(workDir);
		const result = await runUntrusted(
			spec.command,
			spec.args,
			{
				cwd: workDir,
				env: buildJobEnv(workDir),
				timeoutMs: task.timeoutMs,
				signal: controller.signal,
				kill: deps.kill,
			},
			spawnFn
		);

		if (cancelled || result.killed) {
			// The host sees isCancelRequested and records the cancelled terminal state
			// (cancelled jobs are never retried).
			await client.mutation(pluginFn.fail, {
				taskId: task._id,
				errorMessage: 'Job cancelled by operator',
				reasonCode: 'worker_failed',
			});
			return;
		}
		if (result.timedOut) {
			await client.mutation(pluginFn.fail, {
				taskId: task._id,
				errorMessage: `Job exceeded its ${task.timeoutMs}ms budget; process group killed`,
				reasonCode: 'worker_timeout',
			});
			return;
		}
		if (result.code === 0) {
			await client.mutation(pluginFn.complete, {
				taskId: task._id,
				result: clampResult((result.stdout + result.stderr).trim()),
			});
			return;
		}
		await client.mutation(pluginFn.fail, {
			taskId: task._id,
			errorMessage:
				(result.stdout + result.stderr).slice(-500) || `Job exited with code ${result.code}`,
			reasonCode: 'worker_failed',
		});
	} catch (error) {
		await client.mutation(pluginFn.fail, {
			taskId: task._id,
			errorMessage: error instanceof Error ? error.message.slice(0, 500) : String(error),
			reasonCode: 'worker_failed',
		});
	} finally {
		clearInterval(heartbeat);
		cleanupDir(workDir);
	}
}

/** Poll once for a queued plugin job, claim it, and run it. */
export async function pollForPluginTask(deps: RunPluginJobDeps = {}): Promise<void> {
	const client = deps.client ?? getConvexClient();
	const next = await client.query(pluginFn.getNextQueued, {});
	if (!next) return;

	const claim = await client.mutation(pluginFn.claim, { taskId: next._id });
	if (!claim.claimed) return;

	log(`Running plugin job ${claim.job._id} (${claim.job.jobKind})`);
	await runPluginJob(claim.job, deps);
}
