/**
 * The same conversation, seen from both surfaces (idea 31).
 *
 * Mail sent to a shared address that a member can also see personally exists
 * TWICE: once as a `mailMessages` row in their Postbox, once as an
 * `inboundMessages` row in the Team Inbox. Neither side knows about the other,
 * so someone can reply from Postbox while a teammate drafts in the Team Inbox
 * and nobody finds out until the customer gets two answers.
 *
 * This module is the link and nothing more. It is READ-ONLY and it MERGES
 * NOTHING: the correlation is the RFC 5322 Message-ID (`mailMessages
 * .rfc822MessageId` ↔ `inboundMessages.messageId`, both indexed), and the answer
 * is a handful of display fields plus an id to navigate to. No body, no draft
 * text, no thread contents ever crosses the boundary.
 *
 * ── THE AUTHORIZATION RULE ──────────────────────────────────────────────────
 * The viewer must be permitted on BOTH SIDES before anything is revealed, and
 * that is checked in both directions:
 *
 *   - Postbox side: `requireMailboxAccess` on the mailbox the message lives in.
 *   - Team Inbox side: the `inbox` feature flag AND the owner/admin role the
 *     rest of `inbox/queries.ts` requires.
 *
 * Failing either check returns `null` — not a partial answer, not "a match
 * exists". The mere EXISTENCE of a counterpart is itself information about the
 * other surface, so it is behind the same gate as the details. Every early
 * return in here is that rule.
 *
 * Under today's role model the team check is the strictly narrower of the two
 * (an org owner/admin already reaches every mailbox in the org), so the
 * mailbox-side re-check on the mirror bites on the cases the role does NOT
 * cover — a suspended or deleted mailbox, and any future tightening of mailbox
 * membership. It is written as the rule rather than as an optimisation, because
 * a link between two permission domains that only holds by coincidence of
 * today's roles is one policy change away from being a leak.
 */

import { v } from 'convex/values';
import { publicQuery } from '../lib/authedFunctions';
import type { QueryCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { requireMailboxAccess } from './permissions';
import { isFeatureEnabled } from '../lib/featureFlags';
import { getBetterAuthSessionWithRole } from '../lib/sessionOrganization';

/**
 * The forms one Message-ID can be stored in.
 *
 * The Postbox ingest strips the angle brackets (`deliveryPipeline/insert.ts`
 * ::stripBrackets); the AI-inbox path stores the header as it arrived, which
 * usually keeps them. Correlating on one spelling alone would silently miss
 * every message stored in the other, so the lookup tries both. Pure and
 * exported so that stays testable without a database.
 */
export function messageIdCandidates(raw: string): string[] {
	const trimmed = raw.trim();
	if (!trimmed) return [];
	const bare = trimmed.replace(/^<+/, '').replace(/>+$/, '').trim();
	if (!bare) return [];
	const candidates = [bare, `<${bare}>`];
	// The stored value might be neither (a stray quoted or padded form) — keep it
	// so an exact match still wins.
	if (!candidates.includes(trimmed)) candidates.push(trimmed);
	return candidates;
}

/** Team Inbox state the Postbox reader is allowed to show. */
export interface TeamInboxCounterpart {
	threadId: Id<'conversationThreads'> | null;
	inboundMessageId: Id<'inboundMessages'>;
	/** Display name (or email) of the teammate the thread is assigned to. */
	assigneeName: string | null;
	/** A reply is drafted and waiting for review over there. */
	isDraftPending: boolean;
	/** The pipeline already sent a reply from the Team Inbox side. */
	isReplied: boolean;
}

/** Postbox state the Team Inbox reader is allowed to show. */
export interface PostboxCounterpart {
	messageId: Id<'mailMessages'>;
	mailboxAddress: string;
	/** System folder role the personal copy currently sits in. */
	folderRole: string | null;
	/** The personal copy has been answered (IMAP \Answered). */
	isAnswered: boolean;
}

/** Is the viewer permitted on the Team Inbox side at all? */
async function canReadTeamInbox(ctx: QueryCtx): Promise<boolean> {
	if (!(await isFeatureEnabled(ctx, 'inbox'))) return false;
	const session = await getBetterAuthSessionWithRole(ctx);
	return !!session && (session.role === 'owner' || session.role === 'admin');
}

/** The inbound row whose Message-ID matches, in either stored spelling. */
async function findInbound(
	ctx: QueryCtx,
	rfc822MessageId: string
): Promise<Doc<'inboundMessages'> | null> {
	for (const candidate of messageIdCandidates(rfc822MessageId)) {
		const hit = await ctx.db
			.query('inboundMessages')
			.withIndex('by_message_id', (q) => q.eq('messageId', candidate))
			.first();
		if (hit) return hit;
	}
	return null;
}

/**
 * "Also in Team Inbox, assigned to Ana, draft pending" — for the Postbox reader.
 *
 * Returns null unless the viewer can read BOTH the personal mailbox this message
 * lives in AND the Team Inbox.
 */
// public: soft-auth — returns null for anonymous; both-side access is enforced in-handler
export const teamInboxFor = publicQuery({
	args: { messageId: v.id('mailMessages') },
	handler: async (ctx, args): Promise<TeamInboxCounterpart | null> => {
		const message = await ctx.db.get(args.messageId);
		if (!message) return null;
		// Side one: the personal mailbox.
		const owned = await requireMailboxAccess(ctx, message.mailboxId);
		if (!owned.ok) return null;
		// Side two: the shared inbox. Checked BEFORE the correlation runs, so a
		// viewer without team access never even learns whether a match exists.
		if (!(await canReadTeamInbox(ctx))) return null;

		const inbound = await findInbound(ctx, message.rfc822MessageId);
		if (!inbound) return null;

		const thread = inbound.threadId ? await ctx.db.get(inbound.threadId) : null;
		const assignedTo = thread?.assignedTo ?? inbound.assignedTo;
		return {
			threadId: inbound.threadId ?? null,
			inboundMessageId: inbound._id,
			assigneeName: assignedTo ? await displayName(ctx, assignedTo) : null,
			// A drafted-but-unsent reply is the collision this whole strip exists
			// to prevent; the draft TEXT stays on its own side.
			isDraftPending:
				inbound.processingStatus === 'draft_ready' ||
				inbound.processingStatus === 'approved' ||
				inbound.processingStatus === 'drafting',
			isReplied: inbound.processingStatus === 'sent',
		};
	},
});

/**
 * The mirror: "Also in <address>'s Postbox" — for the Team Inbox reader.
 *
 * Same both-sides rule, checked in the other order, and the personal side is
 * re-checked per candidate row: a Message-ID can appear in several personal
 * mailboxes, and only the ones this viewer may read are eligible.
 */
// public: soft-auth — returns null for anonymous; both-side access is enforced in-handler
export const postboxFor = publicQuery({
	args: { inboundMessageId: v.id('inboundMessages') },
	handler: async (ctx, args): Promise<PostboxCounterpart | null> => {
		if (!(await canReadTeamInbox(ctx))) return null;
		const inbound = await ctx.db.get(args.inboundMessageId);
		if (!inbound) return null;

		for (const candidate of messageIdCandidates(inbound.messageId)) {
			const matches = await ctx.db
				.query('mailMessages')
				.withIndex('by_rfc822_message_id', (q) => q.eq('rfc822MessageId', candidate))
				.take(MAX_PERSONAL_COPIES);
			for (const match of matches) {
				const owned = await requireMailboxAccess(ctx, match.mailboxId);
				if (!owned.ok) continue;
				const folder = await ctx.db.get(match.folderId);
				return {
					messageId: match._id,
					mailboxAddress: owned.mailbox.address,
					folderRole: folder?.role ?? null,
					isAnswered: match.flagAnswered,
				};
			}
		}
		return null;
	},
});

/**
 * How many personal copies of one Message-ID the mirror will consider. A shared
 * address delivered to several members produces one row each; the strip names
 * the FIRST the viewer can actually read, so this only bounds the walk.
 */
const MAX_PERSONAL_COPIES = 20;

/** Teammate's display name, falling back to their email, then to nothing. */
async function displayName(ctx: QueryCtx, authUserId: string): Promise<string | null> {
	const profile = await ctx.db
		.query('userProfiles')
		.withIndex('by_auth_user_id', (q) => q.eq('authUserId', authUserId))
		.first();
	return profile?.name ?? profile?.email ?? null;
}
