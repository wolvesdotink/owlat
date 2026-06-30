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
 * the caller can surface progress for the long-running deploy step.
 */
function run(
	cmd: string,
	args: string[],
	opts: { cwd: string; onLine?: (line: string) => void },
): Promise<RunResult> {
	return new Promise((resolve) => {
		const proc = spawn(cmd, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
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
		{ cwd: owlatDir },
	);
	if (code !== 0) {
		throw new Error(
			`Failed to generate the Convex admin key (\`docker compose exec convex ./generate_admin_key.sh\`): ${
				stderr.trim() || stdout.trim() || `exit ${code}`
			}`,
		);
	}
	const key = parseAdminKey(stdout);
	if (!key) {
		throw new Error(
			`Could not parse an admin key from generate_admin_key.sh output. Got:\n${stdout.trim()}`,
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
	build = false,
): Promise<void> {
	const { code, stdout, stderr } = await run(
		'docker',
		['compose', '--profile', 'deploy', 'run', '--rm', ...(build ? ['--build'] : []), 'convex-deploy'],
		{ cwd: owlatDir, onLine },
	);
	if (code !== 0) {
		throw new Error(
			`convex-deploy failed (exit ${code}). Retry with \`docker compose --profile deploy run --rm convex-deploy\`.\n${
				stderr.trim() || stdout.trim()
			}`,
		);
	}
}

/**
 * Push function-runtime env vars into the backend via `convex env set`, run
 * through the `convex-deploy` container (which has the pinned CLI and the
 * self-hosted URL/admin-key in its environment).
 *
 * Keys and values are passed as argv to the container's `sh` and consumed via
 * positional parameters — so secret values are never interpolated by a host
 * shell and need no escaping. A single container invocation sets every var.
 */
export async function setConvexEnvVars(
	owlatDir: string,
	vars: Array<[string, string]>,
	onLine?: (line: string) => void,
): Promise<void> {
	if (vars.length === 0) return;
	// Loop in the container: consume argv two at a time (key, value).
	// - No --url/--admin-key flags: `convex env set` doesn't support them — the
	//   CLI's self-hosted mode reads CONVEX_SELF_HOSTED_URL/_ADMIN_KEY from the
	//   environment, which the convex-deploy compose service already injects.
	// - `--` ends option parsing: minted secrets are url-safe base64 and can
	//   START WITH `-`, which commander would otherwise parse as an option.
	// - The key (never the value) is echoed so a failure names the culprit.
	const loop =
		'while [ "$#" -ge 2 ]; do ' +
		'echo "env set $1"; ' +
		'convex env set -- "$1" "$2" || exit 1; ' +
		'shift 2; done';
	const flat = vars.flatMap(([k, v]) => [k, v]);
	const { code, stdout, stderr } = await run(
		'docker',
		['compose', '--profile', 'deploy', 'run', '--rm', 'convex-deploy', 'sh', '-c', loop, '_', ...flat],
		{ cwd: owlatDir, onLine },
	);
	if (code !== 0) {
		throw new Error(
			`Failed to set Convex function-runtime env vars (exit ${code}).\n${
				stderr.trim() || stdout.trim()
			}`,
		);
	}
}
