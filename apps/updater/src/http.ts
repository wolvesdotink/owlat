/**
 * Shared plumbing for the updater's endpoint handlers: JSON responses, body
 * reading, instance-secret auth, docker exec and compose-ps parsing. Split out
 * of server.ts so each privileged endpoint module stays focused on its own
 * control flow (CONVENTIONS.md ~500 LOC rule).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { execFileSync } from 'node:child_process';
import { errorMessage } from '@owlat/shared';
import { parseComposePs, type ComposeService } from '@owlat/shared/containerHealth';
import { safeCompare } from './security.js';

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
	if (typeof provided !== 'string' || !safeCompare(provided, INSTANCE_SECRET)) {
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

/**
 * Run a command with an explicit argv, NEVER a shell.
 *
 * `execFileSync`, not `execSync`: two call sites build their command out of
 * runtime values (the floating IP from a /configure-ip body, the compose file
 * being staged by /update). Both are validated before they get here, so nothing
 * was exploitable — but the signature was the problem, because a string command
 * is an invitation for the next value to be interpolated into a shell. With an
 * argv array there is no shell to inject into, whatever the value contains.
 *
 * No call site needed a pipe, a redirect, `&&` or a glob; the one place that
 * looked shell-shaped (`docker compose -f <file> …`) is just two more argv
 * entries.
 */
export function exec(
	file: string,
	args: string[],
	cwd: string
): { ok: boolean; stdout: string; stderr: string } {
	try {
		const stdout = execFileSync(file, args, {
			cwd,
			env: childEnv(),
			timeout: 300_000, // 5 minutes
			encoding: 'utf-8',
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		return { ok: true, stdout: stdout || '', stderr: '' };
	} catch (err) {
		// Failure = non-zero exit (execFileSync throws), NOT a grep of stderr:
		// docker writes progress to stderr on success, and real failures
		// ('Error response from daemon') broke the old case-sensitive match.
		const e = err as { stdout?: string | Buffer | null; stderr?: string | Buffer | null };
		return {
			ok: false,
			stdout: e.stdout?.toString() || '',
			stderr: e.stderr?.toString() || errorMessage(err),
		};
	}
}

/**
 * Run `docker compose ps` and parse per-service rows (shared by /health and
 * /apply-profiles). Extracts each service's version from its image tag —
 * e.g. "ghcr.io/wolvesdotink/web:0.2.1" → "0.2.1". Org-agnostic, so any
 * allowed registry works.
 */
export function composePsServices(): { containers: ComposeService[]; raw: string } {
	const result = exec('docker', ['compose', 'ps', '--format', 'json'], OWLAT_DIR);

	// Parsing lives in @owlat/shared so the updater and `owlat doctor` can never
	// disagree about what the fleet looks like. It also handles both output
	// shapes Compose has shipped (NDJSON and a single JSON array), and splits
	// the image tag without mistaking a registry port for one.
	return { containers: parseComposePs(result.stdout), raw: result.stdout };
}
