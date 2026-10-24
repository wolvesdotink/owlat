import type { PluginWorkerClaimedJob } from '@owlat/plugin-kit';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import { convexKey as resolveConvexKey, convexUrl } from './config.js';

let client: ConvexHttpClient | null = null;

export function getConvexClient(): ConvexHttpClient {
	if (!client) {
		const url = convexUrl();
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
	cancelledAt?: number;
	/** Commit an earlier attempt was about to push to `branch` (publication checkpoint). */
	publishCommitSha?: string;
	createdAt: number;
	updatedAt: number;
}

/**
 * Why the backend refused a worker callback (see apps/api
 * `lib/codeTaskFence.ts`): the task is gone, the user cancelled it, a newer
 * attempt owns it, or it already left the worker-owned statuses.
 */
export type CodeTaskStopReason = 'missing' | 'cancelled' | 'stale' | 'finished';

export type CodeTaskWorkerVerdict = { ok: true } | { ok: false; reason: CodeTaskStopReason };

/**
 * `claim` result. `attempt` identifies this run on every later call;
 * `mayRunAgent` is false for a reconcile-only claim that may only finish an
 * earlier attempt's publication.
 */
type CodeTaskClaimResult =
	| { claimed: false }
	| { claimed: true; attempt: number; mayRunAgent: boolean };

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
	/** Set when the report was not applied, and why. */
	ignored?: CodeTaskStopReason;
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
	claim: makeFunctionReference<'mutation', { taskId: string }, CodeTaskClaimResult | null>(
		'codeWorkTasks:claim'
	),
	checkAttempt: makeFunctionReference<
		'query',
		{ taskId: string; attempt: number },
		CodeTaskWorkerVerdict
	>('codeWorkTasks:checkAttempt'),
	updateBranch: makeFunctionReference<
		'mutation',
		{ taskId: string; branch: string; attempt: number },
		CodeTaskWorkerVerdict
	>('codeWorkTasks:updateBranch'),
	markTesting: makeFunctionReference<
		'mutation',
		{ taskId: string; attempt: number },
		CodeTaskWorkerVerdict
	>('codeWorkTasks:markTesting'),
	recordPublication: makeFunctionReference<
		'mutation',
		{ taskId: string; attempt: number; branch: string; commitSha: string; testResults: string },
		CodeTaskWorkerVerdict
	>('codeWorkTasks:recordPublication'),
	markFailed: makeFunctionReference<
		'mutation',
		{ taskId: string; errorMessage: string; terminal?: boolean; attempt?: number },
		CodeTaskFailureOutcome
	>('codeWorkTasks:markFailed'),
	reclaimStale: makeFunctionReference<'mutation', Record<string, never>, { reclaimed: number }>(
		'codeWorkTasks:reclaimStale'
	),
	completeWithPR: makeFunctionReference<
		'mutation',
		{ taskId: string; prUrl: string; testResults?: string; attempt: number },
		CodeTaskWorkerVerdict
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

/** What the worker reports about its process (`maintenance/workerRegistry:reportCodeWorker`). */
export type CodeWorkerWireReport = {
	instanceId: string;
	hostLabel: string;
	owlatVersion: string;
	wireVersion: number;
	startedAt: number;
};

/** The backend's side of the code-worker contract (`WorkerWireReportResult` in `@owlat/shared/workerWire`). */
export interface CodeWorkerWireReportResult {
	backendWireVersion: number;
	minSupportedWireVersion: number;
	compatible: boolean;
	reason?: 'server_too_old' | 'backend_older';
}

/**
 * The wire-version report. Its own entry point, which records only a
 * code-worker row, so allowlisting it lets a task forge nothing about the
 * other workers.
 */
export const wireFn = {
	report: makeFunctionReference<'mutation', CodeWorkerWireReport, CodeWorkerWireReportResult>(
		'maintenance/workerRegistry:reportCodeWorker'
	),
};
