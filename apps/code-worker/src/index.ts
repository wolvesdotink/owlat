import { getConvexClient, fn, pluginFn } from './convexClient.js';
import { pruneStaleWorkspaces } from './taskRunner.js';
import { createCodeTaskPoller } from './taskProcess.js';
import { pollForPluginTask } from './pluginTaskRunner.js';
import { log } from './log.js';
import type { WorkerTimers } from './env.js';
import { configuredOpencodeBin, convexUrl, loadWorkerTimers } from './config.js';
import { startHeartbeat } from './heartbeat.js';
import { startWireReports } from './wireReport.js';
import { createPollLoop } from './pollLoop.js';

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

// A signal stops the poll loop between steps (see pollLoop.ts); the task in
// progress finishes first.
const pollLoop = createPollLoop();

function requestStop(signal: NodeJS.Signals): void {
	if (!pollLoop.requestStop()) return;
	log(`${signal} received — finishing the current poll iteration, then exiting`);
}

process.on('SIGTERM', () => requestStop('SIGTERM'));
process.on('SIGINT', () => requestStop('SIGINT'));

async function pollForTasks(pollCodeTasks: () => Promise<void>): Promise<void> {
	try {
		await pollCodeTasks();
	} catch (error) {
		const errMsg = error instanceof Error ? error.message : String(error);
		log(`Poll error: ${errMsg}`);
	}
}

/** Drain the generalized Tier-3 plugin-task queue (same sandbox, same worker). */
async function pollForPluginTasks(heartbeatIntervalMs: number): Promise<void> {
	try {
		await pollForPluginTask({ heartbeatIntervalMs });
	} catch (error) {
		const errMsg = error instanceof Error ? error.message : String(error);
		log(`Plugin task poll error: ${errMsg}`);
	}
}

async function main(): Promise<void> {
	log('Starting code-worker');

	// A malformed timer value would otherwise become a 1 ms delay: stop here with
	// the variable's name instead of polling Convex in a tight loop.
	let timers: WorkerTimers;
	try {
		timers = loadWorkerTimers();
	} catch (error) {
		log(`Invalid configuration: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
	log(`Poll interval: ${timers.pollIntervalMs}ms`);
	log(`Plugin job heartbeat: ${timers.pluginJobHeartbeatMs}ms`);
	log(`Convex URL: ${convexUrl() ?? '(not set)'}`);
	log(`OpenCode binary: ${configuredOpencodeBin() ?? 'opencode (default)'}`);

	// Verify connectivity — constructing the client throws if misconfigured.
	try {
		getConvexClient();
		log('Connected to Convex');
	} catch (error) {
		log(`Failed to initialize Convex client: ${error}`);
		process.exit(1);
	}

	// Report this worker's release and wire version, now and every 5 minutes, so
	// the backend can show version skew and hold contract steps until it moves.
	const wireReports = startWireReports();

	// Reads the repository settings; a malformed credential URL fails here, before
	// the worker touches the queue.
	const pollCodeTasks = createCodeTaskPoller();

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

	// Healthy from here on: startup (config, Convex client, reclaims) is done.
	// Started only now so a startup that hangs reads as unhealthy once the
	// healthcheck's start period is over.
	startHeartbeat({ log });

	// Poll loop — one worker drains BOTH queues (code-work tasks and the
	// generalized Tier-3 plugin-task queue) through the shared sandbox seam.
	// The code-task poller also repeats the code-task reclaim above, between
	// tasks, after a run whose final report never reached the backend.
	await pollLoop.run(
		{
			pollCodeTasks: () => pollForTasks(pollCodeTasks),
			pollPluginTasks: () => pollForPluginTasks(timers.pluginJobHeartbeatMs),
		},
		timers.pollIntervalMs
	);

	// Exit explicitly: the Convex client keeps its websocket open, so returning
	// from main() alone would leave the process alive past the signal.
	log('Poll loop stopped — exiting');
	wireReports.stop();
	process.exit(0);
}

main().catch((error) => {
	log(`Fatal error: ${error}`);
	process.exit(1);
});
