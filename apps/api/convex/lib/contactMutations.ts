import type { MutationCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { decrementContactCount } from './contactCountHelpers';
import { deleteIdentitiesForContact } from '../contacts/resolution';
import {
	repointContactJunction,
	detachContactJunction,
	KNOWLEDGE_ENTRY_JUNCTION,
	SEMANTIC_FILE_JUNCTION,
} from './contactJunctions';

/**
 * The single source of truth for every table that carries a `contactId` FK back
 * to a `contacts` row, split by how each must be handled when a contact is
 * removed. Both the permanent-delete cascade (delete/soft-delete the children)
 * and the merge cascade (repoint the children onto the survivor) drive off this
 * one list so the two paths can't silently drift apart.
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
export async function repointSimpleContactRefs(
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
 * `(channel, identifier)` is reclaimable on day 1. A 30-day-later cron calls
 * permanentlyDeleteContactWithRelations for the rest of the cascade.
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
 * Hard-delete a contact and cascade to children. Used by the cleanup cron after
 * the soft-delete retention window expires. After this runs there is no live row
 * anywhere whose `contactId` points at the deleted contact.
 *
 * Owned rows — REQUIRED `contactId`, meaningless without the parent (delete):
 *   - contactTopics, contactPropertyValues, contactActivities,
 *     contactIdentities (channel identifiers travel with the contact),
 *     contactRelationships (both sides — `by_from` and `by_to`),
 *     automationRuns (a run is per-contact; its FK can't be nulled).
 *
 * Send rows — kept for campaign-stat integrity but SCRUBBED: emailSends /
 *   transactionalSends are soft-deleted AND their denormalized recipient
 *   identity (address, names) is overwritten. Erasure must not leave the
 *   person's email living forever in delivery history; the suppression list
 *   (address-only, deliberately minimal) is the lawful do-not-contact record.
 *
 * Conversation rows — DELETED: inboundMessages, unifiedMessages,
 *   conversationThreads, formSubmissions hold the person's own words and
 *   submitted data. The old behavior (clear the FK, keep the row) retained
 *   full message bodies and addresses after "permanent" deletion.
 *
 * Knowledge — facts extracted about the person are personal data: entries
 *   linked solely to this contact are torn down (relations + junction +
 *   entry, killing the embedding with the row); multi-contact entries just
 *   lose the link. Semantic files are org documents — unlink only.
 */
export async function permanentlyDeleteContactWithRelations(
	ctx: MutationCtx,
	contactId: Id<'contacts'>,
	options?: { decrementCount?: boolean }
): Promise<void> {
	// Cascade deletes — children that only make sense alongside the parent contact.
	const memberships = await ctx.db
		.query('contactTopics')
		.withIndex('by_contact', (q) => q.eq('contactId', contactId))
		.collect(); // bounded: one contact's topic memberships
	for (const membership of memberships) {
		await ctx.db.delete(membership._id);
	}

	const propertyValues = await ctx.db
		.query('contactPropertyValues')
		.withIndex('by_contact', (q) => q.eq('contactId', contactId))
		.collect(); // bounded: one contact's property values
	for (const value of propertyValues) {
		await ctx.db.delete(value._id);
	}

	const activities = await ctx.db
		.query('contactActivities')
		.withIndex('by_contact', (q) => q.eq('contactId', contactId))
		.collect(); // bounded: one contact's activities (cascade)
	for (const activity of activities) {
		await ctx.db.delete(activity._id);
	}

	const identities = await ctx.db
		.query('contactIdentities')
		.withIndex('by_contact', (q) => q.eq('contactId', contactId))
		.collect(); // bounded: one contact's identities
	for (const identity of identities) {
		await ctx.db.delete(identity._id);
	}

	const relationshipsFrom = await ctx.db
		.query('contactRelationships')
		.withIndex('by_from', (q) => q.eq('fromContactId', contactId))
		.collect(); // bounded: one contact's outgoing relationships
	for (const rel of relationshipsFrom) {
		await ctx.db.delete(rel._id);
	}
	const relationshipsTo = await ctx.db
		.query('contactRelationships')
		.withIndex('by_to', (q) => q.eq('toContactId', contactId))
		.collect(); // bounded: one contact's incoming relationships
	for (const rel of relationshipsTo) {
		await ctx.db.delete(rel._id);
	}

	// automationRuns carries a REQUIRED contactId — a run is intrinsically
	// per-contact and can't be left unlinked, so it cascades with the contact.
	const automationRuns = await ctx.db
		.query('automationRuns')
		.withIndex('by_contact', (q) => q.eq('contactId', contactId))
		.collect(); // bounded: one contact's automation runs (cascade)
	for (const run of automationRuns) {
		await ctx.db.delete(run._id);
	}

	// Send rows: soft-delete for stat integrity AND scrub the denormalized
	// recipient identity — erasure means the address/name must not survive in
	// delivery history (suppression keeps its own minimal address record).
	const emailSends = await ctx.db
		.query('emailSends')
		.withIndex('by_contact', (q) => q.eq('contactId', contactId))
		.collect(); // bounded: one contact's sends (GDPR cascade)
	for (const send of emailSends) {
		await ctx.db.patch(send._id, {
			deletedAt: Date.now(),
			deletedBy: 'system',
			contactEmail: '[erased]',
			contactFirstName: undefined,
			contactLastName: undefined,
		});
	}

	const transactionalSends = await ctx.db
		.query('transactionalSends')
		.withIndex('by_contact', (q) => q.eq('contactId', contactId))
		.collect(); // bounded: one contact's transactional sends (cascade)
	for (const send of transactionalSends) {
		await ctx.db.patch(send._id, {
			deletedAt: Date.now(),
			deletedBy: 'system',
			email: '[erased]',
			// Request-supplied template variables can carry PII (name, address,
			// order details). Erasure must drop them too, not just the address.
			dataVariables: undefined,
		});
	}

	// Conversation content IS the contact's personal data — delete it, don't
	// unlink it. Threads first (taking their messages, including org-authored
	// replies that quote the person), then any channel messages outside a
	// thread, then raw inbound emails and form submissions.
	const threads = await ctx.db
		.query('conversationThreads')
		.withIndex('by_contact', (q) => q.eq('contactId', contactId))
		.collect(); // bounded: one contact's threads (cascade)
	for (const thread of threads) {
		const threadMessages = await ctx.db
			.query('unifiedMessages')
			.withIndex('by_thread', (q) => q.eq('threadId', thread._id))
			.collect(); // bounded: one thread's unified messages
		for (const msg of threadMessages) {
			await ctx.db.delete(msg._id);
		}
		await ctx.db.delete(thread._id);
	}
	for (const table of ['unifiedMessages', 'inboundMessages', 'formSubmissions'] as const) {
		const rows = await ctx.db
			.query(table)
			.withIndex('by_contact', (q) => q.eq('contactId', contactId))
			.collect(); // bounded: one contact's unified messages (cascade)
		for (const row of rows) {
			await ctx.db.delete(row._id);
		}
	}

	// Knowledge about the contact: junction-driven. Entries scoped solely to
	// this contact are torn down entirely (relations + junction + entry — the
	// vector index entry dies with the row); shared entries just lose the link.
	const entryLinks = await ctx.db
		.query('knowledgeEntryContacts')
		.withIndex('by_contact', (q) => q.eq('contactId', contactId))
		.collect(); // bounded: one contact's knowledge links (cascade)
	for (const link of entryLinks) {
		const entry = await ctx.db.get(link.entryId);
		await ctx.db.delete(link._id);
		if (!entry) continue;
		const remaining = (entry.contactIds ?? []).filter((c) => c !== contactId);
		if (remaining.length === 0) {
			const outgoing = await ctx.db
				.query('knowledgeRelations')
				.withIndex('by_from', (q) => q.eq('fromEntryId', entry._id))
				.collect(); // bounded: one node's outgoing graph edges
			const incoming = await ctx.db
				.query('knowledgeRelations')
				.withIndex('by_to', (q) => q.eq('toEntryId', entry._id))
				.collect(); // bounded: one node's incoming graph edges
			for (const rel of [...outgoing, ...incoming]) {
				await ctx.db.delete(rel._id);
			}
			const otherLinks = await ctx.db
				.query('knowledgeEntryContacts')
				.withIndex('by_entry', (q) => q.eq('entryId', entry._id))
				.collect(); // bounded: one knowledge entry's contact links
			for (const other of otherLinks) {
				await ctx.db.delete(other._id);
			}
			await ctx.db.delete(entry._id);
		} else {
			await ctx.db.patch(entry._id, { contactIds: remaining });
		}
	}

	// Semantic files are org-uploaded documents — unlink, don't delete (the
	// junction + mirror-array invariant is owned by `detachContactJunction`).
	await detachContactJunction(ctx, SEMANTIC_FILE_JUNCTION, contactId);

	// Finally, delete the contact row itself.
	await ctx.db.delete(contactId);

	if (options?.decrementCount !== false) {
		await decrementContactCount(ctx, 1);
	}
}
