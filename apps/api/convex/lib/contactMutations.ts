import type { MutationCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { decrementContactCount } from './contactCountHelpers';
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
 * `contactIdentities`, `contactRelationships`, `contactTopics`, and
 * `contactPropertyValues` are handled by bespoke routines (dedupe / two-sided
 * FK / consent membership) and are therefore intentionally NOT in either array
 * below — see `repointSimpleContactRefs` / the per-table loops in the callers.
 */
const CONTACT_REPOINT_TABLES = [
	'contactActivities',
	'emailSends',
	'transactionalSends',
	'automationRuns',
	'formSubmissions',
	'inboundMessages',
	'unifiedMessages',
	'conversationThreads',
] as const;

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

/**
 * Move every contact-owned row (identities, relationships, topic memberships,
 * property values, and all `CONTACT_REPOINT_TABLES` FK rows) from `source` onto
 * `target`, deduping the tables that carry a unique-per-contact constraint.
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
	await ctx.db.patch(contactId, {
		deletedAt: Date.now(),
		deletedBy,
		updatedAt: Date.now(),
	});
	// Cascade: identifier is privacy-sensitive and should disappear on day 1,
	// not 30 days later. See docs/adr/0008-contact-resolution-module.md.
	await deleteIdentitiesForContact(ctx, contactId);
	await decrementContactCount(ctx, 1);
}

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
	await advanceErasure(
		ctx,
		contactId,
		{ phase: FIRST_ERASURE_PHASE },
		ErasureBudget.unlimited(),
		'inline'
	);
	await finishErasure(ctx, contactId, { decrementCount: options?.decrementCount !== false });
}
