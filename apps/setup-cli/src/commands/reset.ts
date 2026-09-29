/**
 * `owlat-setup reset` — wipe the instance back to a blank slate so the signup
 * flow at `/auth/register` can be exercised end-to-end without
 * `docker compose down -v`.
 *
 * Calls `POST /dev/reset`. Confirms destructively unless --assume-yes.
 */

import { intro, outro, confirm, isCancel, log } from '@clack/prompts';
import pc from 'picocolors';
import { loadBackendContext, postWithSpinner } from '../lib/backend';
import { formatCounts } from '../lib/format';

import type { CliOptions as RunOptions } from '../lib/cliOptions';

interface ResetResponse {
	deleted?: Record<string, number>;
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

	const response = await postWithSpinner<ResetResponse>(
		ctx,
		{ path: '/dev/reset' },
		{ stopMessage: pc.green('Instance reset to blank slate') }
	);
	if (!response) return 1;

	const deleted = response.body.deleted ?? {};
	log.info(`Deleted: ${formatCounts(deleted, 'nothing (instance was already blank)')}`);
	outro(`${pc.green('Done.')} Visit ${pc.cyan(ctx.siteUrl)} — it will redirect to /auth/register.`);
	return 0;
}
