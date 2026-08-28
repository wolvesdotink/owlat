import { v } from 'convex/values';
import { authedQuery, authedMutation } from '../lib/authedFunctions';
import type { QueryCtx, MutationCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { getUserIdFromSession, requireOrgPermission } from '../lib/sessionOrganization';
import { validateStringLength, STRING_LIMITS } from '../lib/inputGuards';
import { getOrThrow, throwInvalidInput } from '../_utils/errors';

/**
 * Verify a contact exists.
 */
async function verifyContactExists(
	ctx: Pick<QueryCtx | MutationCtx, 'db'>,
	contactId: Id<'contacts'>
) {
	const contact = await getOrThrow(ctx, contactId, 'Contact');
	return contact;
}

// Query to get all property values for a contact
export const listByContact = authedQuery({
	args: { contactId: v.id('contacts') },
	handler: async (ctx, args) => {
		await getUserIdFromSession(ctx);
		await verifyContactExists(ctx, args.contactId);

		return await ctx.db
			.query('contactPropertyValues')
			.withIndex('by_contact', (q) => q.eq('contactId', args.contactId))
			.collect(); // bounded: one contact's property values
	},
});

// Mutation to delete a property value
export const remove = authedMutation({
	args: {
		contactId: v.id('contacts'),
		propertyId: v.id('contactProperties'),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(
			ctx,
			'contacts:manage',
			'Only owners and admins can modify contact properties'
		);

		// Verify contact exists
		await verifyContactExists(ctx, args.contactId);

		const existing = await ctx.db
			.query('contactPropertyValues')
			.withIndex('by_contact_and_property', (q) =>
				q.eq('contactId', args.contactId).eq('propertyId', args.propertyId)
			)
			.first();

		if (existing) {
			await ctx.db.delete(existing._id);
		}

		// Return a defined value so callers can distinguish a successful remove
		// (resolves to true) from a failed mutation (useBackendOperation.run
		// resolves to undefined on error). Without this the void return is
		// indistinguishable from the error sentinel.
		return true;
	},
});

// Upper bound on the property-usage count scan. `contactPropertyValues` has one
// row per (contact, property), so a widely-set property grows with the whole
// contact base; an uncapped `.collect()` would trip Convex's per-query read
// limit on a large deployment. The count saturates at this cap — the UI only
// needs "how widely used" (and whether it is safe to delete), not an exact tally
// past thousands.
const PROPERTY_VALUE_COUNT_LIMIT = 10_000;

// Query to count how many contacts have values for a given property
export const countByProperty = authedQuery({
	args: { propertyId: v.id('contactProperties') },
	handler: async (ctx, args) => {
		await getUserIdFromSession(ctx);

		// Verify property exists
		await getOrThrow(ctx, args.propertyId, 'Property');

		const values = await ctx.db
			.query('contactPropertyValues')
			.withIndex('by_property', (q) => q.eq('propertyId', args.propertyId))
			.take(PROPERTY_VALUE_COUNT_LIMIT); // bounded: count saturates at the cap
		return values.length;
	},
});

// Mutation to bulk set property values for a contact
export const bulkSet = authedMutation({
	args: {
		contactId: v.id('contacts'),
		values: v.array(
			v.object({
				propertyId: v.id('contactProperties'),
				value: v.string(),
			})
		),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(
			ctx,
			'contacts:manage',
			'Only owners and admins can modify contact properties'
		);

		// Enforce array size limit
		if (args.values.length > 50) {
			throwInvalidInput('Cannot set more than 50 property values at once');
		}

		// Validate all value lengths upfront
		for (const { value } of args.values) {
			validateStringLength(value, STRING_LIMITS.FORM_FIELD_VALUE, 'Property value');
		}

		// Verify contact exists
		await verifyContactExists(ctx, args.contactId);

		const now = Date.now();
		const results: string[] = [];

		for (const { propertyId, value } of args.values) {
			// Check if value already exists
			const existing = await ctx.db
				.query('contactPropertyValues')
				.withIndex('by_contact_and_property', (q) =>
					q.eq('contactId', args.contactId).eq('propertyId', propertyId)
				)
				.first();

			if (existing) {
				await ctx.db.patch(existing._id, {
					value,
					updatedAt: now,
				});
				results.push(existing._id);
			} else {
				const id = await ctx.db.insert('contactPropertyValues', {
					contactId: args.contactId,
					propertyId,
					value,
					createdAt: now,
					updatedAt: now,
				});
				results.push(id);
			}
		}

		return results;
	},
});
