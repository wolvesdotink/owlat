/**
 * Suppression carry-over — the write half of a migration import (plan D9).
 *
 * A team arriving from Mailchimp/Mandrill brings years of accumulated recipient
 * truth with them: people who unsubscribed, addresses that hard-bounced, people
 * who hit "report spam". None of it is visible to Owlat on day one, so the very
 * first campaign sent from the new platform would re-mail every one of them —
 * a compliance failure and a reputation failure in the same send, and the exact
 * outcome the measured ramp exists to avoid.
 *
 * This module is where an adapter's `FetchPageResult.suppressions` become state.
 * It owns NO policy: which provider reason means what is decided in the
 * adapter (`providers/mandrill/index.ts` reuses the webhook's reject table,
 * `providers/mailchimp/index.ts` maps member status), and the actual writes are
 * delegated, unconditionally, to the two mutations that already own them:
 *
 *  - `blockedEmails.addFromEvent` — THE suppression writer. Per-address
 *    idempotent, mirrors to the MTA's Redis backstop, and emits the
 *    `blocklist.provider_suppressed` provenance entry that makes the address
 *    read as "carried over from Mandrill" on the suppression screen. A second
 *    writer here would mean a second set of those three behaviors to keep in
 *    sync, so there isn't one.
 *  - `delivery.unsubscribeQueries.processUnsubscribeByEmail` — the consent path,
 *    for the departures. Same entry point a relay's `unsub` webhook uses.
 *
 * IMPORTS ARE PERMANENT. `blockedEmails` has no expiry column, so a carried-over
 * suppression never lapses on its own. That is the conservative direction and it
 * is deliberate: Mandrill's blacklist entries DO expire (`expires_at`), and
 * honoring that here would mean quietly resuming mail to an address a provider
 * stopped mailing — the one mistake this import exists to prevent. An operator
 * who disagrees about a specific address removes it from the blocklist screen,
 * on the record. (The Mandrill adapter also asks for non-expired entries only,
 * so an ALREADY-expired entry is never carried over in the first place.)
 */

import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import { findBlockedByEmail } from '../blockedEmails';
import { isValidEmail, normalizeEmail } from '../lib/inputGuards';
import { recordAuditLog } from '../lib/auditLog';
import {
	suppressionChangeCount,
	ZERO_SUPPRESSION_COUNTS,
	type SuppressionImportCounts,
} from './_common';

// ─── Apply one page ─────────────────────────────────────────────────────────

export const suppressionEntryValidator = v.object({
	email: v.string(),
	reason: v.union(
		v.literal('bounced'),
		v.literal('complained'),
		v.literal('manual'),
		v.literal('unsubscribe')
	),
	bounceType: v.optional(v.union(v.literal('hard'), v.literal('soft'))),
	evidence: v.string(),
});

/**
 * Route one page's worth of carried-over addresses and report what happened.
 *
 * One mutation per page rather than one per address: the walker is an action, so
 * a per-address round trip would be a hundred transactions where the page
 * already is the batch. Bounded by the adapter's page size (100), which is what
 * keeps the transaction inside the house read/write limits.
 *
 * The blocklist pre-read exists ONLY to tell "new" from "already there" for the
 * summary. It never short-circuits the write: `addFromEvent` is called for every
 * mappable address, so the decision of what a repeat means stays in the writer
 * that owns it (it early-returns, writing no row, no mirror and no audit entry)
 * rather than being re-derived — differently, eventually — here.
 */
export const applySuppressionBatch = internalMutation({
	args: {
		/** Provenance `provider` on every audit entry this batch produces. */
		provider: v.string(),
		entries: v.array(suppressionEntryValidator),
		/** Entries the adapter already decided not to map. Passed through. */
		skipped: v.number(),
	},
	handler: async (ctx, args): Promise<SuppressionImportCounts> => {
		const counts: SuppressionImportCounts = { ...ZERO_SUPPRESSION_COUNTS, skipped: args.skipped };

		for (const entry of args.entries) {
			const email = normalizeEmail(entry.email);
			// Provider data is untrusted: a malformed address would become an
			// unremovable-looking blocklist row that never matches a real send.
			if (!isValidEmail(email)) {
				counts.skipped++;
				continue;
			}

			if (entry.reason === 'unsubscribe') {
				// Read the opt-out stamp BEFORE the write, for the same reason as the
				// blocklist pre-read below — and because the consent mutation's return
				// value cannot answer this question. A global opt-out stamps
				// `contacts.unsubscribedAt` even when the contact belongs to no topic
				// (a segment campaign can still reach them), but reports
				// `alreadyUnsubscribed` because no MEMBERSHIP was removed. Counting
				// off that would report "nothing changed" for a run that just opted a
				// thousand people out.
				//
				// The lookup mirrors `processUnsubscribeByEmail`'s own join exactly,
				// deliberately: a stricter one here would count a different set of
				// addresses than the one the writer acts on.
				const contact = await ctx.db
					.query('contacts')
					.withIndex('by_email', (q) => q.eq('email', email))
					.first();
				const wasOptedOut = contact?.unsubscribedAt !== undefined;

				const result = await ctx.runMutation(
					internal.delivery.unsubscribeQueries.processUnsubscribeByEmail,
					{ email }
				);
				if (!result.success) counts.noContact++;
				else if (wasOptedOut && result.alreadyUnsubscribed) counts.alreadyUnsubscribed++;
				else counts.unsubscribed++;
				continue;
			}

			const existing = await findBlockedByEmail(ctx, email);
			if (existing) counts.alreadyBlocked++;
			else if (entry.reason === 'bounced') {
				if (entry.bounceType === 'soft') counts.bouncedSoft++;
				else counts.bouncedHard++;
			} else if (entry.reason === 'complained') counts.complained++;
			else counts.manual++;

			await ctx.runMutation(internal.blockedEmails.addFromEvent, {
				email,
				reason: entry.reason,
				...(entry.reason === 'bounced'
					? { bounceType: entry.bounceType ?? ('hard' as const) }
					: {}),
				provenance: {
					provider: args.provider,
					source: 'import' as const,
					evidence: entry.evidence,
				},
			});
		}

		return counts;
	},
});

// ─── Run summary ────────────────────────────────────────────────────────────

/**
 * ONE aggregated audit row per import run that carried something over.
 *
 * The per-address `blocklist.provider_suppressed` entries answer "why is this
 * address suppressed"; only this one answers the question nobody can ask a
 * per-address row — "did an import just stop us mailing four thousand people,
 * and on whose authority". Same shape and same reasoning as
 * `contact.sunset_sweep_summary`, including its write gate: a run that changed
 * NOTHING writes nothing, so re-running a completed carry-over — the operation
 * this whole feature promises is safe to repeat — leaves the audit log byte for
 * byte as it was.
 */
export async function recordImportSummary(
	ctx: MutationCtx,
	record: Doc<'integrationImports'>
): Promise<void> {
	const counts = record.suppressionCounts;
	if (!counts) return;
	const changed = suppressionChangeCount(counts);
	if (changed === 0) return;

	const blocked = counts.bouncedHard + counts.bouncedSoft + counts.complained + counts.manual;

	await recordAuditLog(ctx, {
		// The synthetic actor shape the per-address writer uses, so the two halves
		// of one carry-over read as the same actor in the audit view.
		userId: `system:${record.provider}_import`,
		action: 'blocklist.provider_import_summary',
		resource: 'blocklist',
		resourceId: record._id,
		details: {
			provider: record.provider,
			source: 'import',
			...counts,
			message:
				`Suppression carry-over from ${record.provider}: ${blocked} address(es) added to ` +
				`the blocklist and ${counts.unsubscribed} contact(s) unsubscribed. ` +
				`${counts.alreadyBlocked + counts.alreadyUnsubscribed} were already suppressed here, ` +
				`${counts.noContact} unsubscribe(s) matched no contact, and ${counts.skipped} entry ` +
				`(or entries) carried no recipient signal. Carried-over suppressions do not expire; ` +
				`remove an address from the blocklist screen to resume mailing it.`,
		},
	});
}
