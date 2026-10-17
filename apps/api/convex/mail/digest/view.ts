/**
 * Read on arrival (SPEC §6.5): the digest section of the Daily Brief email,
 * and what sending it does.
 *
 * {@link digestForEmail} reads the one generated digest under its claim and
 * groups its lines Newsletters / Updates / Promotions, each with "and N more"
 * from `overflowByKind`. A line whose thread is now fenced or whose message
 * was purged is dropped here, at delivery, as it was at commit.
 *
 * {@link consumeSentDigest} runs in the SAME mutation that inserts the brief
 * mail (`briefEmail.deliverBriefEmail`): the digest becomes `sent` (lines
 * stripped, `digestState.ts`), and every visited thread is consumed through
 * its snapshotted boundary. A thread whose newest inbound message is past the
 * boundary (mail that arrived after selection) stays pending for the next
 * digest. ≤200 thread patches, bounded by the selection.
 */

import { v } from 'convex/values';
import type { DigestKind } from '@owlat/shared/arrival';
import type { Doc, Id } from '../../_generated/dataModel';
import { internalQuery, type MutationCtx } from '../../_generated/server';
import { openMessageBody } from '../../lib/messageBody';
import { markDigestSent } from '../arrival/digestState';
import { isLineCurrent } from './claim';
import { isPersonalMailbox } from '../permissions';
import { DIGEST_KIND_ORDER } from './select';

/** One rendered digest line. */
export interface DigestEmailLine {
	messageId: Id<'mailMessages'>;
	sender: string;
	subject: string;
	/** Verbatim spans from the mail; empty renders the subject alone. */
	spans: string[];
	path: string;
}

export interface DigestEmailGroup {
	kind: DigestKind;
	lines: DigestEmailLine[];
	more: number;
}

export interface DigestEmail {
	groups: DigestEmailGroup[];
	/** `at_least`: more than 200 threads were waiting ("200+"). */
	overflowLabel: Doc<'mailDigests'>['overflowLabel'];
}

/** The generated digest's email section, or null when it is not generated under this claim. */
export const digestForEmail = internalQuery({
	args: { digestId: v.id('mailDigests'), claimToken: v.string() },
	handler: async (ctx, args): Promise<DigestEmail | null> => {
		const digest = await ctx.db.get(args.digestId);
		if (!digest || digest.state !== 'generated' || digest.claimToken !== args.claimToken) {
			return null;
		}
		const groups: DigestEmailGroup[] = [];
		for (const kind of DIGEST_KIND_ORDER) {
			const lines: DigestEmailLine[] = [];
			for (const item of digest.items) {
				if (item.kind !== kind || !(await isLineCurrent(ctx, digest.mailboxId, item))) continue;
				const message = (await ctx.db.get(item.messageId))!;
				lines.push({
					messageId: item.messageId,
					sender: message.fromName || message.fromAddress,
					subject: message.subject,
					spans: await Promise.all((item.spans ?? []).map((span) => openMessageBody(span.quote))),
					path: `/dashboard/postbox/inbox/${item.messageId}`,
				});
			}
			const more = digest.overflowByKind[kind];
			if (lines.length > 0 || more > 0) groups.push({ kind, lines, more });
		}
		return { groups, overflowLabel: digest.overflowLabel };
	},
});

/** The message ids of a rendered digest, in render order. Pure. */
export function renderedMessageIds(digest: DigestEmail): Id<'mailMessages'>[] {
	return digest.groups.flatMap((group) => group.lines.map((line) => line.messageId));
}

/**
 * Inside the delivery mutation: whether the digest is still `generated` under
 * the claim and its current lines (fence, purge, scope re-checked here) are
 * exactly the lines the email was rendered with. `stale` asks the caller to
 * re-render; `gone` means it was sent or replaced meanwhile.
 */
export async function checkDigestDelivery(
	ctx: Pick<MutationCtx, 'db'>,
	mailbox: Pick<Doc<'mailboxes'>, '_id' | 'scope'>,
	ref: { digestId: Id<'mailDigests'>; claimToken: string; renderedMessageIds: Id<'mailMessages'>[] }
): Promise<{ kind: 'ok'; digest: Doc<'mailDigests'> } | { kind: 'stale' | 'gone' }> {
	const digest = await ctx.db.get(ref.digestId);
	if (
		!digest ||
		digest.mailboxId !== mailbox._id ||
		digest.state !== 'generated' ||
		digest.claimToken !== ref.claimToken ||
		!isPersonalMailbox(mailbox)
	) {
		return { kind: 'gone' };
	}
	const current: Id<'mailMessages'>[] = [];
	for (const kind of DIGEST_KIND_ORDER) {
		for (const item of digest.items) {
			if (item.kind === kind && (await isLineCurrent(ctx, digest.mailboxId, item))) {
				current.push(item.messageId);
			}
		}
	}
	const isSame =
		current.length === ref.renderedMessageIds.length &&
		current.every((id, index) => id === ref.renderedMessageIds[index]);
	return isSame ? { kind: 'ok', digest } : { kind: 'stale' };
}

/**
 * Mark the digest sent and consume its visited threads. Call in the mutation
 * that inserted the mail, after checking the digest is `generated` under the
 * claim. False (and no write) when it is not.
 */
export async function consumeSentDigest(
	ctx: MutationCtx,
	digest: Doc<'mailDigests'>,
	sent: { sentMessageId: Id<'mailMessages'>; sentAt: number }
): Promise<boolean> {
	if (!(await markDigestSent(ctx, digest, sent))) return false;
	for (const visited of digest.visited) {
		const thread = await ctx.db.get(visited.threadId);
		if (!thread) continue;
		const through =
			thread.digestConsumedThrough && thread.digestConsumedThrough > visited.throughSourceOrderKey
				? thread.digestConsumedThrough
				: visited.throughSourceOrderKey;
		const newest = thread.arrival?.sourceOrderKey ?? '';
		await ctx.db.patch(thread._id, {
			digestConsumedThrough: through,
			...(newest <= through ? { digestPendingSince: undefined } : {}),
		});
	}
	return true;
}
