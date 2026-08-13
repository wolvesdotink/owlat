/**
 * `owlat-setup sample-data <install|remove|status>` — opt-in demo content for a
 * REAL install, and the removal that takes it back.
 *
 * Talks to `POST /sample-data/{install,remove,status}` on the local Convex
 * backend, authenticated with the on-box `INSTANCE_SECRET` from `.env` (the
 * same credential `bootstrap-org` uses). Unlike `owlat-setup seed`, which
 * targets the dev-only `/seed/demo` endpoint, this path needs no
 * `OWLAT_DEV_MODE` — a production self-host can explore a populated instance
 * without unlocking the dev endpoints.
 *
 * The dataset is contacts, topics, templates, a sent campaign with stats, an
 * automation, a webhook and a verified `demo.localhost` domain. Every row it
 * writes is tagged, and `remove` deletes exactly those rows — anything the
 * operator created stays.
 */

import { intro, outro, log, confirm, isCancel } from '@clack/prompts';
import { progressSpinner } from '../lib/progress';
import pc from 'picocolors';
import { loadBackendContext, postJson } from '../lib/backend';
import { resolveLocalHost } from '../lib/localHost';

import type { CliOptions as RunOptions } from '../lib/cliOptions';

export type SampleDataAction = 'install' | 'remove' | 'status';

/**
 * Where to reach the backend. Quickstart passes the on-box site URL explicitly
 * for a domain install; a standalone run falls back to the `.env` values —
 * except under Docker Desktop, where `scripts/owlat` runs this container on the
 * bridge and sets OWLAT_LOCAL_HOST, because `localhost` there is the VM, not
 * the host that published port 3211.
 */
function resolveBaseUrl(baseUrlOverride?: string): string | undefined {
	if (baseUrlOverride) return baseUrlOverride;
	return process.env['OWLAT_LOCAL_HOST'] ? `http://${resolveLocalHost()}:3211` : undefined;
}

interface SampleDataResponse {
	inserted?: Record<string, number>;
	skipped?: Record<string, number>;
	deleted?: Record<string, number>;
	present?: Record<string, number>;
	total?: number;
	error?: string;
}

/** The subcommand, or an error string naming what was passed instead. */
export function parseAction(positional: string[]): SampleDataAction | { error: string } {
	const [action] = positional;
	if (action === undefined)
		return { error: 'Usage: owlat-setup sample-data <install|remove|status>' };
	if (action === 'install' || action === 'remove' || action === 'status') return action;
	return { error: `Unknown sample-data action '${action}'. Use install, remove, or status.` };
}

export async function runSampleData(opts: RunOptions, baseUrlOverride?: string): Promise<number> {
	const parsed = parseAction(opts.positional);
	if (typeof parsed !== 'string') {
		log.error(parsed.error);
		return 1;
	}

	if (parsed === 'install') return await installSampleData(opts, baseUrlOverride);
	if (parsed === 'remove') return await removeSampleData(opts, baseUrlOverride);
	return await statusSampleData(opts, baseUrlOverride);
}

export async function installSampleData(
	opts: RunOptions,
	baseUrlOverride?: string
): Promise<number> {
	intro(pc.bgCyan(pc.black(' Install Sample Data ')));

	// Same on-box override as bootstrap: for a domain install the env URLs are
	// PUBLIC and unreachable until DNS/TLS are live — the installer talks to
	// the published localhost port instead.
	const ctx = await loadBackendContext(opts.owlatDir, resolveBaseUrl(baseUrlOverride));

	const response = await call(ctx, '/sample-data/install', 'Installing sample data');
	if (typeof response === 'number') return response;

	log.info(`Inserted: ${formatCounts(response.inserted ?? {})}`);
	if (response.skipped && Object.values(response.skipped).some((n) => n > 0)) {
		log.info(`Skipped (already present): ${formatCounts(response.skipped)}`);
	}
	outro(
		`${pc.green('Done.')} Sign in to browse it, and run ${pc.cyan('owlat sample-data remove')} when you want a clean instance.`
	);
	return 0;
}

async function removeSampleData(opts: RunOptions, baseUrlOverride?: string): Promise<number> {
	intro(pc.bgYellow(pc.black(' Remove Sample Data ')));

	if (!opts.assumeYes) {
		log.info(
			'Only rows created by the sample-data install are deleted. Your own data is untouched.'
		);
		const proceed = await confirm({ message: 'Remove the sample data?', initialValue: true });
		if (isCancel(proceed) || !proceed) {
			outro(pc.yellow('Cancelled.'));
			return 0;
		}
	}

	const ctx = await loadBackendContext(opts.owlatDir, resolveBaseUrl(baseUrlOverride));
	const response = await call(ctx, '/sample-data/remove', 'Removing sample data');
	if (typeof response === 'number') return response;

	const deleted = response.deleted ?? {};
	log.info(`Deleted: ${formatCounts(deleted)}`);
	outro(pc.green('Sample data removed.'));
	return 0;
}

async function statusSampleData(opts: RunOptions, baseUrlOverride?: string): Promise<number> {
	intro(pc.bgCyan(pc.black(' Sample Data Status ')));

	const ctx = await loadBackendContext(opts.owlatDir, resolveBaseUrl(baseUrlOverride));
	const response = await call(ctx, '/sample-data/status', 'Counting sample-data rows');
	if (typeof response === 'number') return response;

	if (!response.total) {
		outro(`No sample data on this instance. ${pc.dim('owlat sample-data install')}`);
		return 0;
	}
	log.info(`Present: ${formatCounts(response.present ?? {})}`);
	outro(`${response.total} sample rows. ${pc.dim('Remove them with: owlat sample-data remove')}`);
	return 0;
}

/** POST one endpoint, reporting failures the same way for all three actions. */
async function call(
	ctx: Awaited<ReturnType<typeof loadBackendContext>>,
	path: string,
	message: string
): Promise<SampleDataResponse | number> {
	const s = progressSpinner();
	s.start(`${message} — POST ${ctx.baseUrl}${path}`);
	let response;
	try {
		response = await postJson<SampleDataResponse>(ctx, { path });
	} catch (e) {
		s.stop(pc.red(`Failed: ${(e as Error).message}`));
		log.error('Is the docker stack up? Try `docker compose up -d` first.');
		return 1;
	}
	if (response.status !== 200) {
		s.stop(pc.red(`Failed: ${response.body?.error ?? `HTTP ${response.status}`}`));
		if (response.status === 404) {
			log.error(
				'The backend has no /sample-data routes — deploy the current functions (`owlat quickstart`) and retry.'
			);
		}
		return 1;
	}
	s.stop(pc.green('Done'));
	return response.body;
}

export function formatCounts(counts: Record<string, number>): string {
	return (
		Object.entries(counts)
			.filter(([, n]) => n > 0)
			.map(([k, n]) => `${pc.cyan(String(n))} ${k}`)
			.join(', ') || pc.dim('none')
	);
}
