/**
 * The worker's environment, read in one place.
 *
 * This is the only module that reads `process.env` (the workspace lint enforces
 * it). Each setting is read when it is asked for: the worker asks for most of
 * them at boot, and tests change variables between calls. Parsing that needs
 * nothing but the values (env.ts, `parseRepoUrl`) takes them as arguments.
 *
 * Child processes: an untrusted child (the coding agent, its test run, a plugin
 * job) is built from `sandboxParentEnv`, which carries only PATH and the LLM
 * endpoint, and the builders in taskRunner.ts and pluginTaskRunner.ts then pick
 * from it key by key. Only the git commands the worker runs as root inherit its
 * whole environment, through `trustedGitEnv`.
 */

import { readIntEnv, readWorkerTimers, type WorkerTimers } from './env.js';

/** Poll and heartbeat intervals; throws on a value that is not a sane delay. */
export function loadWorkerTimers(): WorkerTimers {
	return readWorkerTimers(process.env);
}

export function convexUrl(): string | undefined {
	return process.env['CONVEX_URL'];
}

/**
 * The Convex key the worker authenticates with.
 *
 * LEAST-PRIVILEGE SEAM (security review M4): this container runs UNTRUSTED,
 * inbound-email-driven code, yet it must reach the backend to poll/claim/complete
 * `codeWorkTasks`. Ideally it would present a key scoped to ONLY those functions
 * rather than the full deployment admin key. Convex self-hosted does not (today)
 * mint per-function scoped keys, so the scoped-key path is a documented DEFERRAL,
 * not a silent gap. The seam is here so an operator who has a narrower key can
 * supply it via `CODE_WORKER_CONVEX_KEY` WITHOUT a code change. The concrete
 * narrower key shipped for this is the `apps/convex-fn-proxy` sidecar: it holds
 * the real admin key, forwards ONLY the sixteen allowlisted `codeWorkTasks:*` /
 * `plugins/workerTasks:*` / wire-report calls convexClient.ts makes, and validates+strips the
 * token the worker presents. In that composed deployment `CONVEX_URL` points at
 * the proxy and `CODE_WORKER_CONVEX_KEY` is the proxy token — the token is what
 * `setAdminAuth` sends as `Authorization: Convex <token>`, which the proxy
 * checks and replaces with the admin key. It falls back to `CONVEX_ADMIN_KEY` so
 * existing (non-proxied) installs keep working unchanged — the safe default.
 * When the scoped key / proxy token is set, the admin key never has to enter
 * this container's environment at all.
 */
export function convexKey(): string | undefined {
	// Prefer an explicitly scoped key; fall back to the deployment admin key.
	// Compose files set `CODE_WORKER_CONVEX_KEY: ${CODE_WORKER_CONVEX_KEY:-}`, so
	// an install that never defines the scoped key gets an EMPTY STRING (not
	// undefined) in the container env. `'' ?? adminKey` keeps the empty string, so
	// treat empty/whitespace as unset to actually fall back to the admin key.
	const scoped = process.env['CODE_WORKER_CONVEX_KEY']?.trim();
	return scoped || process.env['CONVEX_ADMIN_KEY']?.trim() || undefined;
}

/** The image's `OWLAT_VERSION`, reported with the wire version; `dev` when unset or empty. */
export function owlatVersion(): string {
	return process.env['OWLAT_VERSION'] || 'dev';
}

export function githubToken(): string | undefined {
	return process.env['GITHUB_TOKEN'];
}

/** `OPENCODE_BIN`, unset when the agent runs as plain `opencode` from PATH. */
export function configuredOpencodeBin(): string | undefined {
	return process.env['OPENCODE_BIN'];
}

/** The volume task and plugin-job workspaces are created under. */
export function workspaceRoot(): string {
	return process.env['WORKSPACE_ROOT'] ?? '/workspace';
}

/**
 * The uid/gid untrusted children are dropped to (`CODE_SANDBOX_UID` /
 * `CODE_SANDBOX_GID`, default 10001, the Dockerfile's `sandbox` account). A
 * malformed or non-positive value throws.
 */
export function readSandboxIds(): { uid: number; gid: number } {
	return {
		uid: readIntEnv(process.env, 'CODE_SANDBOX_UID', { default: 10001, min: 1 }),
		gid: readIntEnv(process.env, 'CODE_SANDBOX_GID', { default: 10001, min: 1 }),
	};
}

/** The repository code tasks clone, branch from and open pull requests on. */
export interface RepositorySettings {
	/** `GIT_REPO_URL` as configured, credential included; parseRepoUrl splits it. */
	gitRepoUrl: string;
	workspaceRoot: string;
	baseBranch: string;
	githubOwner: string;
	githubRepo: string;
}

export function readRepositorySettings(): RepositorySettings {
	return {
		gitRepoUrl: process.env['GIT_REPO_URL'] ?? '',
		workspaceRoot: workspaceRoot(),
		baseBranch: process.env['GIT_BASE_BRANCH'] ?? 'main',
		githubOwner: process.env['GITHUB_OWNER'] ?? '',
		githubRepo: process.env['GITHUB_REPO'] ?? '',
	};
}

/**
 * The only worker variables an untrusted child may be built from. The
 * per-child builders choose from these again (a test run or plugin job gets PATH
 * alone); no token, Convex key or other worker secret is in the set to choose.
 */
export function sandboxParentEnv(): NodeJS.ProcessEnv {
	return {
		PATH: process.env['PATH'],
		LLM_BASE_URL: process.env['LLM_BASE_URL'],
		LLM_API_KEY: process.env['LLM_API_KEY'],
	};
}

/**
 * The environment for a git command the worker runs as root: its own, plus the
 * out-of-band credential header. Never for a child that runs task code.
 */
export function trustedGitEnv(gitAuthEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return { ...process.env, ...gitAuthEnv };
}
