/**
 * Register the system sender's domain as a sending domain (migration 0075).
 *
 *   npx convex run migrations/0075_register_system_sender_domain:run
 *
 * The admin seed runs {@link ensure} for a new install (`auth/seedAdminCommit.ts`).
 * An install seeded before it did sends its account mail unsigned unless an operator added the system
 * sender's domain by hand: the MTA signs only registered domains. One
 * transaction adds the domain through the domain lifecycle
 * (`domains/systemSenderDomain.ts`), or finds it already there, and completes.
 *
 * The cron starts it only once there is something to register: a system
 * sender is configured and the built-in MTA sends, so an install that
 * configures `DEFAULT_FROM_*` after the update still gets its domain. `run`
 * (the Settings runner, which waits for every migration it starts to
 * complete) completes either way; started before that, it registers nothing,
 * and `owlat doctor` names the domain to add. Once completed it never runs
 * again, so a domain the operator removes stays removed.
 */

import { internalMutation } from '../lib/writeFence';
import { logInfo } from '../lib/runtimeLog';
import { beginMigrationRun, readMigrationRun, recordMigrationPage } from '../lib/migrationLedger';
import {
	registerSystemSenderDomain,
	systemSenderDomainBlocker,
} from '../domains/systemSenderDomain';
import type { MutationCtx } from '../_generated/server';

export const MIGRATION = '0075_register_system_sender_domain';
/** The release this migration ships in, recorded on its ledger row. */
const INTRODUCED_IN = '0.6.22';

interface RunResult {
	started: boolean;
	reason?: string;
}

const WAITING_FOR = {
	not_configured: 'No system sender is configured (DEFAULT_FROM_*)',
	not_built_in_mta: 'System mail is not sent through the built-in MTA',
} as const;

async function registerOnce(ctx: MutationCtx): Promise<RunResult> {
	const run = await beginMigrationRun(ctx, { migration: MIGRATION, introducedIn: INTRODUCED_IN });
	if (!run) return { started: false, reason: 'Already completed' };
	const outcome = await registerSystemSenderDomain(ctx);
	await recordMigrationPage(ctx, run, {
		cursor: 'done',
		isDone: true,
		scanned: 1,
		changed: outcome === 'registered' ? 1 : 0,
	});
	logInfo('migration.0075_register_system_sender_domain.completed', { outcome });
	return { started: true };
}

/** The runner's and the CLI's entry point. */
export const run = internalMutation({
	args: {},
	handler: (ctx): Promise<RunResult> => registerOnce(ctx),
});

/**
 * The cron's entry point: once completed, one indexed read; otherwise
 * {@link run}, but only once there is a sender and an MTA to register with.
 */
export const ensure = internalMutation({
	args: {},
	handler: async (ctx): Promise<RunResult> => {
		const existing = await readMigrationRun(ctx, MIGRATION);
		if (existing?.status === 'completed') return { started: false };
		const blocker = systemSenderDomainBlocker();
		if (blocker) return { started: false, reason: WAITING_FOR[blocker] };
		return await registerOnce(ctx);
	},
});
