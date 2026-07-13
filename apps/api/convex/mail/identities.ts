/**
 * Resolve the set of From addresses a mailbox is authorised to send as.
 *
 * Returns the mailbox's canonical address plus every alias that targets
 * it. Comparison is lowercase exact-match on the canonical address only —
 * display names are not part of the allow-set.
 *
 * Used as the load-bearing identity check at three boundaries:
 *   - draft dispatch (`mailDraftLifecycle.transition` `→ sent` reducer)
 *   - IMAP APPEND (`mailImap.appendMessage`)
 *   - explicit identity selection (`mailDrafts.setIdentity`, slice 3)
 *
 * Exposed both as a shared TypeScript helper (for v8 mutations that
 * already have a ctx) and as an internalQuery (for `'use node'` actions
 * that need to round-trip through Convex).
 */

import { v } from 'convex/values';
import { internalQuery } from '../_generated/server';
import { publicQuery } from '../lib/authedFunctions';
import type { QueryCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { loadReadableMailbox, requireMailboxAccess } from './permissions';
import { checkFromAlignment, emailDomain, normalizeEmail } from '@owlat/shared';
import type { OutboundAlignmentState } from '@owlat/shared';
import { outboundTransportFacts } from '../lib/outboundAlignment';
import { memoizedEmailDomainVerification } from '../domains/domains';

/**
 * Shared helper for v8 mutations/queries: read the allowed-from set
 * directly from the ctx without an extra runQuery hop.
 */
export async function resolveAllowedFromAddressesForCtx(
	ctx: QueryCtx,
	mailboxId: Id<'mailboxes'>
): Promise<string[]> {
	const mailbox = await ctx.db.get(mailboxId);
	if (!mailbox || mailbox.status !== 'active') return [];
	const aliases = await ctx.db
		.query('mailAliases')
		.withIndex('by_target', (q) => q.eq('targetMailboxId', mailboxId))
		.collect(); // bounded: aliases pointing at one target
	const set = new Set<string>();
	set.add(normalizeEmail(mailbox.address));
	for (const a of aliases) set.add(normalizeEmail(a.alias));
	return Array.from(set);
}

/** Internal query for `'use node'` actions / out-of-isolate callers. */
export const resolveAllowedFromAddresses = internalQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args): Promise<string[]> => {
		return resolveAllowedFromAddressesForCtx(ctx, args.mailboxId);
	},
});

/** Public query for the web composer's identity dropdown. */
// public: soft-auth — returns empty for anonymous; mailbox access is still enforced in-handler
export const listForOwnedMailbox = publicQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args): Promise<string[]> => {
		const mailbox = await loadReadableMailbox(ctx, args.mailboxId);
		if (!mailbox) return [];
		return resolveAllowedFromAddressesForCtx(ctx, args.mailboxId);
	},
});

// ─── Send-as choice (shared inbox) ────────────────────────────────────────────
//
// In a SHARED (team) inbox the composer's From picker offers two kinds of
// identity: the team identity (the shared mailbox's canonical address + aliases)
// AND every personal identity from the acting teammate's OWN mailboxes. Picking a
// personal identity routes the reply through that mailbox's transport and lands
// the sent copy there (`sendAsMailboxId`); the team identity is the classic path.
//
// The allow-set is NEVER bypassed — it is EXTENDED to exactly the sanctioned
// cross-mailbox identities (a teammate's own mailboxes), and everything else is
// still rejected. The offer (`resolveSendAsIdentitiesForCtx`, feeding setIdentity)
// and the dispatch-time re-check (`isSanctionedSendAsForUser`) apply the SAME
// thread-access predicate (`hasExplicitSharedThreadAccess`), so the set of
// personal identities offered is provably identical to the set sanctioned at
// send — no pick can be accepted by the composer and then revoked after Send.

export type SendAsIdentityKind = 'team' | 'own' | 'personal';

/**
 * Explicit access to a SHARED thread mailbox for send-as purposes: the mailbox's
 * own `userId`, or an explicit `mailboxMembers` row. The org owner/admin
 * role-bypass that `requireMailboxAccess` grants for READS does NOT count here —
 * cross-mailbox personal send-as requires explicit membership (the brief's
 * "membership is explicit; org membership alone grants nothing").
 *
 * This is the single predicate BOTH the offer (`resolveSendAsIdentitiesForCtx`)
 * and the dispatch-time re-check (`isSanctionedSendAsForUser`) call, so the set
 * of personal identities offered is provably identical to the set sanctioned at
 * send — an admin without a membership row is never offered (nor allowed) a
 * personal send-as that would later revert `from_revoked` after they hit Send.
 */
async function hasExplicitSharedThreadAccess(
	ctx: QueryCtx,
	thread: Doc<'mailboxes'>,
	userId: string
): Promise<boolean> {
	if (!userId) return false;
	if (thread.userId === userId) return true;
	const membership = await ctx.db
		.query('mailboxMembers')
		.withIndex('by_mailbox_user', (q) => q.eq('mailboxId', thread._id).eq('authUserId', userId))
		.unique();
	return membership !== null;
}

export interface SendAsIdentity {
	address: string; // canonical lowercase
	mailboxId: Id<'mailboxes'>; // mailbox this identity sends FROM
	kind: SendAsIdentityKind; // 'team'/'own' = the thread mailbox; 'personal' = a teammate's own mailbox
	label: string; // human display for the group heading (mailbox display name or address)
}

/**
 * A send-as identity plus its live authenticity annotation, exactly mirroring the
 * campaign wizard's `campaigns/senders.listForPicker` shape so the SAME
 * `SenderAuthChip` + disable-with-reason surface drives both From-pickers:
 *  - `domainVerified` — the address's domain still passes verification.
 *  - `alignment`      — whether the ACTIVE transport signs/bounces this From-domain
 *    in a DMARC-aligned way (`aligned` / `misaligned` / `unknown`).
 *  - `alignmentReason`— plain-language guidance when not cleanly aligned.
 */
export interface AnnotatedSendAsIdentity extends SendAsIdentity {
	domainVerified: boolean;
	alignment: OutboundAlignmentState;
	alignmentReason: string | null;
}

/**
 * The full set of identities the given user may send as while composing in
 * `threadMailbox`. Always includes the thread mailbox's own allowed-from set
 * (tagged 'team' when the mailbox is shared, else 'own'). When the thread
 * mailbox is SHARED, also includes every allowed-from address of the user's own
 * ACTIVE personal (non-shared) mailboxes in the same org — the send-as choice.
 */
export async function resolveSendAsIdentitiesForCtx(
	ctx: QueryCtx,
	threadMailbox: Doc<'mailboxes'>,
	userId: string
): Promise<SendAsIdentity[]> {
	const out: SendAsIdentity[] = [];
	const threadKind: SendAsIdentityKind = threadMailbox.scope === 'shared' ? 'team' : 'own';
	const threadLabel = threadMailbox.displayName ?? threadMailbox.address;
	for (const address of await resolveAllowedFromAddressesForCtx(ctx, threadMailbox._id)) {
		out.push({ address, mailboxId: threadMailbox._id, kind: threadKind, label: threadLabel });
	}
	// Send-as is only offered inside a shared inbox: a personal mailbox already
	// shows its own identities, and offering another mailbox there would be a
	// cross-identity leak with no team context to justify it.
	if (threadMailbox.scope !== 'shared') return out;

	// Cross-mailbox personal send-as requires EXPLICIT access to the team thread
	// (own user or membership) — not the org owner/admin role-bypass that
	// `requireMailboxAccess` grants for the read. An admin without a membership
	// row still gets the team identities above (the classic path dispatch allows
	// unconditionally), but never a personal identity that dispatch would revoke.
	// This keeps the offered set provably identical to `isSanctionedSendAsForUser`.
	if (!(await hasExplicitSharedThreadAccess(ctx, threadMailbox, userId))) return out;

	const ownMailboxes = await ctx.db
		.query('mailboxes')
		.withIndex('by_user', (q) => q.eq('userId', userId))
		.collect(); // bounded: one user's own mailboxes (typically 1–2)
	for (const mb of ownMailboxes) {
		if (mb._id === threadMailbox._id) continue; // already added above
		if (mb.status !== 'active') continue;
		if (mb.scope === 'shared') continue; // only PERSONAL identities are sanctioned here
		if (mb.organizationId !== threadMailbox.organizationId) continue;
		const label = mb.displayName ?? mb.address;
		for (const address of await resolveAllowedFromAddressesForCtx(ctx, mb._id)) {
			out.push({ address, mailboxId: mb._id, kind: 'personal', label });
		}
	}
	return out;
}

/**
 * Dispatch-time re-check (runs in the lifecycle reducer as `system`, without a
 * session): is `fromAddress` a sanctioned identity for `sendingMailboxId` when
 * replying inside `threadMailboxId` as `userId`? The allow-set is re-derived
 * from the DB, so a revoked alias or lost membership blocks the send even though
 * the draft recorded the binding earlier. Never bypasses the allow-set.
 */
export async function isSanctionedSendAsForUser(
	ctx: QueryCtx,
	params: {
		threadMailboxId: Id<'mailboxes'>;
		sendingMailboxId: Id<'mailboxes'>;
		fromAddress: string;
		userId: string;
	}
): Promise<boolean> {
	const canon = normalizeEmail(params.fromAddress);
	const allowed = await resolveAllowedFromAddressesForCtx(ctx, params.sendingMailboxId);
	if (!allowed.includes(canon)) return false;
	// Team / own identity: the sender is composing directly from this mailbox.
	// Access to it is enforced elsewhere (requireMailboxAccess on every draft op).
	if (params.sendingMailboxId === params.threadMailboxId) return true;

	// Cross-mailbox send-as: only a teammate's OWN active personal mailbox, used
	// inside a SHARED inbox they can access, in the same org.
	const sending = await ctx.db.get(params.sendingMailboxId);
	const thread = await ctx.db.get(params.threadMailboxId);
	if (!sending || !thread) return false;
	if (sending.status !== 'active' || thread.status !== 'active') return false;
	if (!params.userId) return false;
	if (sending.userId !== params.userId) return false; // sender must own the sending mailbox
	if (sending.scope === 'shared') return false; // only personal identities
	if (thread.scope !== 'shared') return false; // send-as only exists in a team inbox
	if (sending.organizationId !== thread.organizationId) return false;
	// Explicit access to the thread mailbox — the SAME predicate the offer path
	// uses, so the sanctioned set can never drift from the offered set.
	return hasExplicitSharedThreadAccess(ctx, thread, params.userId);
}

/** Public query for the web composer's send-as picker (team + personal identities). */
// public: soft-auth — returns empty for anonymous; mailbox access is still enforced in-handler
export const listSendAsIdentities = publicQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args): Promise<AnnotatedSendAsIdentity[]> => {
		const access = await requireMailboxAccess(ctx, args.mailboxId);
		if (!access.ok) return [];
		const identities = await resolveSendAsIdentitiesForCtx(ctx, access.mailbox, access.userId);

		// Annotate each identity with its live authenticity facts so the composer's
		// From-picker renders the same chip + disable-with-reason as the campaign
		// wizard. The active transport's effective outbound identities are read
		// once and reused; domain verification depends only on the address's domain,
		// so it's memoized per domain (the common case: many identities, one domain).
		const facts = outboundTransportFacts();
		const verifyDomain = memoizedEmailDomainVerification(ctx);
		return Promise.all(
			identities.map(async (identity) => {
				const verification = await verifyDomain(identity.address);
				const alignment = checkFromAlignment(emailDomain(identity.address), facts);
				return {
					...identity,
					domainVerified: verification.verified,
					alignment: alignment.state,
					alignmentReason: alignment.reason,
				};
			})
		);
	},
});
