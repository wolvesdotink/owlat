/**
 * Mailbox migration orchestration — "Migrate from Google" and friends.
 *
 * A migration is a one-time historical import of a *connected* external mailbox
 * (see `mail/external/accounts.ts`). The connection itself (IMAP/SMTP creds, the
 * mail-sync worker, forward sync of NEW mail) already exists; this module adds
 * the two extra phases that turn a connection into a migration:
 *
 *   importing — the worker walks each folder's history DOWN from the high-water
 *               mark to UID 1 (forward sync only ever pulls new mail), via the
 *               per-folder backfill cursors on `externalMailFolderSync`.
 *   indexing  — once import is done, `mail/migrationIndexing.ts` sweeps the
 *               imported messages into the contact-scoped knowledge graph.
 *
 * This file owns the IMPORT phase + lifecycle entry points. It hands off to the
 * indexing phase via `completeBackfillImport`. The public surface (start /
 * getStatus / cancel) is the wizard's, and is PERSONAL-only (it resolves the
 * caller's live personal account); the mailbox-keyed team-inbox twins live in
 * `mail/migrationShared.ts` and share this file's scope-agnostic core. The
 * worker-facing internal surface (getBackfillWork / initFolderBackfill /
 * recordBackfillProgress / completeBackfillImport / markImportFailed) lives in
 * `mail/migrationBackfill.ts`, split out under CONVENTIONS.md's ~500-LOC
 * ceiling; it is admin-key-only and scope-agnostic — it keys off the account
 * alone. The knowledge sweep that follows the import is
 * `mail/migrationIndexing.ts`.
 */

import { v } from 'convex/values';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { authedMutation, publicQuery } from '../lib/authedFunctions';
import { getBetterAuthSessionWithRole } from '../lib/sessionOrganization';
import { assertFeatureEnabled, isFeatureEnabled } from '../lib/featureFlags';
import { throwForbidden, throwInvalidInput } from '../_utils/errors';
import { markOnboardingStep } from '../auth/userOnboarding';
import { getLivePersonalExternalAccountForUser } from './external/accounts';
import { isActiveMigrationStatus, cancelActiveMigrationForAccount } from './external/accountShared';

/** Provider label on a migration row — shared with the team-inbox twins. */
export const migrationSourceValidator = v.union(v.literal('google'), v.literal('imap'));

// ============================================================
// Scope-agnostic core — shared by the personal surface below and the
// mailbox-keyed team-inbox twins in `mail/migrationShared.ts`. These are plain
// helpers, NOT Convex functions: each caller owns its own auth gate (the
// personal trio resolves the caller's live personal account; the shared twins
// go through `requireSharedExternalAccount`) and its own onboarding side
// effects (only the personal caller stamps a step).
// ============================================================

/** Newest migration row for an account (1:1 `by_account`), or null. Exported for
 * `mail/migrationBackfill.ts`, which resolves the same row for the worker. */
export async function latestMigrationRow(ctx: QueryCtx, accountId: Id<'externalMailAccounts'>) {
	return await ctx.db
		.query('mailboxMigrations')
		.withIndex('by_account', (q) => q.eq('accountId', accountId))
		.order('desc')
		.first();
}

/**
 * The most recent migration for an account projected into the shape the UI
 * renders, or `null`. Pure read — callers have already authorized the account.
 */
export async function latestMigrationForAccount(
	ctx: QueryCtx,
	accountId: Id<'externalMailAccounts'>
) {
	const migration = await latestMigrationRow(ctx, accountId);
	if (!migration) return null;

	// Past the importing phase the import is, by definition, complete — show
	// 100 rather than a ratio that can fall short when the server returned
	// fewer fetchable bodies than its message count.
	// Deliberately over `messagesImported` alone, NOT over the walk: the bar and
	// the "N of M" beside it must not disagree, and lagging the walk is the
	// honest reading — those messages are not in the mailbox. It still ends at
	// 100 because the branch above pins a finished import there regardless.
	const importPercent =
		migration.status !== 'importing'
			? 100
			: migration.messagesTotal > 0
				? Math.min(100, Math.round((migration.messagesImported / migration.messagesTotal) * 100))
				: 0;
	const indexPercent =
		migration.messagesImported > 0
			? Math.min(100, Math.round((migration.messagesIndexed / migration.messagesImported) * 100))
			: migration.status === 'completed'
				? 100
				: 0;

	return {
		_id: migration._id,
		status: migration.status,
		source: migration.source,
		isAiIndexingEnabled: migration.isAiIndexingEnabled,
		messagesTotal: migration.messagesTotal,
		messagesImported: migration.messagesImported,
		// Rendered by the wizard's completed card: an import that finished having
		// LOST messages must say so, or a partial loss is as silent as the total
		// one used to be.
		messagesFailed: migration.messagesFailed ?? 0,
		messagesIndexed: migration.messagesIndexed,
		importPercent,
		indexPercent,
		startedAt: migration.startedAt,
		importCompletedAt: migration.importCompletedAt,
		completedAt: migration.completedAt,
		lastError: migration.lastError,
	};
}

/**
 * Create (or re-surface) the import job for an already-authorized account:
 * refuse a broken connection, reuse an in-flight run, reset the per-folder
 * backfill cursors, insert the row + its audit entry. Onboarding stamping is
 * deliberately NOT here — `scope: 'shared'` imports have no onboarding at all.
 */
export async function startMigrationForAccount(
	ctx: MutationCtx,
	args: {
		account: Doc<'externalMailAccounts'>;
		mailboxId: Id<'mailboxes'>;
		userId: string;
		organizationId: string;
		source: 'google' | 'imap';
		scope: 'personal' | 'shared';
		isAiIndexingEnabled: boolean;
	}
): Promise<{ migrationId: Id<'mailboxMigrations'>; status: Doc<'mailboxMigrations'>['status'] }> {
	const { account } = args;
	// The worker (listConnectableAccounts) deliberately excludes `auth_error`
	// accounts, so a migration started on one would sit at `importing`
	// forever with no connection ever opened. Refuse it and steer the caller
	// back to re-entering credentials first.
	if (account.status === 'auth_error') {
		// Neutral phrasing: the same core serves the personal wizard and the admin
		// team-inbox panel, where the mailbox is the org's and not the reader's.
		throwInvalidInput(
			"This mailbox's connection isn't working. Re-enter its credentials, then try again."
		);
	}

	// Idempotent: reuse an in-flight migration rather than spawning a second.
	const existing = await latestMigrationRow(ctx, account._id);
	if (existing && isActiveMigrationStatus(existing.status)) {
		return { migrationId: existing._id, status: existing.status };
	}

	const syncRows = await ctx.db
		.query('externalMailFolderSync')
		.withIndex('by_account', (q) => q.eq('accountId', account._id))
		.collect(); // bounded: per-account folder cursors (≤ a handful)

	// A FAILED run leaves real, resumable progress behind: the worker persists a
	// descending cursor after every batch, so a walk that died 60% through a
	// folder can pick up exactly where it stopped. Wiping that made the wizard's
	// 'Try again' re-fetch the whole history — which, against a provider that
	// failed the first run by rate-limiting the account, spends the same quota on
	// the same already-imported mail and hits the same wall at the same point.
	// An import that cannot get past its provider's daily budget in one sitting
	// can never finish that way.
	//
	// Resume only when the cursors still hold unfinished work. A run that failed
	// having walked everything (`completeBackfillImport` refuses a walk that
	// stored nothing) leaves every cursor at 0, and resuming that would re-fail
	// instantly without fetching a single message — so it re-walks, as before.
	const previous = existing;
	const hasUnfinishedWalk = syncRows.some((r) => (r.backfillCursor ?? 0) > 0);
	const isResume = previous?.status === 'failed' && hasUnfinishedWalk;

	if (!isResume) {
		// Reset per-folder backfill cursors so the worker re-walks the full
		// history (a completed run leaves them at 0). Forward-sync's `lastSeenUid`
		// is untouched — new mail keeps flowing.
		for (const r of syncRows) {
			await ctx.db.patch(r._id, {
				backfillCursor: undefined,
				backfillTotal: undefined,
				backfillDone: undefined,
			});
		}
	}

	// Carry the resumed walk's counters onto the new row. `initFolderBackfill`
	// returns an already-initialised folder's cursor WITHOUT re-adding its total,
	// so a resumed migration that started at zero would render a full bar over a
	// `messagesTotal` of 0 and then count backwards. Folders the failed run never
	// reached have no `backfillTotal` yet and still add theirs on first sight.
	const carried = isResume
		? {
				messagesTotal: syncRows.reduce((sum, r) => sum + (r.backfillTotal ?? 0), 0),
				messagesImported: previous?.messagesImported ?? 0,
				messagesFailed: previous?.messagesFailed ?? 0,
			}
		: { messagesTotal: 0, messagesImported: 0, messagesFailed: 0 };

	const now = Date.now();
	const migrationId = await ctx.db.insert('mailboxMigrations', {
		userId: args.userId,
		organizationId: args.organizationId,
		accountId: account._id,
		mailboxId: args.mailboxId,
		scope: args.scope,
		source: args.source,
		status: 'importing',
		isAiIndexingEnabled: args.isAiIndexingEnabled,
		messagesTotal: carried.messagesTotal,
		messagesImported: carried.messagesImported,
		messagesFailed: carried.messagesFailed,
		messagesIndexed: 0,
		startedAt: now,
		updatedAt: now,
	});
	await ctx.db.insert('mailAuditLog', {
		mailboxId: args.mailboxId,
		event: 'migration.started',
		details: `scope=${args.scope} source=${args.source} ai=${args.isAiIndexingEnabled} resumed=${isResume}`,
		occurredAt: now,
	});
	return { migrationId, status: 'importing' as const };
}

/**
 * Cancel the account's in-flight migration, if any, and audit it. Returns
 * whether anything was cancelled. Already-imported mail + extracted knowledge
 * are kept. Teardown paths (disconnect / purge) use the quiet
 * `cancelActiveMigrationForAccount` instead — same state change, no audit line
 * on a mailbox that is being hidden or deleted in the same transaction.
 */
export async function cancelMigrationForAccount(
	ctx: MutationCtx,
	account: Doc<'externalMailAccounts'>
): Promise<boolean> {
	if (!(await cancelActiveMigrationForAccount(ctx, account._id))) return false;
	await ctx.db.insert('mailAuditLog', {
		mailboxId: account.mailboxId,
		event: 'migration.cancelled',
		occurredAt: Date.now(),
	});
	return true;
}

// ============================================================
// Public surface (the migration wizard)
// ============================================================

/**
 * Most recent migration for the caller's connected mailbox, with derived
 * progress for the wizard, or `null`. Soft-auth (org members only).
 */
// public: soft-auth — returns null for anonymous/non-members; scoped to the caller's own account
// authz: self-scoped — reads only the session user's own account migration.
export const getStatus = publicQuery({
	args: {},
	handler: async (ctx) => {
		await assertFeatureEnabled(ctx, 'mail.external');
		const s = await getBetterAuthSessionWithRole(ctx);
		if (!s || !s.role) return null;
		// The caller's LIVE PERSONAL account, not their oldest row: a migration is a
		// personal full-history import, so a `scope='shared'` team-inbox account the
		// caller connected must never be resolved here, and a post-move disconnected
		// archive must never mask their live personal account.
		const account = await getLivePersonalExternalAccountForUser(ctx, s.userId);
		if (!account) return null;
		return await latestMigrationForAccount(ctx, account._id);
	},
});

/**
 * Begin migrating the caller's connected external mailbox. Idempotent: if a
 * migration is already in flight it's returned as-is. Otherwise a fresh job is
 * created and each discovered folder's backfill cursor is reset so the worker
 * re-imports the full history from the high-water mark on its next pass. AI
 * indexing is enabled only when the `ai.knowledge` feature is on.
 */
// authz: self — operates only on the caller's own connected external mailbox (by_user on the session userId)
export const start = authedMutation({
	args: { source: v.optional(migrationSourceValidator) },
	handler: async (ctx, args) => {
		await assertFeatureEnabled(ctx, 'mail.external');
		const s = await getBetterAuthSessionWithRole(ctx);
		if (!s || !s.activeOrganizationId || !s.role) throwForbidden('Not authenticated');

		// The caller's LIVE PERSONAL account only — a migration must never target a
		// shared team inbox (org infrastructure) or a post-move disconnected archive.
		const account = await getLivePersonalExternalAccountForUser(ctx, s.userId);
		if (!account) {
			throwInvalidInput('Connect a mailbox before starting a migration.');
		}

		const result = await startMigrationForAccount(ctx, {
			account,
			mailboxId: account.mailboxId,
			userId: s.userId,
			organizationId: s.activeOrganizationId,
			source: args.source ?? 'imap',
			scope: 'personal',
			isAiIndexingEnabled: await isFeatureEnabled(ctx, 'ai.knowledge'),
		});
		// Onboarding is a PERSONAL-setup notion, so it is stamped here rather than
		// in the shared core — the team-inbox twin must never touch the checklist.
		await markOnboardingStep(ctx, s.userId, 'importStarted');
		return result;
	},
});

/**
 * Cancel an in-flight migration. The worker's `getBackfillWork` then reports
 * inactive (import stops) and the indexer's `runIndexChunk` sees a non-indexing
 * status and exits. Already-imported mail + extracted knowledge are kept.
 */
// authz: self — cancels only the caller's own migration (resolved via by_user on the session userId)
export const cancel = authedMutation({
	args: {},
	handler: async (ctx) => {
		await assertFeatureEnabled(ctx, 'mail.external');
		const s = await getBetterAuthSessionWithRole(ctx);
		if (!s || !s.role) throwForbidden('Not authenticated');
		// The caller's LIVE PERSONAL account only — cancelling must never reach a
		// shared team inbox's migration or a post-move disconnected archive.
		const account = await getLivePersonalExternalAccountForUser(ctx, s.userId);
		if (!account) return false;
		return await cancelMigrationForAccount(ctx, account);
	},
});
