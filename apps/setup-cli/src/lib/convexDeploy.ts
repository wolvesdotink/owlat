/**
 * Convex self-host deploy helpers for the setup CLI.
 *
 * A fresh self-hosted Convex backend boots EMPTY: it serves the sync protocol
 * and `/version` on the cloud port, but has zero application functions, no
 * schema, and no function-runtime environment variables. Three host-side steps
 * (all pure `docker compose` calls — they require Docker, not Bun) turn that
 * into a working instance:
 *
 *   1. `generateConvexAdminKey()` — ask the running backend to mint its admin
 *      key (`docker compose exec convex ./generate_admin_key.sh`). The key is
 *      issued by the backend; it CANNOT be fabricated client-side, or every
 *      subsequent admin call is rejected.
 *   2. `deployConvexFunctions()` — push `apps/api` functions + schema + the
 *      `http.route` handlers (`/seed/admin`, tracking, webhooks, …) via the
 *      one-shot `convex-deploy` profile.
 *   3. `setConvexEnvVars()` — write the function-runtime env vars (auth secret,
 *      provider keys, dev mode, …) INTO the backend. Convex functions read
 *      these from the deployment, not from the compose `.env`, so they must be
 *      pushed with `convex env set`.
 *
 * Steps 2 and 3 both run through the `convex-deploy` container, which already
 * pins the Convex CLI and receives `CONVEX_SELF_HOSTED_URL` +
 * `CONVEX_SELF_HOSTED_ADMIN_KEY` (interpolated from `.env` at command time).
 * Writing the freshly-minted admin key to `.env` BEFORE invoking them is what
 * lets the container authenticate.
 */

import { spawn } from 'node:child_process';

// The runtime-env-key SSOT and `.env`-selection helper live in `@owlat/shared`
// so both this CLI and the web setup wizard share one list and one selector
// (`check-env-keys-sync.sh` parses CONVEX_RUNTIME_ENV_KEYS from that shared
// module). Re-exported here so existing CLI importers keep their import path.
export { CONVEX_RUNTIME_ENV_KEYS, selectRuntimeEnvVars } from '@owlat/shared/convexRuntimeEnv';

interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

/**
 * Run a command, capturing stdout/stderr. `onLine` streams combined output so
 * the caller can surface progress for the long-running deploy step. `input`,
 * when given, is written to the child's stdin before it is closed.
 */
function run(
	cmd: string,
	args: string[],
	opts: { cwd: string; onLine?: (line: string) => void; input?: string }
): Promise<RunResult> {
	return new Promise((resolve) => {
		const proc = spawn(cmd, args, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
		// A child that exits before reading everything closes the pipe; the exit
		// code reports that failure, so swallow the resulting EPIPE. Without
		// `input` stdin is closed straight away, as `ignore` would.
		proc.stdin.on('error', () => {});
		proc.stdin.end(opts.input);
		let stdout = '';
		let stderr = '';
		proc.stdout.on('data', (d: Buffer) => {
			const s = d.toString();
			stdout += s;
			if (opts.onLine) for (const line of s.split('\n')) if (line.trim()) opts.onLine(line);
		});
		proc.stderr.on('data', (d: Buffer) => {
			const s = d.toString();
			stderr += s;
			if (opts.onLine) for (const line of s.split('\n')) if (line.trim()) opts.onLine(line);
		});
		proc.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
		proc.on('error', (err) => resolve({ code: 1, stdout, stderr: stderr + String(err) }));
	});
}

/**
 * Parse the admin key out of `generate_admin_key.sh` output. The key is a long
 * token, sometimes prefixed (`convex-self-hosted|<hex>`); we keep the whole
 * token (including any `|`) and take the last key-shaped token printed.
 */
export function parseAdminKey(output: string): string | null {
	const tokens = output
		.split(/\s+/)
		.map((t) => t.trim())
		.filter(Boolean);
	const candidates = tokens.filter((t) => /^[A-Za-z0-9_|+/=-]{20,}$/.test(t));
	return candidates.length > 0 ? candidates[candidates.length - 1]! : null;
}

/**
 * A real self-hosted admin key is issued by the backend. We previously
 * fabricated a random 48-char string here, which the backend rejects — so a
 * value that is purely `[A-Za-z0-9]` with no `|` separator is treated as
 * "not a real backend key" and regenerated.
 */
export function looksLikeRealAdminKey(value: string | undefined): boolean {
	return typeof value === 'string' && value.includes('|') && value.length >= 20;
}

/** Mint the backend's admin key. Throws with backend output on failure. */
export async function generateConvexAdminKey(owlatDir: string): Promise<string> {
	const { code, stdout, stderr } = await run(
		'docker',
		['compose', 'exec', '-T', 'convex', './generate_admin_key.sh'],
		{ cwd: owlatDir }
	);
	if (code !== 0) {
		throw new Error(
			`Failed to generate the Convex admin key (\`docker compose exec convex ./generate_admin_key.sh\`): ${
				stderr.trim() || stdout.trim() || `exit ${code}`
			}`
		);
	}
	const key = parseAdminKey(stdout);
	if (!key) {
		throw new Error(
			`Could not parse an admin key from generate_admin_key.sh output. Got:\n${stdout.trim()}`
		);
	}
	return key;
}

/**
 * Deploy `apps/api` functions to the backend via the one-shot `convex-deploy`
 * profile. Reads `CONVEX_ADMIN_KEY` from `.env` (compose interpolation), so the
 * caller must have written the real key first. `build` (local-source installs)
 * builds the deployer image from the tree instead of pulling the published tag.
 */
export async function deployConvexFunctions(
	owlatDir: string,
	onLine?: (line: string) => void,
	build = false
): Promise<void> {
	const { code, stdout, stderr } = await run(
		'docker',
		[
			'compose',
			'--profile',
			'deploy',
			'run',
			'--rm',
			...(build ? ['--build'] : []),
			'convex-deploy',
		],
		{ cwd: owlatDir, onLine }
	);
	if (code !== 0) {
		throw new Error(
			`convex-deploy failed (exit ${code}). Retry with \`docker compose --profile deploy run --rm convex-deploy\`.\n${
				stderr.trim() || stdout.trim()
			}`
		);
	}
}

/**
 * The loop `setConvexEnvVars` runs in the `convex-deploy` container. It reads
 * one `KEY BASE64VALUE` line per variable from stdin, decodes the value into a
 * private temp file and hands that file to `convex env set --from-file`, which
 * sets the variable to the file's exact contents.
 *
 * - No value is ever an argument, on the host or in the container: the docker
 *   CLI's argv and the container's `Config.Cmd` hold only this script, and
 *   `convex env set` gets a file path. Base64 carries any byte (spaces, quotes,
 *   `=`, `#`, newlines) through the line-based `read`.
 * - `umask 077` + `mktemp` keep the file owner-only; the trap removes it on
 *   any exit, and `--rm` discards the container's filesystem afterwards.
 * - No --url/--admin-key flags: `convex env set` doesn't support them — the
 *   CLI's self-hosted mode reads CONVEX_SELF_HOSTED_URL/_ADMIN_KEY from the
 *   environment, which the convex-deploy compose service already injects.
 * - `--` before the name stays as a guard. The old argv form needed it for
 *   values starting with `-`; names are fixed identifiers.
 * - `convex` gets `/dev/null` as stdin, so it cannot swallow the rest of the
 *   payload.
 * - The key (never the value) is echoed so a failure names the culprit.
 */
const ENV_SET_SCRIPT = [
	'umask 077',
	'f=$(mktemp) || exit 1',
	'trap \'rm -f "$f"\' EXIT',
	'while read -r k v; do',
	'  echo "env set $k"',
	'  printf "%s" "$v" | base64 -d > "$f" || exit 1',
	'  convex env set --from-file "$f" -- "$k" < /dev/null || exit 1',
	'done',
].join('\n');

/**
 * The stdin payload for {@link ENV_SET_SCRIPT}: one `KEY BASE64VALUE` line per
 * variable. Throws on a key that is not a plain identifier, since the key is
 * the one field the script reads verbatim.
 */
export function encodeEnvSetPayload(vars: Array<[string, string]>): string {
	return vars
		.map(([key, value]) => {
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
				throw new Error(
					`Refusing to set Convex env var with an invalid name: ${JSON.stringify(key)}`
				);
			}
			return `${key} ${Buffer.from(value, 'utf-8').toString('base64')}\n`;
		})
		.join('');
}

/**
 * Push function-runtime env vars into the backend via `convex env set`, run
 * through the `convex-deploy` container (which has the pinned CLI and the
 * self-hosted URL/admin-key in its environment).
 *
 * The values travel on the container's stdin (see {@link ENV_SET_SCRIPT}), so
 * they never show up in the host's process table (`ps`, `/proc/<pid>/cmdline`)
 * or in the container's `Config.Cmd`. A single container invocation sets every
 * var.
 */
export async function setConvexEnvVars(
	owlatDir: string,
	vars: Array<[string, string]>,
	onLine?: (line: string) => void
): Promise<void> {
	if (vars.length === 0) return;
	const input = encodeEnvSetPayload(vars);
	// `-T`: no TTY, so the payload reaches the script byte for byte (compose run
	// keeps stdin open by default).
	const { code, stdout, stderr } = await run(
		'docker',
		[
			'compose',
			'--profile',
			'deploy',
			'run',
			'--rm',
			'-T',
			'convex-deploy',
			'sh',
			'-c',
			ENV_SET_SCRIPT,
		],
		{ cwd: owlatDir, onLine, input }
	);
	if (code !== 0) {
		throw new Error(
			`Failed to set Convex function-runtime env vars (exit ${code}).\n${
				stderr.trim() || stdout.trim()
			}`
		);
	}
}

/**
 * The loop `removeConvexEnvVars` runs in the `convex-deploy` container: one
 * `convex env remove` per name passed as a positional argument (names are
 * not secret, and the caller checks each one is a plain identifier).
 * `convex env remove` succeeds for a variable that is not set, so a retry
 * after a partial failure is safe. The `env removed` marker is printed only
 * after a removal succeeded; the host parses it to know which names are gone
 * when a later one fails.
 */
const ENV_REMOVE_SCRIPT = [
	'for k in "$@"; do',
	'  convex env remove -- "$k" < /dev/null || exit 1',
	'  echo "env removed $k"',
	'done',
].join('\n');

/**
 * Thrown by {@link removeConvexEnvVars}. `removed` lists the names the
 * deployment confirmed before the failure; every other requested name is
 * still set there.
 */
export class ConvexEnvRemoveError extends Error {
	constructor(
		message: string,
		readonly removed: string[]
	) {
		super(message);
		this.name = 'ConvexEnvRemoveError';
	}
}

/**
 * Remove function-runtime env vars from the backend's env store with `convex
 * env remove`, through the same `convex-deploy` container as
 * {@link setConvexEnvVars}. Stops at the first failure and throws a
 * {@link ConvexEnvRemoveError} naming the vars that were already removed.
 */
export async function removeConvexEnvVars(
	owlatDir: string,
	keys: string[],
	onLine?: (line: string) => void
): Promise<void> {
	if (keys.length === 0) return;
	for (const key of keys) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
			throw new ConvexEnvRemoveError(
				`Refusing to remove Convex env var with an invalid name: ${JSON.stringify(key)}`,
				[]
			);
		}
	}
	const { code, stdout, stderr } = await run(
		'docker',
		[
			'compose',
			'--profile',
			'deploy',
			'run',
			'--rm',
			'-T',
			'convex-deploy',
			'sh',
			'-c',
			ENV_REMOVE_SCRIPT,
			'sh',
			...keys,
		],
		{ cwd: owlatDir, onLine }
	);
	if (code !== 0) {
		const removed = keys.filter((key) =>
			stdout.split('\n').some((line) => line.trim() === `env removed ${key}`)
		);
		throw new ConvexEnvRemoveError(
			`Failed to remove Convex function-runtime env vars (exit ${code}).\n${
				stderr.trim() || stdout.trim()
			}`,
			removed
		);
	}
}
