/**
 * `owlat-setup seed [--reset]` — populate the instance with realistic demo
 * data, or wipe and re-populate.
 *
 * Calls `POST /seed/demo` on the local Convex backend. The endpoint is
 * dev-deployment guarded and protected by `X-Instance-Secret`.
 */

import { intro, outro, log } from '@clack/prompts';
import pc from 'picocolors';
import { loadBackendContext, postWithSpinner } from '../lib/backend';
import { formatCounts } from '../lib/format';

import type { CliOptions as RunOptions } from '../lib/cliOptions';

interface SeedSummary {
	inserted?: Record<string, number>;
	skipped?: Record<string, number>;
	deleted?: Record<string, number>;
}

export async function runSeed(opts: RunOptions, baseUrlOverride?: string): Promise<number> {
	intro(pc.bgCyan(pc.black(' Seed Demo Data ')));

	const reset = opts.args.includes('--reset');
	// Same on-box override as bootstrap: for a domain install the env URLs are
	// PUBLIC and unreachable until DNS/TLS are live — the installer talks to
	// the published localhost port instead.
	const ctx = await loadBackendContext(opts.owlatDir, baseUrlOverride);

	const response = await postWithSpinner<SeedSummary>(
		ctx,
		{ path: '/seed/demo', searchParams: reset ? { reset: 'true' } : undefined },
		{ stopMessage: pc.green('Demo data seeded') }
	);
	if (!response) return 1;

	if (response.body.deleted) {
		log.info(`Deleted: ${formatCounts(response.body.deleted)}`);
	}
	log.info(`Inserted: ${formatCounts(response.body.inserted ?? {})}`);
	if (response.body.skipped && Object.values(response.body.skipped).some((n) => n > 0)) {
		log.info(`Skipped (already present): ${formatCounts(response.body.skipped)}`);
	}

	outro(`${pc.green('Done.')} Sign in at ${ctx.siteUrl} to browse the seeded data.`);
	return 0;
}
