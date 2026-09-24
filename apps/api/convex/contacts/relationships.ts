/**
 * Contact Relationships
 *
 * Manages the relationship graph between contacts. Relationships are authored by
 * hand from the contact's Relationships tab; there is no automated extraction.
 */

import { v } from 'convex/values';
import { authedQuery, authedMutation } from '../lib/authedFunctions';
import { requireContactsManage } from './guards';
import { throwInvalidInput } from '../_utils/errors';
import { batchGet } from '../_utils/batchLoader';
import { redactContactCapabilityFields, type PublicContact } from './listing';
import type { Id } from '../_generated/dataModel';

// ============================================================
// Queries
// ============================================================

/**
 * Get all relationships for a contact (both directions).
 *
 * The related contacts ride the same capability-field redaction as every other
 * member-readable contact read (`redactContactCapabilityFields`): a joined row
 * is still a contact row, and a raw one would hand its pending DOI confirmation
 * token to the browser. Soft-deleted contacts stay invisible on both ends — an
 * erased parent lists nothing, and a relationship whose other side is erased
 * (or already gone) is dropped rather than rendered as an anonymous row, so it
 * reappears only if that contact is restored.
 */
export const listByContact = authedQuery({
	args: { contactId: v.id('contacts') },
	handler: async (ctx, args) => {
		const contact = await ctx.db.get(args.contactId);
		if (!contact || contact.deletedAt !== undefined) return [];

		const outgoing = await ctx.db
			.query('contactRelationships')
			.withIndex('by_from', (q) => q.eq('fromContactId', args.contactId))
			.collect(); // bounded: one contact's outgoing relationships

		const incoming = await ctx.db
			.query('contactRelationships')
			.withIndex('by_to', (q) => q.eq('toContactId', args.contactId))
			.collect(); // bounded: one contact's incoming relationships

		// Resolve contact details for display. The related contacts are
		// independent rows, so one batched read covers both directions instead of
		// a round trip per relationship.
		const relatedContacts = await batchGet(ctx, [
			...outgoing.map((rel) => rel.toContactId),
			...incoming.map((rel) => rel.fromContactId),
		]);
		const visibleContact = (contactId: Id<'contacts'>): PublicContact | null => {
			const related = relatedContacts.get(contactId);
			if (!related || related.deletedAt !== undefined) return null;
			return redactContactCapabilityFields(related);
		};

		const relationships = [
			...outgoing.flatMap((rel) => {
				const relatedContact = visibleContact(rel.toContactId);
				return relatedContact ? [{ ...rel, direction: 'outgoing' as const, relatedContact }] : [];
			}),
			...incoming.flatMap((rel) => {
				const relatedContact = visibleContact(rel.fromContactId);
				if (!relatedContact) return [];
				return [
					{
						...rel,
						direction: 'incoming' as const,
						relatedContact,
						// Invert the relationship label for display
						displayRelationship: invertRelationship(rel.relationship),
					},
				];
			}),
		];

		return relationships;
	},
});

// ============================================================
// Mutations
// ============================================================

/**
 * Create a manual relationship between two contacts
 */
export const create = authedMutation({
	args: {
		fromContactId: v.id('contacts'),
		toContactId: v.id('contacts'),
		relationship: v.string(),
		confidence: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		await requireContactsManage(ctx);

		if (args.fromContactId === args.toContactId) {
			throwInvalidInput('Cannot create a relationship between a contact and itself');
		}

		// Check for existing relationship
		const existing = await ctx.db
			.query('contactRelationships')
			.withIndex('by_from', (q) => q.eq('fromContactId', args.fromContactId))
			.collect(); // bounded: one contact's outgoing relationships

		const duplicate = existing.find(
			(r) => r.toContactId === args.toContactId && r.relationship === args.relationship
		);

		if (duplicate) {
			// Update confidence if higher
			if (args.confidence && args.confidence > duplicate.confidence) {
				await ctx.db.patch(duplicate._id, { confidence: args.confidence });
			}
			return duplicate._id;
		}

		return await ctx.db.insert('contactRelationships', {
			fromContactId: args.fromContactId,
			toContactId: args.toContactId,
			relationship: args.relationship,
			confidence: args.confidence ?? 1.0,
			source: 'manual',
			createdAt: Date.now(),
		});
	},
});

/**
 * Update relationship confidence
 */
export const updateConfidence = authedMutation({
	args: {
		relationshipId: v.id('contactRelationships'),
		confidence: v.number(),
	},
	handler: async (ctx, args) => {
		await requireContactsManage(ctx);

		await ctx.db.patch(args.relationshipId, { confidence: args.confidence });
	},
});

/**
 * Delete a relationship
 */
export const remove = authedMutation({
	args: { relationshipId: v.id('contactRelationships') },
	handler: async (ctx, args) => {
		await requireContactsManage(ctx);

		await ctx.db.delete(args.relationshipId);
	},
});

// ============================================================
// Helpers
// ============================================================

/**
 * Invert a relationship label for the "other side" perspective
 */
function invertRelationship(rel: string): string {
	const inversions: Record<string, string> = {
		manager_of: 'reports_to',
		reports_to: 'manager_of',
		colleague: 'colleague',
		client_of: 'vendor_for',
		vendor_for: 'client_of',
		referred_by: 'referred',
		referred: 'referred_by',
		partner_of: 'partner_of',
		knows: 'knows',
	};
	return inversions[rel] ?? rel;
}
