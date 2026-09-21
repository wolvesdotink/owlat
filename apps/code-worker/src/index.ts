import { getConvexClient, fn, pluginFn } from './convexClient.js';
import { processTask, pruneStaleWorkspaces } from './taskRunner.js';
import { pollForPluginTask } from './pluginTaskRunner.js';
import { log } from './log.js';

const POLL_INTERVAL_MS = Number(process.env['POLL_INTERVAL_MS'] ?? 10_000);

// Route both crash channels through the worker's own log stream. Node ≥15 ends
// the process on either one already, so what changes is that the event explaining
// the restart appears in the same log the rest of the run wrote, instead of as a
// raw stderr trace beside it. Ending is still the right outcome: the queue-side
// reclaim at the next boot is what repairs a worker's in-flight task state.
//
// This block duplicates `@owlat/shared/nodeShutdown` because the worker's image
// compiles a FILTERED workspace install (`bun install --filter @owlat/code-worker
// …`) and ships the tsc output, so taking the dependency on means changing which
// packages that image installs and builds — not just a manifest line.
process.on('uncaughtException', (err) => {
	log(`Uncaught exception — exiting: ${err instanceof Error ? err.stack : String(err)}`);
	process.exit(1);
});
process.on('unhandledRejection', (reason) => {
	log(`Unhandled rejection — exiting: ${reason instanceof Error ? reason.stack : String(reason)}`);
	process.exit(1);
});

// Signal handling for the poll loop. There is no listener to close: the worker
// pulls work, so "stop accepting" means "do not start another iteration". A
// task already running keeps running — cutting it in half would strand its
// branch and its Convex row, and the row is reclaimed at the next boot anyway.
// Docker's grace period therefore still bounds a long task, but the common case
// (a signal during the idle sleep, which is where the worker spends nearly all
// of its time) now exits cleanly and immediately.
let stopping = false;
let interruptSleep: (() => void) | undefined;

function requestStop(signal: NodeJS.Signals): void {
	if (stopping) return;
	stopping = true;
	log(`${signal} received — finishing the current poll iteration, then exiting`);
	interruptSleep?.();
}

process.on('SIGTERM', () => requestStop('SIGTERM'));
process.on('SIGINT', () => requestStop('SIGINT'));

/** Idle between polls, cut short by a shutdown signal. */
function sleepUntilNextPoll(): Promise<void> {
	return new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, POLL_INTERVAL_MS);
		interruptSleep = () => {
			clearTimeout(timer);
			resolve();
		};
	}).finally(() => {
		interruptSleep = undefined;
	});
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

	// Reclaim code tasks a previous run left mid-flight (`running`/`testing`).
	// One worker drains this queue one task at a time, so a freshly started
	// process owns none of them: every such row belongs to the crashed
	// predecessor and is requeued behind its retry backoff (or failed once the
	// attempt ceiling is spent) instead of sitting in-flight forever.
	try {
		const { reclaimed } = await getConvexClient().mutation(fn.reclaimStale, {});
		log(`Reclaimed ${reclaimed} stale code task(s)`);
	} catch (error) {
		log(`Failed to reclaim stale code tasks: ${error}`);
	}

	// Reclaim plugin jobs a previous run left `running` (crashed mid-job) so they
	// are requeued or failed instead of stranded — the queue-side lease recovery.
	//
	// This is a SINGLE-worker deployment (one code-worker drains the queue), so a
	// freshly-started process provably holds no running jobs: every `running` row
	// is the residue of the crashed predecessor, no matter how recent its last
	// heartbeat. We therefore reclaim with `leaseMs: 0` (treat all as abandoned)
	// rather than a lease window — a lease longer than the max job budget would
	// skip a job whose worker crashed and restarted within seconds, stranding it
	// `running` forever. The host still enforces the retry ceiling / never-retry-
	// cancelled rules during reclaim.
	try {
		const { reclaimed } = await getConvexClient().mutation(pluginFn.reclaimStale, { leaseMs: 0 });
		log(`Reclaimed ${reclaimed} stale plugin job(s)`);
	} catch (error) {
		log(`Failed to reclaim stale plugin jobs: ${error}`);
	}

	// Poll loop — one worker drains BOTH queues (code-work tasks and the
	// generalized Tier-3 plugin-task queue) through the shared sandbox seam.
	while (!stopping) {
		await pollForTasks();
		if (stopping) break;
		await pollForPluginTasks();
		if (stopping) break;
		await sleepUntilNextPoll();
	}

	// Exit explicitly: the Convex client keeps its websocket open, so returning
	// from main() alone would leave the process alive past the signal.
	log('Poll loop stopped — exiting');
	process.exit(0);
}

main().catch((error) => {
	log(`Fatal error: ${error}`);
	process.exit(1);
});
