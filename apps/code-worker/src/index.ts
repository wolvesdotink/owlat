import { getConvexClient, fn, pluginFn } from './convexClient.js';
import { processTask, pruneStaleWorkspaces } from './taskRunner.js';
import { pollForPluginTask } from './pluginTaskRunner.js';

const POLL_INTERVAL_MS = Number(process.env['POLL_INTERVAL_MS'] ?? 10_000);

function log(msg: string) {
	console.info(`[code-worker] ${new Date().toISOString()} ${msg}`);
}

async function pollForTasks(): Promise<void> {
	const client = getConvexClient();

	try {
		const task = await client.query(fn.getNextQueued, {});

		if (task) {
			log(`Found queued task: ${task._id} — "${task.description.slice(0, 80)}"`);
			await processTask(task);
		}
	} catch (error) {
		const errMsg = error instanceof Error ? error.message : String(error);
		log(`Poll error: ${errMsg}`);
	}
}

/** Drain the generalized Tier-3 plugin-task queue (same sandbox, same worker). */
async function pollForPluginTasks(): Promise<void> {
	try {
		await pollForPluginTask();
	} catch (error) {
		const errMsg = error instanceof Error ? error.message : String(error);
		log(`Plugin task poll error: ${errMsg}`);
	}
}

async function main(): Promise<void> {
	log('Starting code-worker');
	log(`Poll interval: ${POLL_INTERVAL_MS}ms`);
	log(`Convex URL: ${process.env['CONVEX_URL'] ?? '(not set)'}`);
	log(`OpenCode binary: ${process.env['OPENCODE_BIN'] ?? 'opencode (default)'}`);

	// Verify connectivity — constructing the client throws if misconfigured.
	try {
		getConvexClient();
		log('Connected to Convex');
	} catch (error) {
		log(`Failed to initialize Convex client: ${error}`);
		process.exit(1);
	}

	// Reclaim any task workspaces left behind by a previous run (crash, restart)
	// so per-task clones do not accumulate on the workspace volume forever.
	try {
		pruneStaleWorkspaces();
		log('Pruned stale task workspaces');
	} catch (error) {
		log(`Failed to prune stale workspaces: ${error}`);
	}

	// Reclaim plugin jobs a previous run left `running` (crashed mid-job) so they
	// are requeued or failed instead of stranded — the queue-side lease recovery.
	try {
		const { reclaimed } = await getConvexClient().mutation(pluginFn.reclaimStale, {});
		log(`Reclaimed ${reclaimed} stale plugin job(s)`);
	} catch (error) {
		log(`Failed to reclaim stale plugin jobs: ${error}`);
	}

	// Poll loop — one worker drains BOTH queues (code-work tasks and the
	// generalized Tier-3 plugin-task queue) through the shared sandbox seam.
	while (true) {
		await pollForTasks();
		await pollForPluginTasks();
		await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
	}
}

main().catch((error) => {
	log(`Fatal error: ${error}`);
	process.exit(1);
});
