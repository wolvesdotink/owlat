/**
 * `owlat-setup seed [--reset]` — populate the instance with realistic demo
 * data, or wipe and re-populate.
 *
 * Calls `POST /seed/demo` on the local Convex backend. The endpoint is
 * dev-deployment guarded and protected by `X-Instance-Secret`.
 */

import { intro, outro, log } from '@clack/prompts';
import { progressSpinner } from '../lib/progress';
import pc from 'picocolors';
import { loadBackendContext, postJson } from '../lib/backend';

import type { CliOptions as RunOptions } from '../lib/cliOptions';

interface SeedSummary {
	inserted?: Record<string, number>;
	skipped?: Record<string, number>;
	deleted?: Record<string, number>;
	error?: string;
}

export async function runSeed(opts: RunOptions, baseUrlOverride?: string): Promise<number> {
	intro(pc.bgCyan(pc.black(' Seed Demo Data ')));

	const reset = opts.args.includes('--reset');
	// Same on-box override as bootstrap: for a domain install the env URLs are
	// PUBLIC and unreachable until DNS/TLS are live — the installer talks to
	// the published localhost port instead.
	const ctx = await loadBackendContext(opts.owlatDir, baseUrlOverride);

	const s = progressSpinner();
	s.start(`POST ${ctx.baseUrl}/seed/demo${reset ? '?reset=true' : ''}`);
	let response;
	try {
		response = await postJson<SeedSummary>(ctx, {
			path: '/seed/demo',
			searchParams: reset ? { reset: 'true' } : undefined,
		});
	} catch (e) {
		s.stop(pc.red(`Failed: ${(e as Error).message}`));
		log.error('Is the docker stack up? Try `docker compose up -d` first.');
		return 1;
	}

	if (response.status !== 200) {
		s.stop(pc.red(`Failed: ${response.body?.error ?? `HTTP ${response.status}`}`));
		return 1;
	}

	s.stop(pc.green('Demo data seeded'));
	if (response.body.deleted) {
		log.info(`Deleted: ${formatCounts(response.body.deleted)}`);
	}
	log.info(`Inserted: ${formatCounts(response.body.inserted ?? {})}`);
	if (response.body.skipped && Object.values(response.body.skipped).some((n) => n > 0)) {
		log.info(`Skipped (already present): ${formatCounts(response.body.skipped)}`);
	}

	outro(`${pc.green('Done.')} Sign in at http://localhost:3000 to browse the seeded data.`);
	return 0;
}

function formatCounts(counts: Record<string, number>): string {
	return (
		Object.entries(counts)
			.filter(([, n]) => n > 0)
			.map(([k, n]) => `${pc.cyan(String(n))} ${k}`)
			.join(', ') || pc.dim('none')
	);
}
