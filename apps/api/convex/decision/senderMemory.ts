/**
 * D12 sender memory (ADR-0073 §5, plan decision 12): what an authenticated
 * sender's identical message was answered last time, kept ADVISORY ONLY.
 *
 * Nothing reads an entry to route, skip or settle a message. When a bundle
 * answers a message, the completing mutation (`./artifacts.ts`) looks for a
 * live entry with the exact same key and records on the new artifact whether
 * that entry would have settled the message and whether it said the same
 * thing. That is the measurement an approved later phase would need before
 * memory may settle anything.
 *
 * - Exact matches only: `matchKind: 'exact'`, `matchKey` = the artifact's
 *   content hash. A template fingerprint must be evaluated first, so none is
 *   written in this release.
 * - Scoped to the mailbox (Postbox) or the Team Inbox, the authenticated sender
 *   (a digest of the address, DMARC pass), the task, the thread state (a new
 *   thread or a reply), the policy version, the model identity and the
 *   question-set version. Any difference is no match.
 * - Expiry: {@link SENDER_MEMORY_TTL_MS} after it was learned.
 * - Invalidation: an owner correction (`mail/category.ts` `recategorize`,
 *   `inbox/updates.ts` `requestReply`) or mail from the sender that does not
 *   pass DMARC invalidates every entry of the sender in the scope.
 *
 * A Team entry carries the sender's contact, so the contact's erasure deletes
 * it; without a contact nothing is written.
 */

import { v } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { internalMutation } from '../lib/writeFence';
import { sha256Hex } from '../lib/aiRouting/routeDigest';
import { extractEmail } from '../lib/emailAddress';
import { SENDER_MEMORY_TTL_MS } from '../lib/decision/routing';
import { senderMemoryScopeValidator, type SENDER_AUTH_BASES } from '../lib/validators/aiRouting';
import type { AiTaskName } from '@owlat/shared/aiRouting';

/** Entries one mutation invalidates before it schedules the rest. */
const INVALIDATION_PAGE = 100;

type SenderAuthBasis = (typeof SENDER_AUTH_BASES)[number];

/** The scope and sender an entry is keyed by. */
export interface SenderKey {
	readonly scope: 'team_inbox' | 'mailbox';
	readonly mailboxId?: Id<'mailboxes'>;
	readonly senderDigest: string;
}

/** The sender of an artifact's subject, as memory keys it. */
export interface SubjectSender extends SenderKey {
	readonly contactId?: Id<'contacts'>;
	/** Null: the message did not pass DMARC, so the sender is not authenticated. */
	readonly authBasis: SenderAuthBasis | null;
	readonly threadStateKey: 'new' | 'reply';
}

/**
 * SHA-256 hex of the bare, lowercased address (a `Name <address>` field is
 * reduced to its address first). The address itself is never stored.
 */
export function senderDigest(address: string): string {
	return sha256Hex(extractEmail(address));
}

/** DMARC pass binds the From domain to SPF or DKIM; nothing weaker authenticates a sender here. */
export function senderAuthBasis(dmarcResult: string | undefined): SenderAuthBasis | null {
	return dmarcResult?.trim().toLowerCase() === 'pass' ? 'dmarc_pass' : null;
}

/** The sender of a Team or Postbox message, or null when the message is gone. */
export async function subjectSender(
	ctx: { db: MutationCtx['db'] },
	subject: { inboundMessageId?: Id<'inboundMessages'>; mailMessageId?: Id<'mailMessages'> }
): Promise<SubjectSender | null> {
	if (subject.inboundMessageId) {
		const row = await ctx.db.get(subject.inboundMessageId);
		if (!row) return null;
		return {
			scope: 'team_inbox',
			senderDigest: senderDigest(row.from),
			...(row.contactId ? { contactId: row.contactId } : {}),
			authBasis: senderAuthBasis(row.dmarcResult),
			threadStateKey: row.inReplyTo ? 'reply' : 'new',
		};
	}
	if (subject.mailMessageId) {
		const row = await ctx.db.get(subject.mailMessageId);
		if (!row) return null;
		return {
			scope: 'mailbox',
			mailboxId: row.mailboxId,
			senderDigest: senderDigest(row.fromAddress),
			authBasis: senderAuthBasis(row.dmarcResult),
			threadStateKey: row.inReplyTo ? 'reply' : 'new',
		};
	}
	return null;
}

/**
 * Invalidate every live entry of `key`, one page now and the rest in scheduled
 * pages. Entries are few per sender (one per task and distinct content, each
 * expiring), so the continuation is rarely needed.
 */
export async function invalidateSenderMemory(
	ctx: MutationCtx,
	key: SenderKey,
	reason: 'owner_correction' | 'auth_failure',
	at: number,
	cursor: string | null = null
): Promise<void> {
	const page = await ctx.db
		.query('senderMemory')
		.withIndex('by_lookup', (q) =>
			q.eq('scope', key.scope).eq('mailboxId', key.mailboxId).eq('senderDigest', key.senderDigest)
		)
		.paginate({ cursor, numItems: INVALIDATION_PAGE });
	for (const row of page.page) {
		if (row.invalidatedAt !== undefined) continue;
		await ctx.db.patch(row._id, { invalidatedAt: at, invalidationReason: reason, updatedAt: at });
	}
	if (!page.isDone) {
		await ctx.scheduler.runAfter(0, internal.decision.senderMemory.invalidateRest, {
			scope: key.scope,
			...(key.mailboxId ? { mailboxId: key.mailboxId } : {}),
			senderDigest: key.senderDigest,
			reason,
			at,
			cursor: page.continueCursor,
		});
	}
}

/** The scheduled continuation of {@link invalidateSenderMemory}. */
export const invalidateRest = internalMutation({
	args: {
		scope: senderMemoryScopeValidator,
		mailboxId: v.optional(v.id('mailboxes')),
		senderDigest: v.string(),
		reason: v.union(v.literal('owner_correction'), v.literal('auth_failure')),
		at: v.number(),
		cursor: v.string(),
	},
	handler: async (ctx, args) => {
		const { reason, at, cursor, ...key } = args;
		await invalidateSenderMemory(ctx, key, reason, at, cursor);
	},
});

/**
 * An owner corrected a verdict about `address`'s mail: nothing remembered
 * about the sender in this scope is valid any more.
 */
export async function invalidateSenderMemoryForCorrection(
	ctx: MutationCtx,
	scope: { scope: 'team_inbox' } | { scope: 'mailbox'; mailboxId: Id<'mailboxes'> },
	address: string
): Promise<void> {
	await invalidateSenderMemory(
		ctx,
		{ ...scope, senderDigest: senderDigest(address) },
		'owner_correction',
		Date.now()
	);
}

/**
 * Mail from a sender that does not pass DMARC invalidates what is remembered
 * about that address in the scope. Called for every message a bundle
 * considers, sampled or not, before anything is admitted.
 */
export const observeSenderAuth = internalMutation({
	args: {
		inboundMessageId: v.optional(v.id('inboundMessages')),
		mailMessageId: v.optional(v.id('mailMessages')),
	},
	handler: async (ctx, args): Promise<null> => {
		const sender = await subjectSender(ctx, args);
		if (sender && sender.authBasis === null) {
			await invalidateSenderMemory(ctx, sender, 'auth_failure', Date.now());
		}
		return null;
	},
});

/** What memory said about a message its bundle has just answered. */
export type SenderMemoryObservation =
	| { readonly kind: 'agreed' }
	| { readonly kind: 'disagreed'; readonly remembered: string }
	| { readonly kind: 'learned' }
	| { readonly kind: 'not_applicable' };

/** One learned outcome, as the completing mutation hands it over. */
export interface LearnedOutcome {
	readonly task: AiTaskName;
	readonly matchKey: string;
	readonly policyVersion: number;
	readonly modelIdentity: string;
	/** JSON of the labels; never message text. */
	readonly outcome: string;
	readonly outcomeVersion: number;
	readonly sourceArtifactKey: string;
}

function isLiveMatch(
	row: Doc<'senderMemory'>,
	sender: SubjectSender,
	learned: LearnedOutcome,
	now: number
): boolean {
	return (
		row.invalidatedAt === undefined &&
		row.expiresAt > now &&
		row.authBasis === sender.authBasis &&
		row.threadStateKey === sender.threadStateKey &&
		row.policyVersion === learned.policyVersion &&
		row.modelIdentity === learned.modelIdentity &&
		row.outcomeVersion === learned.outcomeVersion
	);
}

/**
 * Compare the answer with a live exact entry, then remember the answer. One
 * row per exact key: a stale, invalidated or disagreeing row is replaced, so
 * the table never holds two entries for one key. Changes no routing.
 */
export async function observeAndLearn(
	ctx: MutationCtx,
	sender: SubjectSender,
	learned: LearnedOutcome,
	now: number
): Promise<SenderMemoryObservation> {
	if (sender.authBasis === null) return { kind: 'not_applicable' };
	// A Team entry without a contact could not be erased with the contact.
	if (sender.scope === 'team_inbox' && sender.contactId === undefined) {
		return { kind: 'not_applicable' };
	}
	const existing = await ctx.db
		.query('senderMemory')
		.withIndex('by_lookup', (q) =>
			q
				.eq('scope', sender.scope)
				.eq('mailboxId', sender.mailboxId)
				.eq('senderDigest', sender.senderDigest)
				.eq('task', learned.task)
				.eq('matchKind', 'exact')
				.eq('matchKey', learned.matchKey)
		)
		.first();
	if (existing && isLiveMatch(existing, sender, learned, now)) {
		if (existing.outcome === learned.outcome) {
			await ctx.db.patch(existing._id, {
				hitCount: existing.hitCount + 1,
				lastHitAt: now,
				updatedAt: now,
			});
			return { kind: 'agreed' };
		}
	}
	const fields = {
		scope: sender.scope,
		...(sender.mailboxId ? { mailboxId: sender.mailboxId } : {}),
		...(sender.contactId ? { contactId: sender.contactId } : {}),
		senderDigest: sender.senderDigest,
		authBasis: sender.authBasis,
		task: learned.task,
		matchKind: 'exact' as const,
		matchKey: learned.matchKey,
		threadStateKey: sender.threadStateKey,
		policyVersion: learned.policyVersion,
		modelIdentity: learned.modelIdentity,
		outcome: learned.outcome,
		outcomeVersion: learned.outcomeVersion,
		sourceArtifactKey: learned.sourceArtifactKey,
		hitCount: 0,
		expiresAt: now + SENDER_MEMORY_TTL_MS,
		createdAt: now,
		updatedAt: now,
	};
	const wasLive = existing !== null && isLiveMatch(existing, sender, learned, now);
	if (existing) {
		await ctx.db.replace(existing._id, fields);
	} else {
		await ctx.db.insert('senderMemory', fields);
	}
	return wasLive ? { kind: 'disagreed', remembered: existing.outcome } : { kind: 'learned' };
}
