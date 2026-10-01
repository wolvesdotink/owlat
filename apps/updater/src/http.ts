/**
 * Shared plumbing for the updater's endpoint handlers: JSON responses, body
 * reading, instance-secret auth, docker exec and compose-ps parsing. Split out
 * of server.ts so each privileged endpoint module stays focused on its own
 * control flow (CONVENTIONS.md ~500 LOC rule).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { errorMessage } from '@owlat/shared';
import { parseComposePs, type ComposeService } from '@owlat/shared/containerHealth';
import { secretMatches } from '@owlat/shared/constantTimeEqual';

const INSTANCE_SECRET = process.env['INSTANCE_SECRET'];
export const OWLAT_DIR = process.env['OWLAT_DIR'] || '/opt/owlat';

export function json(res: ServerResponse, status: number, body: unknown) {
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(body));
}

export function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on('data', (chunk: Buffer) => chunks.push(chunk));
		req.on('end', () => resolve(Buffer.concat(chunks).toString()));
		req.on('error', reject);
	});
}

/**
 * Validate that the request has a valid instance secret.
 * Returns true if authorized, false otherwise (and sends 401 response).
 */
export function requireAuth(req: IncomingMessage, res: ServerResponse): boolean {
	if (!INSTANCE_SECRET) {
		json(res, 500, { error: 'INSTANCE_SECRET not configured' });
		return false;
	}

	const provided = req.headers['x-instance-secret'];
	if (typeof provided !== 'string' || !secretMatches(provided, INSTANCE_SECRET)) {
		json(res, 401, { error: 'Unauthorized' });
		return false;
	}

	return true;
}

/**
 * The variables the updater must not hand down to a `docker compose` child.
 *
 * Compose resolves `${VAR}` from the CLI's OWN environment before it consults
 * `--env-file`. The updater is itself a service in the file it is applying
 * (`OWLAT_VERSION: ${OWLAT_VERSION:-dev}`), so it carries the version it was
 * created at — the OLD one — and passes it straight back to compose, where it
 * shadows the `.env` the rollout has just pinned to the new release. The pin
 * step writes the right value; the `up` that follows never sees it.
 *
 * It fails silently because a release compose template pins its images
 * literally, so the containers DO come up on the new release: only the
 * interpolated values go stale. A 0.5.2 → 0.5.3 rollout left `web`, `mta` and
 * `updater` running 0.5.3 images that report `OWLAT_VERSION=0.5.2`, while
 * `imap` and `mail-sync` — which override nothing and keep the value baked
 * into their image — were correct. Locally built services have it worse: for
 * them the interpolation IS the image tag (`owlat-code-worker:${OWLAT_VERSION:-dev}`),
 * so the rollout points them back at the previous release.
 *
 * Dropping them leaves `--env-file` as the single source of truth, which is
 * what the rest of the rollout already assumes it is.
 */
export const COMPOSE_SHADOWED_VARS = [
	'OWLAT_VERSION',
	'OWLAT_GIT_SHA',
	'OWLAT_BUILD_DATE',
] as const;

/**
 * `process.env` minus the variables compose would let shadow `--env-file`.
 *
 * Unconditional rather than per-call-site: no command this sidecar runs needs
 * its own `OWLAT_*` to reach a child, and a conditional version is a rule every
 * future compose call site has to remember — which is how the shadowing got in.
 */
function childEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const name of COMPOSE_SHADOWED_VARS) delete env[name];
	return env;
}

/** What a child process left behind. Success is its exit status, nothing else. */
export interface ExecResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

export interface ExecOptions {
	/** Hard bound on the command; defaults to five minutes. */
	timeoutMs?: number;
	/** How long a child told to stop gets before it is killed. */
	killGraceMs?: number;
	/**
	 * Stop the command early when this aborts. Only for work that is safe to
	 * abandon (a pull, a deploy against the old stack); a recreate that is cut
	 * short is what leaves an instance dark, so `up` never takes one.
	 */
	signal?: AbortSignal;
}

const EXEC_TIMEOUT_MS = 300_000;

/** How long a child that was asked to stop gets before it is killed. */
const EXEC_KILL_GRACE_MS = 5_000;

/**
 * What is kept of each stream. Compose writes pull progress to stderr, and a
 * cold pull of a whole release is a lot of it; the error that explains a
 * failure is at the end, so the tail is what survives.
 */
const EXEC_OUTPUT_LIMIT = 2 * 1024 * 1024;

/** The tail of a stream, bounded at `limit` bytes however much the child writes. */
class OutputTail {
	private chunks: Buffer[] = [];
	private size = 0;
	private dropped = 0;

	constructor(private readonly limit: number) {}

	push(chunk: Buffer): void {
		this.chunks.push(chunk);
		this.size += chunk.length;
		while (this.size > this.limit && this.chunks.length > 0) {
			const first = this.chunks[0]!;
			const excess = this.size - this.limit;
			if (first.length <= excess) {
				this.chunks.shift();
				this.size -= first.length;
				this.dropped += first.length;
			} else {
				this.chunks[0] = first.subarray(excess);
				this.size -= excess;
				this.dropped += excess;
			}
		}
	}

	toString(): string {
		const text = Buffer.concat(this.chunks).toString('utf-8');
		return this.dropped > 0 ? `[${this.dropped} earlier bytes omitted]\n${text}` : text;
	}
}

/** Every child `exec` has started and not yet collected. */
const running = new Set<ChildProcess>();

/** How often a stopping group is checked for members still running. */
const GROUP_POLL_MS = 25;

/** How long a group that was sent SIGKILL gets to be collected. */
const GROUP_COLLECT_MS = 1_000;

/**
 * Signal a child's whole process group. `docker` runs `compose` as a plugin in
 * a process of its own, so signalling only the CLI would leave the plugin
 * running the pull on its own.
 *
 * The group outlives its leader: a CLI that exits on SIGTERM can leave a
 * plugin that ignored it, so the group is signalled whether or not the child
 * itself is still there.
 */
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
	// No pid, no group: the child never started (or is not a real process).
	if (child.pid === undefined) {
		child.kill(signal);
		return;
	}
	try {
		process.kill(-child.pid, signal);
	} catch {
		// The group is gone already, or never formed; try the child itself.
		child.kill(signal);
	}
}

/** Whether anything is left of a child's process group, leader or not. */
function groupAlive(child: ChildProcess): boolean {
	// No pid, no group: only the child itself can still be there.
	if (child.pid === undefined) return child.exitCode === null && child.signalCode === null;
	try {
		process.kill(-child.pid, 0);
		return true;
	} catch (err) {
		// ESRCH: no process is left in the group. Anything else (EPERM) means
		// one is, even if it cannot be signalled.
		return (err as NodeJS.ErrnoException).code !== 'ESRCH';
	}
}

/** Poll until a child's group is empty or `ms` runs out; true if it emptied. */
async function groupGone(child: ChildProcess, ms: number): Promise<boolean> {
	const until = Date.now() + ms;
	while (groupAlive(child)) {
		const left = until - Date.now();
		if (left <= 0) return false;
		await new Promise((resolve) => setTimeout(resolve, Math.min(GROUP_POLL_MS, left)));
	}
	return true;
}

/**
 * Stop a child's whole process group: SIGTERM, SIGKILL for whatever is left
 * once `graceMs` runs out, then `GROUP_COLLECT_MS` for it to be collected.
 * Waits on the group rather than the child, since the child exiting says
 * nothing about the processes it started. Bounded, so a process that cannot
 * be collected (stuck in the kernel) delays a shutdown but never holds it.
 */
async function stopGroup(child: ChildProcess, graceMs: number): Promise<void> {
	signalGroup(child, 'SIGTERM');
	if (await groupGone(child, graceMs)) return;
	signalGroup(child, 'SIGKILL');
	await groupGone(child, GROUP_COLLECT_MS);
}

/**
 * Run a command with an explicit argv, NEVER a shell, without blocking the
 * event loop.
 *
 * `spawn` with an argv, not a command string: two call sites build their
 * command out of runtime values (the floating IP from a /configure-ip body,
 * the compose file being staged by /update). Both are validated before they
 * get here, but a string command is an invitation for the next value to be
 * interpolated into a shell. With an argv array there is no shell to inject
 * into, whatever the value contains.
 *
 * Asynchronous because a pull, a deploy or a recreate takes minutes. This used
 * to be execFileSync, and for as long as one ran the updater could not answer
 * /health, turn a second rollout away with a 409, or even notice a SIGTERM, so
 * Docker's stop timeout killed it partway through a rollout it had promised to
 * finish.
 *
 * The child runs in a process group of its own, so a timeout (or `signal`)
 * stops the plugin doing the work too: SIGTERM first, SIGKILL for whatever of
 * the group is still there `EXEC_KILL_GRACE_MS` later. The promise settles
 * once the child has exited and, for a command that was stopped, once its
 * group has too (or the kill's bound runs out), never while it is running.
 * Output is bounded (`OutputTail`) rather than fatal when it runs long, since
 * a verbose pull is not a failure.
 */
export function exec(
	file: string,
	args: string[],
	cwd: string,
	options: ExecOptions = {}
): Promise<ExecResult> {
	const timeoutMs = options.timeoutMs ?? EXEC_TIMEOUT_MS;
	const killGraceMs = options.killGraceMs ?? EXEC_KILL_GRACE_MS;
	const { signal } = options;
	if (signal?.aborted) {
		return Promise.resolve({
			ok: false,
			stdout: '',
			stderr: `${file} was not started: the updater is shutting down`,
		});
	}

	return new Promise((resolve) => {
		const stdout = new OutputTail(EXEC_OUTPUT_LIMIT);
		const stderr = new OutputTail(EXEC_OUTPUT_LIMIT);
		let stopped: string | undefined;
		let failure: Error | undefined;
		let settled = false;
		let stopping: Promise<void> | undefined;
		let reapTimer: NodeJS.Timeout | undefined;

		let child: ChildProcess;
		try {
			child = spawn(file, args, {
				cwd,
				env: childEnv(),
				stdio: ['ignore', 'pipe', 'pipe'],
				detached: true,
			});
		} catch (err) {
			resolve({ ok: false, stdout: '', stderr: errorMessage(err) });
			return;
		}
		running.add(child);

		// `close` waits for the pipes as well as the process, and a grandchild
		// that left the group could hold them open forever. Once a child that
		// was told to stop has exited, its pipes get a moment to drain and no
		// longer.
		let exited: { code: number | null; killedBy: NodeJS.Signals | null } | undefined;
		const reap = () => {
			reapTimer ??= setTimeout(() => settle(exited?.code ?? null, exited?.killedBy ?? null), 1_000);
		};
		// The group is stopped even when the child has exited already: what it
		// started can still be running, and still holding the pipes.
		const stop = (reason: string) => {
			if (stopped) return;
			stopped = reason;
			stopping = stopGroup(child, killGraceMs);
			if (exited) reap();
		};
		const onAbort = () => stop('was stopped because the updater is shutting down');
		const timer = setTimeout(() => stop(`timed out after ${timeoutMs / 1000}s`), timeoutMs);
		signal?.addEventListener('abort', onAbort, { once: true });

		const settle = (code: number | null, killedBy: NodeJS.Signals | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearTimeout(reapTimer);
			signal?.removeEventListener('abort', onAbort);
			// A stopped command is collected with its group, not just its leader:
			// it stays in `running` (for the shutdown deadline to see) until then.
			const done = (result: ExecResult) => {
				const collected = stopping ?? Promise.resolve();
				void collected.then(() => {
					running.delete(child);
					resolve(result);
				});
			};

			const out = stdout.toString();
			const err = stderr.toString();
			// Failure = the exit status, NOT a grep of stderr: docker writes
			// progress to stderr on success, and real failures ('Error response
			// from daemon') broke the old case-sensitive match.
			if (code === 0 && !stopped && !failure) {
				done({ ok: true, stdout: out, stderr: err });
				return;
			}
			// Say why when the child's own output does not: it was stopped, it
			// never started, or it failed without a word.
			const why = failure
				? errorMessage(failure)
				: stopped
					? `${file} ${stopped}`
					: err
						? ''
						: `${file} exited with ${killedBy ? `signal ${killedBy}` : `code ${code}`}`;
			done({
				ok: false,
				stdout: out,
				stderr: why ? [err.trimEnd(), why].filter(Boolean).join('\n') : err,
			});
		};

		child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
		child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
		child.on('error', (err) => {
			failure = err;
			// A child that never started emits no `close` to wait for.
			if (child.pid === undefined) settle(null, null);
		});
		child.on('exit', (code, killedBy) => {
			exited = { code, killedBy };
			if (stopped) reap();
		});
		child.on('close', (code, killedBy) => settle(code, killedBy));
	});
}

/**
 * Stop every child still running, with its process group, and wait (bounded)
 * for each group to empty. For the shutdown deadline: a process about to exit
 * must not leave a `docker compose` behind it, still acting on the stack with
 * nobody left to report on it.
 */
export async function stopRunningChildren(graceMs = EXEC_KILL_GRACE_MS): Promise<void> {
	// By group, not by child: a child that has exited can leave the processes
	// it started running, and those are what must not outlive the updater.
	await Promise.all([...running].map((child) => stopGroup(child, graceMs)));
}

/**
 * Run `docker compose ps` and parse per-service rows (shared by /health and
 * /apply-profiles). Extracts each service's version from its image tag —
 * e.g. "ghcr.io/wolvesdotink/web:0.2.1" → "0.2.1". Org-agnostic, so any
 * allowed registry works.
 */
export async function composePsServices(): Promise<{ containers: ComposeService[]; raw: string }> {
	const result = await exec('docker', ['compose', 'ps', '--format', 'json'], OWLAT_DIR);

	// Parsing lives in @owlat/shared so the updater and `owlat doctor` can never
	// disagree about what the fleet looks like. It also handles both output
	// shapes Compose has shipped (NDJSON and a single JSON array), and splits
	// the image tag without mistaking a registry port for one.
	return { containers: parseComposePs(result.stdout), raw: result.stdout };
}
