/**
 * "To review" and "Apply N suggestions" on the Senders page (SPEC §5).
 *
 * A `keep` sender qualifies when, over the window (about 90 days):
 *   - it is a promotion that was never read → Unsubscribe when it offers
 *     one-click, Auto-archive otherwise; or
 *   - it delivered ≥5 times and less than 10% was read → Digest.
 * A status the person chose (`statusSource: 'user'`) is never suggested
 * against. Computed server-side over a bounded index range of `keep`
 * profiles, newest delivery first.
 *
 * Applying is one `suggestions` operation: every status change is written in
 * the applying mutation; the per-sender archive or re-sort (≤200 messages
 * each) runs in one scheduled mutation per sender that logs into the same
 * operation (`./status.ts settleSuggestedSender`), and one-click senders get
 * their external request, spaced out.
 */

import { v } from 'convex/values';
import type { MailCategory, SenderStatus, SenderStatusSource } from '@owlat/shared/arrival';
import type { Doc, Id } from '../../_generated/dataModel';
import type { QueryCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import { throwForbidden, throwInvalidInput } from '../../_utils/errors';
import { postboxMutation } from '../_helpers';
import { isPersonalMailbox, requireMailboxAccess } from '../permissions';
import { senderWindowTotals, type SenderWindowTotals } from './counters';
import { addOperationChanges, startSenderOperation, writeSenderStatus } from './operations';
import { loadSenderProfile } from './profiles';
import {
	findUnsubscribeTarget,
	hasOneClickTarget,
	ONE_CLICK_SPACING_MS,
	requestExternalUnsubscribe,
} from './unsubscribe';

export const SUGGEST_MIN_DELIVERED = 5;
export const SUGGEST_MAX_READ_RATE = 0.1;

/** `keep` profiles one suggestion pass reads. */
export const SUGGESTION_SCAN = 400;

/** Never-read promotions checked for a one-click target per pass. */
const ONE_CLICK_CHECKS = 50;

/** Senders one apply may change. */
export const APPLY_SUGGESTIONS_MAX = 50;

export type SenderSuggestion = 'digest' | 'auto_archive' | 'unsubscribe';

/** Pure: what a sender should become, or null. */
export function suggestSenderStatus(input: {
	status: SenderStatus;
	statusSource: SenderStatusSource;
	kind?: MailCategory;
	totals: SenderWindowTotals;
	hasOneClick: boolean;
}): SenderSuggestion | null {
	if (input.status !== 'keep' || input.statusSource === 'user') return null;
	const { delivered, opened, readRate } = input.totals;
	if (input.kind === 'promotion' && delivered > 0 && opened === 0) {
		return input.hasOneClick ? 'unsubscribe' : 'auto_archive';
	}
	if (delivered >= SUGGEST_MIN_DELIVERED && readRate < SUGGEST_MAX_READ_RATE) return 'digest';
	return null;
}

/** Whether a sender could become a promotion-unsubscribe suggestion (needs the one-click check). */
function isNeverReadPromotion(profile: Doc<'mailSenderProfiles'>, totals: SenderWindowTotals) {
	return profile.kind === 'promotion' && totals.delivered > 0 && totals.opened === 0;
}

export interface SuggestedSender {
	profile: Doc<'mailSenderProfiles'>;
	totals: SenderWindowTotals;
	suggestion: SenderSuggestion;
}

/** One-click lookups left in a pass (each reads a few of the sender's messages). */
interface OneClickBudget {
	checks: number;
}

/** The suggestion for one profile; the one-click lookup only runs when it decides. */
async function suggestionFor(
	ctx: Pick<QueryCtx, 'db'>,
	profile: Doc<'mailSenderProfiles'>,
	now: number,
	budget: OneClickBudget
): Promise<SuggestedSender | null> {
	const totals = senderWindowTotals(profile, now);
	let hasOneClick = false;
	if (isNeverReadPromotion(profile, totals) && budget.checks > 0) {
		budget.checks -= 1;
		hasOneClick = await hasOneClickTarget(ctx, profile);
	}
	const suggestion = suggestSenderStatus({
		status: profile.status,
		statusSource: profile.statusSource,
		kind: profile.kind,
		totals,
		hasOneClick,
	});
	return suggestion ? { profile, totals, suggestion } : null;
}

/** Every suggestion in the bounded scan, newest delivery first. */
export async function listSenderSuggestions(
	ctx: Pick<QueryCtx, 'db'>,
	mailboxId: Id<'mailboxes'>,
	now: number
): Promise<SuggestedSender[]> {
	const keep = await ctx.db
		.query('mailSenderProfiles')
		.withIndex('by_mailbox_status_last', (q) => q.eq('mailboxId', mailboxId).eq('status', 'keep'))
		.order('desc')
		.take(SUGGESTION_SCAN);
	const budget: OneClickBudget = { checks: ONE_CLICK_CHECKS };
	const out: SuggestedSender[] = [];
	for (const profile of keep) {
		const suggested = await suggestionFor(ctx, profile, now, budget);
		if (suggested) out.push(suggested);
	}
	return out;
}

const STATUS_OF: Record<SenderSuggestion, SenderStatus> = {
	digest: 'digest',
	auto_archive: 'auto_archive',
	unsubscribe: 'unsubscribed',
};

/**
 * Apply the suggestions the person confirmed. Each sender is re-checked
 * server-side; one that no longer qualifies is skipped.
 */
// authz: requireMailboxAccess on the mailbox; personal mailboxes only.
export const applySuggestions = postboxMutation({
	args: { mailboxId: v.id('mailboxes'), senderDigests: v.array(v.string()) },
	handler: async (ctx, args, session) => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId, 'member', session);
		if (!owned.ok) throwForbidden('Mailbox not accessible');
		if (!isPersonalMailbox(owned.mailbox)) throwInvalidInput('Senders are personal mail only');
		const digests = [...new Set(args.senderDigests)].slice(0, APPLY_SUGGESTIONS_MAX);
		const now = Date.now();
		const chosen: SuggestedSender[] = [];
		const budget: OneClickBudget = { checks: APPLY_SUGGESTIONS_MAX };
		for (const digest of digests) {
			const profile = await loadSenderProfile(ctx, args.mailboxId, digest);
			const suggested = profile ? await suggestionFor(ctx, profile, now, budget) : null;
			if (suggested) chosen.push(suggested);
		}
		if (chosen.length === 0) return { operationId: null, applied: 0 };

		const operationId = await startSenderOperation(ctx, {
			mailboxId: args.mailboxId,
			kind: 'suggestions',
			actor: 'user',
			now,
		});
		let oneClickIndex = 0;
		for (const { profile, suggestion } of chosen) {
			const status = STATUS_OF[suggestion];
			await writeSenderStatus(ctx, {
				profile,
				status,
				statusSource: 'suggestion',
				operationId,
				now,
			});
			await ctx.scheduler.runAfter(0, internal.mail.senders.status.settleSuggestedSender, {
				operationId,
				profileId: profile._id,
			});
			if (suggestion !== 'unsubscribe') continue;
			// Bulk runs the external request for one-click senders only.
			const target = await findUnsubscribeTarget(ctx, profile);
			if (target?.method !== 'one_click') continue;
			await requestExternalUnsubscribe(ctx, profile, target, {
				now,
				delayMs: oneClickIndex * ONE_CLICK_SPACING_MS,
			});
			oneClickIndex += 1;
		}
		await addOperationChanges(ctx, operationId, chosen.length);
		return { operationId, applied: chosen.length };
	},
});
