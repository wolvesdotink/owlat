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
	type SeedProbeSweepResult,
	type SeedProbeWorkItem,
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
		listWork: async (now) =>
			(await convex.query(fn.listSeedProbeWork as never, { now } as never)) as SeedProbeWorkItem[],
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

/** Start the periodic sweep. Returns a stop function. */
export function startSeedProbeSweeper(convex: ConvexClient): () => void {
	const deps = buildSeedProbeDeps(convex);
	let running = false;
	const tick = async (): Promise<void> => {
		if (running) return;
		running = true;
		try {
			const result: SeedProbeSweepResult = await runSeedProbeSweep(deps);
			if (result.accounts > 0) logger.info(result, 'seed probe sweep');
		} catch (err) {
			logger.warn({ err }, 'seed probe sweep failed');
		} finally {
			running = false;
		}
	};
	const timer = setInterval(() => void tick(), SEED_SWEEP_INTERVAL_MS);
	timer.unref();
	return () => clearInterval(timer);
}
