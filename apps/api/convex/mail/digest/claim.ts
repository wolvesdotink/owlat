/**
 * Read on arrival (SPEC §6.5): the digest's claim and commit.
 *
 * CLAIM. One `mailDigests` row per (mailbox, periodKey). The claim mutation
 * finds it: `generated` is reused, `sent` is done, `claimed` under a live
 * lease is busy. Otherwise it (re)claims the row with a fresh token and
 * lease, snapshots the selection (`select.ts`: visited threads with their
 * boundaries, the per-kind overflow) and increments `generationAttempts`
 * BEFORE the paid call, capped at 2. So a period pays for at most 2
 * generations, and a crash between paying and persisting costs at most one
 * extra call; past 2 the digest falls back to subjects without a call.
 *
 * COMMIT goes through `commitGeneratedDigest` (`arrival/digestState.ts`), the
 * ONLY writer of `generated` and of `items`. Before it, every line is checked
 * again: a fenced thread, a purged message or a mailbox no longer personal
 * drops the line. Span quotes are sealed at write.
 */

import { v } from 'convex/values';
import type { Doc, Id } from '../../_generated/dataModel';
import type { QueryCtx } from '../../_generated/server';
import { internalMutation } from '../../lib/writeFence';
import { sealBodyAtWrite } from '../../lib/messageBody';
import { isPersonalMailbox } from '../permissions';
import { isFencedThread } from '../interpret/staleFence';
import { ARRIVAL_RETENTION_MS } from '../arrival/changeRows';
import { commitGeneratedDigest, retireGeneratedDigests } from '../arrival/digestState';
import { digestItemValidator } from '../../lib/validators/arrival';
import { readDigestCandidates, selectDigest } from './select';

/** Paid generations one period may make (§6.5). */
export const MAX_DIGEST_ATTEMPTS = 2;

/** How long a claim holds the row against an overlapping tick. */
export const DIGEST_CLAIM_LEASE_MS = 5 * 60_000;

type Item = Doc<'mailDigests'>['items'][number];

export type DigestClaim =
	| { kind: 'empty' | 'sent' | 'busy' }
	| { kind: 'ready'; digestId: Id<'mailDigests'>; claimToken: string }
	| {
			kind: 'claimed';
			digestId: Id<'mailDigests'>;
			claimToken: string;
			/** False: past the attempt cap, commit subjects without a model call. */
			isPaid: boolean;
			items: Item[];
	  };

/** Claim the mailbox's digest for a period (see the module doc). */
export const claimDigest = internalMutation({
	args: { mailboxId: v.id('mailboxes'), periodKey: v.string(), now: v.optional(v.number()) },
	handler: async (ctx, args): Promise<DigestClaim> => {
		const now = args.now ?? Date.now();
		const mailbox = await ctx.db.get(args.mailboxId);
		if (!mailbox || !isPersonalMailbox(mailbox)) return { kind: 'empty' };
		const existing = await ctx.db
			.query('mailDigests')
			.withIndex('by_mailbox_period', (q) =>
				q.eq('mailboxId', args.mailboxId).eq('periodKey', args.periodKey)
			)
			.first();
		if (existing?.state === 'generated') {
			return { kind: 'ready', digestId: existing._id, claimToken: existing.claimToken };
		}
		if (existing?.state === 'sent') return { kind: 'sent' };
		if (existing?.state === 'claimed' && existing.claimUntil >= now) return { kind: 'busy' };

		const selection = selectDigest(await readDigestCandidates(ctx, args.mailboxId));
		if (selection.visited.length === 0) return { kind: 'empty' };
		const attempts = existing?.generationAttempts ?? 0;
		const isPaid = attempts < MAX_DIGEST_ATTEMPTS;
		const claimToken = crypto.randomUUID();
		const fields = {
			state: 'claimed' as const,
			claimToken,
			claimUntil: now + DIGEST_CLAIM_LEASE_MS,
			generationAttempts: isPaid ? attempts + 1 : attempts,
			items: [],
			visited: selection.visited,
			overflowByKind: selection.overflowByKind,
			overflowLabel: selection.overflowLabel,
		};
		let digestId: Id<'mailDigests'>;
		if (existing) {
			digestId = existing._id;
			await ctx.db.patch(existing._id, fields);
		} else {
			digestId = await ctx.db.insert('mailDigests', {
				mailboxId: args.mailboxId,
				periodKey: args.periodKey,
				...fields,
				createdAt: now,
				expiresAt: now + ARRIVAL_RETENTION_MS.digest,
			});
		}
		// Only shortens how long another period's digest sits generated.
		await retireGeneratedDigests(ctx, args.mailboxId, args.periodKey);
		return { kind: 'claimed', digestId, claimToken, isPaid, items: selection.items };
	},
});

/** Whether a line may still be shown: thread not fenced, message not purged, same mailbox. */
export async function isLineCurrent(
	ctx: Pick<QueryCtx, 'db'>,
	mailboxId: Id<'mailboxes'>,
	item: Pick<Item, 'threadId' | 'messageId'>
): Promise<boolean> {
	const [thread, message] = await Promise.all([
		ctx.db.get(item.threadId),
		ctx.db.get(item.messageId),
	]);
	return (
		thread !== null &&
		message !== null &&
		thread.mailboxId === mailboxId &&
		message.mailboxId === mailboxId &&
		!isFencedThread(thread)
	);
}

/**
 * Commit a claimed digest's lines (spans in plaintext, sealed here), with
 * every line re-checked. Returns whether the digest is now `generated`.
 */
export const commitDigest = internalMutation({
	args: {
		digestId: v.id('mailDigests'),
		claimToken: v.string(),
		items: v.array(digestItemValidator),
	},
	handler: async (ctx, args): Promise<boolean> => {
		const digest = await ctx.db.get(args.digestId);
		if (!digest) return false;
		const mailbox = await ctx.db.get(digest.mailboxId);
		if (!mailbox || !isPersonalMailbox(mailbox)) return false;
		const items: Item[] = [];
		for (const item of args.items) {
			if (!(await isLineCurrent(ctx, digest.mailboxId, item))) continue;
			items.push({
				threadId: item.threadId,
				messageId: item.messageId,
				kind: item.kind,
				...(item.spans?.length
					? {
							spans: await Promise.all(
								item.spans.map(async (span) => ({ quote: await sealBodyAtWrite(span.quote) }))
							),
						}
					: {}),
			});
		}
		const committed = await commitGeneratedDigest(ctx, {
			digestId: args.digestId,
			claimToken: args.claimToken,
			items,
			now: Date.now(),
		});
		return committed.ok;
	},
});
