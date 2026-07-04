/**
 * Clarification answer-memory — persistence surface for the `clarificationMemory`
 * table (schema/askEagerness.ts). Turns an ANSWERED clarification into a
 * durable, contact-scoped standing answer so the clarify loop never asks the
 * same question twice.
 *
 * Three roles:
 *   - CAPTURE (`captureStandingAnswers`): both answer surfaces — the inbound agent
 *     (`inbox/clarification.ts`) and the Reply Queue (`mail/needsReplyClarify.ts`)
 *     — call this after the owner answers, promoting each answer to a standing
 *     fact scoped to the message's contact.
 *   - FILL (`resolveFills`): before asking, both clarification surfaces look up a
 *     matching standing answer and fill the slot silently instead of re-asking.
 *   - MANAGE (`listClarificationMemory` / `revokeClarificationMemory` /
 *     `promoteClarificationMemory`): the settings surface where the owner
 *     inspects what Owlat has learned, corrects a stale answer by revoking it,
 *     and promotes a per-contact answer to an org-general fact.
 *
 * CONTACT-SCOPE ISOLATION (lib/contactScope.ts) is enforced on BOTH read and
 * write: capture stores at the message's contact scope (and no-ops when no
 * contact resolves, so an answer never silently becomes an org-general fact —
 * promotion is an explicit, gated action); fill reads only the contact's own
 * rows plus org-general rows. An answer given for contact A can never fill a
 * slot for contact B unless it was explicitly promoted org-general.
 *
 * FAIL-SOFT: every caller wraps these in try/catch and treats any failure as
 * "no memory" — the clarify loop then behaves exactly as it does today (ask the
 * question / record nothing). Nothing here blocks ingest or the walker.
 */

import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { adminQuery, authedMutation } from '../lib/authedFunctions';
import { requireOrgPermission } from '../lib/sessionOrganization';
import { findContactByIdentifier } from '../contacts/resolution';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { normalizeQuestionKey, matchStandingAnswers } from './clarificationMemoryMatch';

const MAX_ANSWER_CHARS = 2000;
const MAX_QUESTION_CHARS = 500;

/**
 * Resolve the contact SCOPE for a capture/fill call: an explicit `contactId`
 * wins; otherwise the sender address is resolved to a contact via the shared
 * identity index. Returns `undefined` when no contact resolves — for FILL that
 * restricts to org-general rows; for CAPTURE it means "do not store" (an answer
 * with no contact must not become an org-general fact without explicit promotion).
 */
async function resolveScopeContactId(
	ctx: MutationCtx,
	contactId: Id<'contacts'> | undefined,
	fromAddress: string | undefined
): Promise<Id<'contacts'> | undefined> {
	if (contactId) return contactId;
	if (!fromAddress) return undefined;
	const identifier = fromAddress.trim().toLowerCase();
	if (identifier.length === 0) return undefined;
	const found = await findContactByIdentifier(ctx, 'email', identifier);
	return found?.contact._id;
}

const questionArg = v.object({
	id: v.string(),
	slotType: v.string(),
	text: v.string(),
});

/**
 * Look up standing answers that resolve the pending questions and return the
 * silent fills. Reads ONLY the scope's own rows plus org-general rows (never
 * another contact's), bumps `useCount`/`lastUsedAt` on each row it fills from,
 * and returns `{questionId, slotType, value}` per resolved question. A question
 * with no stored answer is omitted (it is still asked). A mutation (not a query)
 * so it can record the usage; callers invoke it fail-soft.
 */
export const resolveFills = internalMutation({
	args: {
		contactId: v.optional(v.id('contacts')),
		fromAddress: v.optional(v.string()),
		questions: v.array(questionArg),
	},
	handler: async (ctx, args) => {
		if (args.questions.length === 0) return { fills: [] as StandingFillResult[] };
		const scope = await resolveScopeContactId(ctx, args.contactId, args.fromAddress);

		// Fetch the candidate rows: the scope's own rows (when a contact resolved)
		// plus org-general rows, restricted to the slot kinds actually asked about.
		const slotTypes = new Set(args.questions.map((q) => q.slotType));
		const rows: Doc<'clarificationMemory'>[] = [];
		for (const slotType of slotTypes) {
			if (scope) {
				const own = await ctx.db
					.query('clarificationMemory')
					.withIndex('by_contact_slot', (q) => q.eq('contactId', scope).eq('slotType', slotType))
					.collect(); // bounded: standing answers for one contact + slot kind (tiny set)
				for (const row of own) rows.push(row);
			}
			const general = await ctx.db
				.query('clarificationMemory')
				.withIndex('by_contact_slot', (q) => q.eq('contactId', undefined).eq('slotType', slotType))
				.collect(); // bounded: org-general answers for one slot kind (tiny set)
			for (const row of general) rows.push(row);
		}

		const matches = matchStandingAnswers(rows, args.questions, scope);
		const now = Date.now();
		const fills: StandingFillResult[] = [];
		for (const match of matches) {
			await ctx.db.patch(match.row._id, {
				useCount: match.row.useCount + 1,
				lastUsedAt: now,
			});
			fills.push({
				questionId: match.questionId,
				slotType: match.slotType,
				value: match.row.answerValue,
			});
		}
		return { fills };
	},
});

interface StandingFillResult {
	questionId: string;
	slotType: string;
	value: string;
}

/** One captured answer: the slot kind, the question the owner answered, and the
 * value they supplied. */
export interface CaptureAnswer {
	slotType: string;
	questionText: string;
	value: string;
}

/**
 * Capture the owner's answers as standing facts. A plain helper (NOT a mutation)
 * so it is called directly from within the two answer MUTATIONS — the inbound
 * agent (`inbox/clarification.ts`) and the Reply Queue
 * (`mail/needsReplyClarify.ts`) — which cannot `runMutation`. Upserts one row per
 * answer at the message's contact scope: an existing row for the same (contact,
 * slot, normalized question) is refreshed to the latest value (a correction
 * wins) and its `answerCount` is bumped; otherwise a new row is inserted.
 * No-ops when no contact resolves so an answer never becomes an org-general fact
 * without explicit promotion. Callers invoke it fail-soft.
 */
export async function captureStandingAnswers(
	ctx: MutationCtx,
	args: {
		contactId?: Id<'contacts'> | undefined;
		fromAddress?: string | undefined;
		source: 'agent' | 'reply_queue';
		answers: CaptureAnswer[];
	}
): Promise<{ stored: number }> {
	if (args.answers.length === 0) return { stored: 0 };
	const scope = await resolveScopeContactId(ctx, args.contactId, args.fromAddress);
	// No contact to scope to → do not store (avoid an accidental org-general
	// fact). Promotion to org-general is an explicit, gated action.
	if (!scope) return { stored: 0 };

	const now = Date.now();
	let stored = 0;
	for (const answer of args.answers) {
		const value = answer.value.trim().slice(0, MAX_ANSWER_CHARS);
		if (value.length === 0) continue;
		const questionText = answer.questionText.trim().slice(0, MAX_QUESTION_CHARS);
		if (questionText.length === 0) continue;
		const questionKey = normalizeQuestionKey(answer.slotType, questionText);

		// Upsert within the exact contact scope (never touch an org-general row).
		const existingForSlot = await ctx.db
			.query('clarificationMemory')
			.withIndex('by_contact_slot', (q) =>
				q.eq('contactId', scope).eq('slotType', answer.slotType)
			)
			.collect(); // bounded: standing answers for one contact + slot kind (tiny set)
		let matched: Doc<'clarificationMemory'> | undefined;
		for (const row of existingForSlot) {
			if (row.questionKey === questionKey) {
				matched = row;
				break;
			}
		}
		if (matched) {
			await ctx.db.patch(matched._id, {
				answerValue: value,
				questionText,
				answerCount: matched.answerCount + 1,
				updatedAt: now,
			});
		} else {
			await ctx.db.insert('clarificationMemory', {
				contactId: scope,
				slotType: answer.slotType,
				questionKey,
				questionText,
				answerValue: value,
				source: args.source,
				answerCount: 1,
				useCount: 0,
				createdAt: now,
				updatedAt: now,
			});
		}
		stored += 1;
	}
	return { stored };
}

/** A learned standing answer as shown on the settings surface. */
export interface ClarificationMemoryItem {
	id: Id<'clarificationMemory'>;
	contactId?: Id<'contacts'>;
	contactName?: string;
	scope: 'contact' | 'org_general';
	slotType: string;
	questionText: string;
	answerValue: string;
	answerCount: number;
	useCount: number;
	updatedAt: number;
}

const MAX_MEMORY_ROWS = 500;

/**
 * List the learned standing answers for the settings surface, newest first,
 * with the contact's display name resolved so the UI can render "You told Owlat:
 * <question> -> <answer> (for <contact>)". Read-only; admin-gated by `adminQuery`.
 */
export const listClarificationMemory = adminQuery({
	args: {},
	handler: async (ctx): Promise<{ items: ClarificationMemoryItem[] }> => {
		const rows = await ctx.db
			.query('clarificationMemory')
			.withIndex('by_created_at')
			.order('desc')
			.take(MAX_MEMORY_ROWS);
		const items: ClarificationMemoryItem[] = [];
		for (const row of rows) {
			let contactName: string | undefined;
			if (row.contactId) {
				const contact = await ctx.db.get(row.contactId);
				if (contact && contact.deletedAt === undefined) {
					const nameParts: string[] = [];
					for (const part of [contact.firstName, contact.lastName]) {
						if (part && part.trim().length > 0) nameParts.push(part.trim());
					}
					const fullName = nameParts.join(' ');
					contactName = fullName.length > 0 ? fullName : contact.email || undefined;
				}
			}
			items.push({
				id: row._id,
				contactId: row.contactId,
				contactName,
				scope: row.contactId ? 'contact' : 'org_general',
				slotType: row.slotType,
				questionText: row.questionText,
				answerValue: row.answerValue,
				answerCount: row.answerCount,
				useCount: row.useCount,
				updatedAt: row.updatedAt,
			});
		}
		return { items };
	},
});

/**
 * Revoke (forget) a learned standing answer. The owner corrects a stale answer
 * by revoking it — the next matching email asks again. Admin-gated (mirrors the
 * autonomy/eagerness controls).
 */
// authz: org:manage via requireOrgPermission; org membership via authedMutation.
export const revokeClarificationMemory = authedMutation({
	args: { id: v.id('clarificationMemory') },
	handler: async (ctx, args) => {
		await requireOrgPermission(
			ctx,
			'organization:manage',
			'Only owners and admins can manage learned answers'
		);
		const row = await ctx.db.get(args.id);
		if (!row) return { success: true };
		await ctx.db.delete(args.id);
		return { success: true };
	},
});

/**
 * Promote a per-contact standing answer to an org-general fact so it fills for
 * ANY sender. This is the deliberately GATED widening of contact scope: it is
 * admin-only (mirrors the autonomy controls) so a contact-scoped answer only
 * ever becomes cross-contact by an explicit human decision, never automatically.
 * No-op when the row is already org-general.
 */
// authz: org:manage via requireOrgPermission; org membership via authedMutation.
export const promoteClarificationMemory = authedMutation({
	args: { id: v.id('clarificationMemory') },
	handler: async (ctx, args) => {
		await requireOrgPermission(
			ctx,
			'organization:manage',
			'Only owners and admins can promote learned answers'
		);
		const row = await ctx.db.get(args.id);
		if (!row) return { success: true };
		if (row.contactId === undefined) return { success: true };
		await ctx.db.patch(args.id, { contactId: undefined, updatedAt: Date.now() });
		return { success: true };
	},
});
