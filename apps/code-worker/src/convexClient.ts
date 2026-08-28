import type { PluginWorkerClaimedJob } from '@owlat/plugin-kit';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';

let client: ConvexHttpClient | null = null;

/**
 * Resolve the Convex key the worker authenticates with.
 *
 * LEAST-PRIVILEGE SEAM (security review M4): this container runs UNTRUSTED,
 * inbound-email-driven code, yet it must reach the backend to poll/claim/complete
 * `codeWorkTasks`. Ideally it would present a key scoped to ONLY those functions
 * rather than the full deployment admin key. Convex self-hosted does not (today)
 * mint per-function scoped keys, so the scoped-key path is a documented DEFERRAL,
 * not a silent gap. The seam is here so an operator who has a narrower key can
 * supply it via `CODE_WORKER_CONVEX_KEY` WITHOUT a code change. The concrete
 * narrower key shipped for this is the `apps/convex-fn-proxy` sidecar: it holds
 * the real admin key, forwards ONLY the thirteen allowlisted `codeWorkTasks:*` /
 * `plugins/workerTasks:*` calls this module makes, and validates+strips the
 * token the worker presents. In that composed deployment `CONVEX_URL` points at
 * the proxy and `CODE_WORKER_CONVEX_KEY` is the proxy token — the token is what
 * `setAdminAuth` sends as `Authorization: Convex <token>`, which the proxy
 * checks and replaces with the admin key. It falls back to `CONVEX_ADMIN_KEY` so
 * existing (non-proxied) installs keep working unchanged — the safe default.
 * When the scoped key / proxy token is set, the admin key never has to enter
 * this container's environment at all.
 */
function resolveConvexKey(): string | undefined {
	// Prefer an explicitly scoped key; fall back to the deployment admin key.
	// Compose files set `CODE_WORKER_CONVEX_KEY: ${CODE_WORKER_CONVEX_KEY:-}`, so
	// an install that never defines the scoped key gets an EMPTY STRING (not
	// undefined) in the container env. `'' ?? adminKey` keeps the empty string, so
	// treat empty/whitespace as unset to actually fall back to the admin key.
	const scoped = process.env['CODE_WORKER_CONVEX_KEY']?.trim();
	return scoped || process.env['CONVEX_ADMIN_KEY']?.trim() || undefined;
}

export function getConvexClient(): ConvexHttpClient {
	if (!client) {
		const url = process.env['CONVEX_URL'];
		const convexKey = resolveConvexKey();
		if (!url) {
			throw new Error('CONVEX_URL environment variable is required');
		}
		// The worker polls `getNextQueued` (an internalQuery) and drives the
		// `internalMutation`s below. Internal functions are not reachable from an
		// anonymous HTTP client, so — exactly like apps/imap and apps/mail-sync —
		// the worker authenticates with a deployment key (a scoped
		// CODE_WORKER_CONVEX_KEY when provided, else CONVEX_ADMIN_KEY).
		if (!convexKey) {
			throw new Error(
				'CODE_WORKER_CONVEX_KEY or CONVEX_ADMIN_KEY environment variable is required'
			);
		}
		client = new ConvexHttpClient(url);
		// `setAdminAuth` is a real runtime method on ConvexHttpClient but is omitted
		// from the published public type — cast to reach it (apps/imap/mail-sync do the same).
		(client as unknown as { setAdminAuth(key: string): void }).setAdminAuth(convexKey);
	}
	return client;
}

export interface CodeWorkTask {
	_id: string;
	description: string;
	inboundMessageId?: string;
	branch?: string;
	prUrl?: string;
	status: 'queued' | 'running' | 'testing' | 'review' | 'merged' | 'failed';
	testResults?: string;
	errorMessage?: string;
	llmCost?: number;
	attempts?: number;
	maxAttempts?: number;
	nextAttemptAt?: number;
	createdAt: number;
	updatedAt: number;
}

/**
 * What the backend did with a failure report: requeued the task behind a
 * backoff window (`retried`, with `nextAttemptAt` naming the earliest next
 * claim) or gave up on it. The retry ceiling and schedule are backend-owned —
 * the worker only reports the failure and logs the verdict.
 */
export interface CodeTaskFailureOutcome {
	status: 'queued' | 'failed';
	retried: boolean;
	attempts: number;
	nextAttemptAt?: number;
}

/**
 * Typed references to the `codeWorkTasks` Convex functions. The code-worker
 * talks to the deployment over HTTP and does not import apps/api's generated
 * `api.d.ts` (that would couple the workspaces), so we declare the argument
 * and return shapes here at the call boundary.
 */
export const fn = {
	getNextQueued: makeFunctionReference<'query', Record<string, never>, CodeWorkTask | null>(
		'codeWorkTasks:getNextQueued'
	),
	claim: makeFunctionReference<'mutation', { taskId: string }, { claimed: boolean } | null>(
		'codeWorkTasks:claim'
	),
	updateBranch: makeFunctionReference<'mutation', { taskId: string; branch: string }, null>(
		'codeWorkTasks:updateBranch'
	),
	markTesting: makeFunctionReference<'mutation', { taskId: string }, null>(
		'codeWorkTasks:markTesting'
	),
	markFailed: makeFunctionReference<
		'mutation',
		{ taskId: string; errorMessage: string; terminal?: boolean },
		CodeTaskFailureOutcome
	>('codeWorkTasks:markFailed'),
	reclaimStale: makeFunctionReference<'mutation', Record<string, never>, { reclaimed: number }>(
		'codeWorkTasks:reclaimStale'
	),
	completeWithPR: makeFunctionReference<
		'mutation',
		{ taskId: string; prUrl: string; testResults: string },
		null
	>('codeWorkTasks:completeWithPR'),
};

/**
 * A claimed Tier-3 plugin job, as returned by `plugins/workerTasks:getNextQueued`
 * and `:claim`. This is the shared `PluginWorkerClaimedJob` wire contract from
 * `@owlat/plugin-kit` — the SAME type the Convex host projects each row into
 * (`pluginWorkerClaimedJobOf`) — so the worker can never read a field name the
 * host does not emit. The worker gets only what it needs to run the job: never
 * the org id, secrets, or host bookkeeping. `payload` is untrusted plugin input;
 * `jobKind` routes to a host-controlled command; `taskId` is echoed back on
 * every follow-up mutation.
 */
export type PluginTask = PluginWorkerClaimedJob;

/** `plugins/workerTasks:claim` result: the claimed job, or why it was not claimed. */
export type PluginClaimResult =
	| { claimed: false; cancelled?: boolean }
	| { claimed: true; job: PluginTask };

/**
 * Typed references to the generalized worker-queue functions. Same call-boundary
 * discipline as `fn` above: the worker does not import apps/api's generated
 * types, so the argument/return shapes are declared here.
 */
export const pluginFn = {
	getNextQueued: makeFunctionReference<'query', Record<string, never>, PluginTask | null>(
		'plugins/workerTasks:getNextQueued'
	),
	claim: makeFunctionReference<'mutation', { taskId: string }, PluginClaimResult>(
		'plugins/workerTasks:claim'
	),
	heartbeat: makeFunctionReference<
		'mutation',
		{ taskId: string },
		{ alive: boolean; cancelRequested: boolean }
	>('plugins/workerTasks:heartbeat'),
	complete: makeFunctionReference<'mutation', { taskId: string; result?: string }, { ok: boolean }>(
		'plugins/workerTasks:complete'
	),
	fail: makeFunctionReference<
		'mutation',
		{ taskId: string; errorMessage: string; reasonCode?: 'worker_failed' | 'worker_timeout' },
		{ status: string; retried: boolean }
	>('plugins/workerTasks:fail'),
	reclaimStale: makeFunctionReference<
		'mutation',
		{ now?: number; leaseMs?: number },
		{ reclaimed: number }
	>('plugins/workerTasks:reclaimStale'),
};
