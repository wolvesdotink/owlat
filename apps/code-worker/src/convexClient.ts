import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';

let client: ConvexHttpClient | null = null;

export function getConvexClient(): ConvexHttpClient {
	if (!client) {
		const url = process.env['CONVEX_URL'];
		const adminKey = process.env['CONVEX_ADMIN_KEY'];
		if (!url) {
			throw new Error('CONVEX_URL environment variable is required');
		}
		// The worker polls `getNextQueued` (an internalQuery) and drives the
		// `internalMutation`s below. Internal functions are not reachable from an
		// anonymous HTTP client, so — exactly like apps/imap and apps/mail-sync —
		// the worker authenticates with the deployment admin key.
		if (!adminKey) {
			throw new Error('CONVEX_ADMIN_KEY environment variable is required');
		}
		client = new ConvexHttpClient(url);
		// `setAdminAuth` is a real runtime method on ConvexHttpClient but is omitted
		// from the published public type — cast to reach it (apps/imap/mail-sync do the same).
		(client as unknown as { setAdminAuth(key: string): void }).setAdminAuth(adminKey);
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
	createdAt: number;
	updatedAt: number;
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
	markFailed: makeFunctionReference<'mutation', { taskId: string; errorMessage: string }, null>(
		'codeWorkTasks:markFailed'
	),
	completeWithPR: makeFunctionReference<
		'mutation',
		{ taskId: string; prUrl: string; testResults: string },
		null
	>('codeWorkTasks:completeWithPR'),
};

/**
 * A claimed Tier-3 plugin job, as returned by `plugins/workerTasks:claim`. The
 * worker gets only what it needs to run the job — never the org id, secrets, or
 * host bookkeeping. `payload` is untrusted plugin input; `jobKind` routes to a
 * host-controlled command.
 */
export interface PluginTask {
	_id: string;
	pluginId: string;
	jobKind: string;
	payload: string;
	timeoutMs: number;
	attempts: number;
	maxAttempts: number;
}

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
	reclaimStale: makeFunctionReference<'mutation', Record<string, never>, { reclaimed: number }>(
		'plugins/workerTasks:reclaimStale'
	),
};
