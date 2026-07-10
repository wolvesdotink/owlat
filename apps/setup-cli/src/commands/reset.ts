/**
 * `owlat-setup reset` — wipe the instance back to a blank slate so the signup
 * flow at `/auth/register` can be exercised end-to-end without
 * `docker compose down -v`.
 *
 * Calls `POST /dev/reset`. Confirms destructively unless --assume-yes.
 */

import { intro, outro, confirm, isCancel, log, spinner } from '@clack/prompts';
import pc from 'picocolors';
import { loadBackendContext, postJson } from '../lib/backend';

import type { CliOptions as RunOptions } from '../lib/cliOptions';

interface ResetResponse {
	deleted?: Record<string, number>;
	error?: string;
}

export async function runReset(opts: RunOptions): Promise<number> {
	intro(pc.bgRed(pc.white(' Reset Instance ')));

	if (!opts.assumeYes) {
		log.warn('This will delete ALL users, the organization, and every seeded row.');
		log.warn('Use this to exercise the signup flow from scratch — never on a real instance.');
		const proceed = await confirm({ message: 'Continue?', initialValue: false });
		if (isCancel(proceed) || !proceed) {
			outro(pc.yellow('Reset cancelled.'));
			return 0;
		}
	}

	const ctx = await loadBackendContext(opts.owlatDir);

	const s = spinner();
	s.start(`POST ${ctx.baseUrl}/dev/reset`);
	let response;
	try {
		response = await postJson<ResetResponse>(ctx, { path: '/dev/reset' });
	} catch (e) {
		s.stop(pc.red(`Failed: ${(e as Error).message}`));
		log.error('Is the docker stack up? Try `docker compose up -d` first.');
		return 1;
	}

	if (response.status !== 200) {
		s.stop(pc.red(`Failed: ${response.body?.error ?? `HTTP ${response.status}`}`));
		return 1;
	}

	s.stop(pc.green('Instance reset to blank slate'));
	const deleted = response.body.deleted ?? {};
	log.info(`Deleted: ${formatCounts(deleted)}`);
	outro(`${pc.green('Done.')} Visit ${pc.cyan('http://localhost:3000')} — it will redirect to /auth/register.`);
	return 0;
}

function formatCounts(counts: Record<string, number>): string {
	return Object.entries(counts)
		.filter(([, n]) => n > 0)
		.map(([k, n]) => `${pc.cyan(String(n))} ${k}`)
		.join(', ') || pc.dim('nothing (instance was already blank)');
}
