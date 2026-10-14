import type { MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { decrementContactCount } from './contactCountHelpers';
import { recordContactGrowth } from '../contacts/growthCounters';
import { deleteIdentitiesForContact } from '../contacts/resolution';
import {
	repointContactJunction,
	KNOWLEDGE_ENTRY_JUNCTION,
	SEMANTIC_FILE_JUNCTION,
} from './contactJunctions';
import { ErasureBudget } from '../contacts/erasure/budget';
import { advanceErasure, finishErasure, FIRST_ERASURE_PHASE } from '../contacts/erasure/phases';

/**
 * The `contactId` FK tables the merge cascade repoints onto the survivor with a
 * plain FK swap. (What permanent deletion does to each contact-referencing
 * table is declared separately, in `contacts/erasure/relations.ts`.)
 *
 * The tables with a bespoke routine (dedupe / two-sided FK / consent
 * membership / mirrored junction) are listed in `CONTACT_MERGE_ROUTINES`
 * instead, and the fields the merge leaves alone on purpose in
 * `CONTACT_MERGE_EXCLUSIONS`. `__tests__/contactMergeRelations.test.ts` walks
 * the schema so every `v.id('contacts')` field lands in exactly one of the three.
 */
export const CONTACT_REPOINT_TABLES = [
	'contactActivities',
	'emailSends',
	'transactionalSends',
	'automationRuns',
	'formSubmissions',
	'inboundMessages',
	'unifiedMessages',
	'conversationThreads',
	'sendCompletionFailures',
	// Team Inbox sender memory (ADR-0073, D12): keyed by the sender's digest, so
	// the entry stays valid on the survivor; repointed so the survivor's erasure
	// finds it.
	'senderMemory',
	// Answer mode ask sessions: no per-contact uniqueness, so a plain swap. The
	// survivor's erasure must find them (they quote the person's mail).
	'answerAskSessions',
] as const;

/**
 * The `table.field` references to `contacts` that `mergeContactRelations`
 * moves with a routine of its own rather than the plain swap above.
 */
export const CONTACT_MERGE_ROUTINES = [
	'contactIdentities.contactId',
	'contactRelationships.fromContactId',
	'contactRelationships.toContactId',
	'contactTopics.contactId',
	'contactPropertyValues.contactId',
	'clarificationMemory.contactId',
	'knowledgeEntries.contactIds[]',
	'knowledgeEntryContacts.contactId',
	'semanticFiles.contactIds[]',
	'semanticFileContacts.contactId',
] as const;

/**
 * References to `contacts` held in a plain `v.string()` field, which the schema
 * walk cannot see. Each is moved by a routine in `mergeContactRelations`.
 */
export const CONTACT_MERGE_STRING_REFS = [
	// A contact-scoped draft strategy override (`scopeType: 'contact'`).
	'draftStrategySelections.scopeId',
] as const;

/** References to `contacts` the merge deliberately leaves on the source, and why. */
export const CONTACT_MERGE_EXCLUSIONS: Readonly<Record<string, string>> = {
	'contactErasureJobs.contactId':
		'An erasure job names the contact it erases. Moving it onto the survivor would erase the survivor.',
};

/**
 * Repoint every "simple" `contactId` FK row (the tables in
 * `CONTACT_REPOINT_TABLES`) from `sourceContactId` onto `targetContactId`.
 *
 * "Simple" = the only conflict-free move is to swap the FK; there is no unique
 * (contactId, …) constraint to dedupe against. Tables with such constraints
 * (`contactIdentities` by identifier, `contactTopics` by topic,
 * `contactPropertyValues` by property) carry their own dedupe logic in the
 * merge callers and are excluded here on purpose.
 */
async function repointSimpleContactRefs(
	ctx: MutationCtx,
	targetContactId: Id<'contacts'>,
	sourceContactId: Id<'contacts'>
): Promise<void> {
	for (const table of CONTACT_REPOINT_TABLES) {
		const rows = await ctx.db
			.query(table)
			.withIndex('by_contact', (q) => q.eq('contactId', sourceContactId))
			.collect(); // bounded: one contact's rows in each repoint table
		for (const row of rows) {
			await ctx.db.patch(row._id, { contactId: targetContactId });
		}
	}
}

/** The later of two optional timestamps. */
function laterOf(a: number | undefined, b: number | undefined): number | undefined {
	if (a === undefined) return b;
	if (b === undefined) return a;
	return Math.max(a, b);
}

/**
 * Move the source's learned clarification answers onto the target. Both
 * contacts can hold an answer to the same question (`questionKey`, which
 * carries the slot type, is what `captureStandingAnswers` upserts on): the
 * target's row survives, takes the newer answer, and adds up both counters; the
 * source's row goes. `contactId` is only ever swapped, never cleared: an absent `contactId`
 * is the organization-wide scope.
 */
async function mergeClarificationMemory(
	ctx: MutationCtx,
	targetContactId: Id<'contacts'>,
	sourceContactId: Id<'contacts'>
): Promise<void> {
	const targetRows = await ctx.db
		.query('clarificationMemory')
		.withIndex('by_contact_slot', (q) => q.eq('contactId', targetContactId))
		.collect(); // bounded: one contact's standing answers
	const targetByKey = new Map<string, Doc<'clarificationMemory'>>(
		targetRows.map((row) => [row.questionKey, row])
	);
	const sourceRows = await ctx.db
		.query('clarificationMemory')
		.withIndex('by_contact_slot', (q) => q.eq('contactId', sourceContactId))
		.collect(); // bounded: one contact's standing answers
	for (const row of sourceRows) {
		const existing = targetByKey.get(row.questionKey);
		if (!existing) {
			await ctx.db.patch(row._id, { contactId: targetContactId });
			targetByKey.set(row.questionKey, row);
			continue;
		}
		const newer = row.updatedAt > existing.updatedAt ? row : existing;
		const merged = {
			questionText: newer.questionText,
			answerValue: newer.answerValue,
			source: newer.source,
			answerCount: existing.answerCount + row.answerCount,
			useCount: existing.useCount + row.useCount,
			createdAt: Math.min(existing.createdAt, row.createdAt),
			updatedAt: Math.max(existing.updatedAt, row.updatedAt),
			lastUsedAt: laterOf(existing.lastUsedAt, row.lastUsedAt),
		};
		await ctx.db.patch(existing._id, merged);
		await ctx.db.delete(row._id);
		targetByKey.set(row.questionKey, { ...existing, ...merged });
	}
}

/**
 * Move the source's draft strategy override onto the target. A scope holds at
 * most one override per organization (`setSelection` reads it with
 * `.unique()`), so when both contacts have one, the newer choice stays on the
 * target's row and the source's row is deleted.
 */
async function mergeDraftStrategySelections(
	ctx: MutationCtx,
	targetContactId: Id<'contacts'>,
	sourceContactId: Id<'contacts'>
): Promise<void> {
	const targetRows = await ctx.db
		.query('draftStrategySelections')
		.withIndex('by_scope', (q) => q.eq('scopeType', 'contact').eq('scopeId', targetContactId))
		.collect(); // bounded: one override per organization for one contact
	const targetByOrganization = new Map(targetRows.map((row) => [row.organizationId, row]));
	const sourceRows = await ctx.db
		.query('draftStrategySelections')
		.withIndex('by_scope', (q) => q.eq('scopeType', 'contact').eq('scopeId', sourceContactId))
		.collect(); // bounded: one override per organization for one contact
	for (const row of sourceRows) {
		const existing = targetByOrganization.get(row.organizationId);
		if (!existing) {
			await ctx.db.patch(row._id, { scopeId: targetContactId });
			targetByOrganization.set(row.organizationId, row);
			continue;
		}
		if (row.updatedAt > existing.updatedAt) {
			await ctx.db.patch(existing._id, {
				strategyKind: row.strategyKind,
				updatedAt: row.updatedAt,
			});
		}
		await ctx.db.delete(row._id);
	}
}

/**
 * Move every contact-owned row (identities, relationships, topic memberships,
 * property values, learned clarification answers, and all
 * `CONTACT_REPOINT_TABLES` FK rows) from `source` onto `target`, deduping the
 * tables that carry a unique-per-contact constraint.
 *
 * This is the cascade half of a contact merge — it leaves both contact rows in
 * place; the caller deletes the source afterwards. Factored here (next to the
 * permanent-delete cascade) so the merge and delete paths enumerate the same
 * FK tables from one list and can't drift.
 *
 * Conflict handling:
 *  - contactIdentities — an identity whose `(channel, identifier)` already
 *    exists on the target is dropped (keep the target's); otherwise repointed
 *    and demoted from primary so the target keeps its own primary.
 *  - contactTopics — membership IS the consent signal (no per-row status), so a
 *    topic the target already belongs to drops the redundant source membership;
 *    otherwise the membership is repointed.
 *  - contactPropertyValues — on a property already set on the target, keep the
 *    newer value (compare `updatedAt`) and drop the loser; otherwise repoint.
 *  - clarificationMemory — on a question the target already has an answer to,
 *    keep the newer answer on the target's row, add up the counters, and drop
 *    the source's row; otherwise repoint (`mergeClarificationMemory`).
 *  - draftStrategySelections — the contact-scoped override keeps the newer
 *    choice when both contacts have one (`mergeDraftStrategySelections`).
 *  - everything else — straight FK repoint (`repointSimpleContactRefs`).
 */
export async function mergeContactRelations(
	ctx: MutationCtx,
	targetContactId: Id<'contacts'>,
	sourceContactId: Id<'contacts'>
): Promise<void> {
	// Identities — dedupe by (channel, identifier), keep target's primary.
	const sourceIdentities = await ctx.db
		.query('contactIdentities')
		.withIndex('by_contact', (q) => q.eq('contactId', sourceContactId))
		.collect(); // bounded: one contact's identities
	for (const identity of sourceIdentities) {
		const conflict = await ctx.db
			.query('contactIdentities')
			.withIndex('by_identifier', (q) =>
				q.eq('channel', identity.channel).eq('identifier', identity.identifier)
			)
			.first();
		if (conflict && conflict.contactId === targetContactId) {
			await ctx.db.delete(identity._id);
		} else {
			await ctx.db.patch(identity._id, {
				contactId: targetContactId,
				isPrimary: false,
			});
		}
	}

	// Relationships — repoint both directions onto the target.
	const fromRelations = await ctx.db
		.query('contactRelationships')
		.withIndex('by_from', (q) => q.eq('fromContactId', sourceContactId))
		.collect(); // bounded: one contact's outgoing relationships
	for (const rel of fromRelations) {
		await ctx.db.patch(rel._id, { fromContactId: targetContactId });
	}
	const toRelations = await ctx.db
		.query('contactRelationships')
		.withIndex('by_to', (q) => q.eq('toContactId', sourceContactId))
		.collect(); // bounded: one contact's incoming relationships
	for (const rel of toRelations) {
		await ctx.db.patch(rel._id, { toContactId: targetContactId });
	}

	// Topic memberships — dedupe by topic (membership = consent; no status row).
	const targetTopics = await ctx.db
		.query('contactTopics')
		.withIndex('by_contact', (q) => q.eq('contactId', targetContactId))
		.collect(); // bounded: one contact's topic memberships
	const targetTopicIds = new Set(targetTopics.map((m) => m.topicId as string));
	const sourceTopics = await ctx.db
		.query('contactTopics')
		.withIndex('by_contact', (q) => q.eq('contactId', sourceContactId))
		.collect(); // bounded: one contact's topic memberships
	for (const membership of sourceTopics) {
		if (targetTopicIds.has(membership.topicId as string)) {
			await ctx.db.delete(membership._id);
		} else {
			await ctx.db.patch(membership._id, { contactId: targetContactId });
			targetTopicIds.add(membership.topicId as string);
		}
	}

	// Property values — dedupe by property, keeping the newer value.
	const targetValues = await ctx.db
		.query('contactPropertyValues')
		.withIndex('by_contact', (q) => q.eq('contactId', targetContactId))
		.collect(); // bounded: one contact's property values
	const targetValueByProperty = new Map(
		targetValues.map((value) => [value.propertyId as string, value])
	);
	const sourceValues = await ctx.db
		.query('contactPropertyValues')
		.withIndex('by_contact', (q) => q.eq('contactId', sourceContactId))
		.collect(); // bounded: one contact's property values
	for (const value of sourceValues) {
		const existing = targetValueByProperty.get(value.propertyId as string);
		if (existing) {
			if (value.updatedAt > existing.updatedAt) {
				// Source is newer — overwrite the target's value, drop the source row.
				await ctx.db.patch(existing._id, {
					value: value.value,
					updatedAt: value.updatedAt,
				});
			}
			await ctx.db.delete(value._id);
		} else {
			await ctx.db.patch(value._id, { contactId: targetContactId });
			targetValueByProperty.set(value.propertyId as string, value);
		}
	}

	// Knowledge entry ↔ contact and semantic file ↔ contact junctions — repoint
	// onto the target, deduping a pair the target already holds and keeping each
	// parent's mirrored `contactIds` array in sync (the drift-prone invariant,
	// owned by `repointContactJunction`).
	await repointContactJunction(ctx, KNOWLEDGE_ENTRY_JUNCTION, targetContactId, sourceContactId);
	await repointContactJunction(ctx, SEMANTIC_FILE_JUNCTION, targetContactId, sourceContactId);

	// Learned clarification answers — dedupe by question, keeping the newer.
	await mergeClarificationMemory(ctx, targetContactId, sourceContactId);

	// Draft strategy override — a string-typed reference, one per scope.
	await mergeDraftStrategySelections(ctx, targetContactId, sourceContactId);

	// Everything else — straight FK repoint.
	await repointSimpleContactRefs(ctx, targetContactId, sourceContactId);
}

/**
 * Soft-delete a contact: marks the row as deleted, adjusts the cached count,
 * and hard-deletes the Contact's `contactIdentities` rows so the
 * `(channel, identifier)` is reclaimable on day 1. Once the 30-day retention
 * window has passed, the daily sweep hands the contact to the erasure walker
 * (`contacts/erasure/`) for the rest of the cascade.
 *
 * All list/lookup queries against `contacts` MUST filter `deletedAt === undefined`
 * (prefer the indexed `.withIndex('by_deleted_at', q => q.eq('deletedAt', undefined))`).
 */
export async function softDeleteContact(
	ctx: MutationCtx,
	contactId: Id<'contacts'>,
	deletedBy: string
): Promise<void> {
	const existing = await ctx.db.get(contactId);
	if (!existing || existing.deletedAt !== undefined) return;
	const deletedAt = Date.now();
	await ctx.db.patch(contactId, {
		deletedAt,
		deletedBy,
		updatedAt: deletedAt,
	});
	await recordContactGrowth(ctx, existing, { ...existing, deletedAt });
	// Cascade: identifier is privacy-sensitive and should disappear on day 1,
	// not 30 days later. See docs/adr/0008-contact-resolution-module.md.
	await deleteIdentitiesForContact(ctx, contactId);
	await decrementContactCount(ctx, 1);
}

/** Passes of the inline erasure before it gives up (see its loop). */
const MAX_INLINE_ERASURE_PASSES = 8;

/**
 * Hard-delete a contact and cascade to its dependents, all inside the caller's
 * transaction. After this runs there is no live row anywhere whose `contactId`
 * points at the deleted contact, except the scrubbed send rows kept for
 * statistics.
 *
 * WHAT happens to each dependent table is declared in
 * `contacts/erasure/relations.ts` (a schema coverage test keeps it complete)
 * and implemented by the phases in `contacts/erasure/phases.ts`. In short:
 * owned rows (topics, property values, activities, identities, relationships,
 * learned clarification answers, automation runs through their lifecycle) are
 * deleted; send rows are soft-deleted and scrubbed of the recipient's
 * identity; the person's correspondence (threads, messages, raw mail, form
 * submissions) is deleted with its blobs; knowledge about them alone is torn
 * down, shared knowledge and organization files only lose the link.
 *
 * The work is unbounded in the size of the contact's history, so only callers
 * that already process contacts in small batches use this (organization wipe,
 * sample-data removal). The soft-delete retention sweep and the REST hard
 * delete go through the persisted, bounded walker (`contacts/erasure/walker.ts`)
 * that runs the same phases a transaction at a time.
 */
export async function permanentlyDeleteContactWithRelations(
	ctx: MutationCtx,
	contactId: Id<'contacts'>,
	options?: { decrementCount?: boolean }
): Promise<void> {
	// Inline, one pass has an unlimited budget and should finish; the loop only
	// guards a phase that stops early. The contact row must never go while a
	// phase is unfinished: its remaining rows would dangle for good, and the
	// later phases would never run.
	let progress = await advanceErasure(
		ctx,
		contactId,
		{ phase: FIRST_ERASURE_PHASE },
		ErasureBudget.unlimited(),
		'inline'
	);
	for (let pass = 1; !progress.isComplete && pass < MAX_INLINE_ERASURE_PASSES; pass++) {
		progress = await advanceErasure(ctx, contactId, progress, ErasureBudget.unlimited(), 'inline');
	}
	if (!progress.isComplete) {
		throw new Error(`Contact erasure stopped in phase ${progress.phase}; the contact was kept`);
	}
	await finishErasure(ctx, contactId, { decrementCount: options?.decrementCount !== false });
}
