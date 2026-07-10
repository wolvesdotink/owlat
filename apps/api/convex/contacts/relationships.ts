/**
 * Contact Relationships
 *
 * Manages the relationship graph between contacts. Relationships are authored by
 * hand from the contact's Relationships tab; there is no automated extraction.
 */

import { v } from 'convex/values';
import { authedQuery, authedMutation } from '../lib/authedFunctions';
import { requireContactsManage } from './guards';
import type { Id, Doc } from '../_generated/dataModel';
import { throwInvalidInput } from '../_utils/errors';

// ============================================================
// Queries
// ============================================================

/**
 * Get all relationships for a contact (both directions)
 */
export const listByContact = authedQuery({
	args: { contactId: v.id('contacts') },
	handler: async (ctx, args) => {
		const outgoing = await ctx.db
			.query('contactRelationships')
			.withIndex('by_from', (q) => q.eq('fromContactId', args.contactId))
			.collect(); // bounded: one contact's outgoing relationships

		const incoming = await ctx.db
			.query('contactRelationships')
			.withIndex('by_to', (q) => q.eq('toContactId', args.contactId))
			.collect(); // bounded: one contact's incoming relationships

		// Resolve contact details for display
		const relationships = [];

		for (const rel of outgoing) {
			const relatedContact = await ctx.db.get(rel.toContactId);
			relationships.push({
				...rel,
				direction: 'outgoing' as const,
				relatedContact,
			});
		}

		for (const rel of incoming) {
			const relatedContact = await ctx.db.get(rel.fromContactId);
			relationships.push({
				...rel,
				direction: 'incoming' as const,
				relatedContact,
				// Invert the relationship label for display
				displayRelationship: invertRelationship(rel.relationship),
			});
		}

		return relationships;
	},
});

/**
 * Get the relationship graph for a contact up to N hops
 */
export const getGraph = authedQuery({
	args: {
		contactId: v.id('contacts'),
		depth: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const maxDepth = args.depth ?? 2;
		const visited = new Set<string>();
		const nodes: Array<{ contact: Doc<'contacts'>; depth: number }> = [];
		const edges: Array<Doc<'contactRelationships'>> = [];

		const queue: Array<{ contactId: Id<'contacts'>; depth: number }> = [
			{ contactId: args.contactId, depth: 0 },
		];

		while (queue.length > 0) {
			const { contactId, depth } = queue.shift()!;
			const key = contactId as string;
			if (visited.has(key)) continue;
			visited.add(key);

			const contact = await ctx.db.get(contactId);
			if (!contact) continue;
			nodes.push({ contact, depth });

			if (depth >= maxDepth) continue;

			const outgoing = await ctx.db
				.query('contactRelationships')
				.withIndex('by_from', (q) => q.eq('fromContactId', contactId))
				.collect(); // bounded: one contact's outgoing relationships

			const incoming = await ctx.db
				.query('contactRelationships')
				.withIndex('by_to', (q) => q.eq('toContactId', contactId))
				.collect(); // bounded: one contact's incoming relationships

			for (const rel of outgoing) {
				edges.push(rel);
				if (!visited.has(rel.toContactId as string)) {
					queue.push({ contactId: rel.toContactId, depth: depth + 1 });
				}
			}

			for (const rel of incoming) {
				edges.push(rel);
				if (!visited.has(rel.fromContactId as string)) {
					queue.push({ contactId: rel.fromContactId, depth: depth + 1 });
				}
			}
		}

		return { nodes, edges };
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
