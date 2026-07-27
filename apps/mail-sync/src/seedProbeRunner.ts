/**
 * Production wiring for the seed-probe sweep: Convex on one side, the shipped
 * IMAP client on the other. All the decisions live in `seedProbes.ts` (pure,
 * dependency-injected) and in the Convex pure core; this file only supplies
 * the real dependencies and the interval.
 */

import { fn, type ConvexClient, type WorkerCredentials } from './convex.js';
import { openSeedMailbox } from './seedMailbox.js';
import {
	runSeedProbeSweep,
	type SeedProbeDeps,
	type SeedProbeSweepOutcome,
	type SeedProbeWorkPage,
} from './seedProbes.js';
import { logger } from './logger.js';

/** How often the worker walks the seed mailboxes. */
const SEED_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/** Timeout for the best-effort hygiene click. */
const CLICK_TIMEOUT_MS = 10_000;

function buildSeedProbeDeps(convex: ConvexClient): SeedProbeDeps {
	return {
		now: () => Date.now(),
		random: () => Math.random(),
		listWork: async (now, cursor) =>
			(await convex.query(
				fn.listSeedProbeWork as never,
				{ now, cursor } as never
			)) as SeedProbeWorkPage,
		openMailbox: async (item) => {
			const credentials = (await convex.action(
				fn.getCredentialsForWorker as never,
				{
					accountId: item.accountId,
				} as never
			)) as WorkerCredentials;
			return openSeedMailbox(item, credentials);
		},
		recordClassification: async (input) =>
			(await convex.mutation(fn.recordSeedProbeClassification as never, input as never)) as Awaited<
				ReturnType<SeedProbeDeps['recordClassification']>
			>,
		markRotationReminded: async (input) => {
			await convex.mutation(fn.markSeedRotationReminded as never, input as never);
		},
		click: async (url) => {
			// A seed that never engages trains the provider to distrust us. The
			// target is a link OWLAT put in its own message; failures are ignored.
			await fetch(url, {
				method: 'GET',
				redirect: 'follow',
				signal: AbortSignal.timeout(CLICK_TIMEOUT_MS),
			}).catch(() => undefined);
		},
	};
}

/**
 * Start the periodic sweep. Returns a stop function.
 *
 * The FIRST tick runs immediately rather than one interval later: a worker that
 * restarts (deploy, crash-loop, autoscaler churn) more often than the interval
 * would otherwise never sweep at all, and gate 5 would go quiet without anyone
 * noticing.
 *
 * The sweep is safe to run in EVERY replica. Two replicas racing the same probe
 * both call `recordSeedProbeClassification`, which is the single arbiter: it
 * returns `already_classified` for a row that already carries a placement, so
 * the loser marks nothing read and — the part that would actually be visible to
 * a provider — fires no second hygiene click.
 */
export function startSeedProbeSweeper(convex: ConvexClient): () => void {
	const deps = buildSeedProbeDeps(convex);
	let running = false;
	// Where the next tick resumes. `null` starts the sweep from the top; the
	// cursor is what stops a bounded page from starving the orgs that sort last.
	let cursor: string | null = null;
	const tick = async (): Promise<void> => {
		if (running) return;
		running = true;
		try {
			const result: SeedProbeSweepOutcome = await runSeedProbeSweep(deps, cursor);
			cursor = result.cursor;
			if (result.accounts > 0) logger.info(result, 'seed probe sweep');
		} catch (err) {
			// Start the next tick from the top rather than from a cursor whose page
			// we never finished reasoning about.
			cursor = null;
			logger.warn({ err }, 'seed probe sweep failed');
		} finally {
			running = false;
		}
	};
	void tick();
	const timer = setInterval(() => void tick(), SEED_SWEEP_INTERVAL_MS);
	timer.unref();
	return () => clearInterval(timer);
}
