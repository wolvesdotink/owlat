import { v } from 'convex/values';
import { authedQuery } from '../lib/authedFunctions';

// Query to export all contacts (for CSV export, HTTP API)
export const listForExportByOrganization = authedQuery({
	args: {
		search: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const search = args.search?.toLowerCase().trim();

		let contacts;

		if (search && search.length > 0) {
			// Use search index for filtered exports. Soft-deleted (GDPR-erased)
			// contacts must never re-surface in an export — filter on the
			// `deletedAt` filterField of the search index.
			contacts = await ctx.db
				.query('contacts')
				.withSearchIndex('search_contacts', (q) =>
					q.search('searchableText', search).eq('deletedAt', undefined)
				)
				.take(10000);
		} else {
			// Export contacts with safety limit to prevent unbounded queries.
			// Ride the soft-delete browse index so erased rows are excluded.
			contacts = await ctx.db
				.query('contacts')
				.withIndex('by_deleted_at_and_created_at', (q) => q.eq('deletedAt', undefined))
				.take(10000);
		}

		// Sort by email for consistent export. Email is optional on the
		// `contacts` table — emailless contacts sort to the front via empty
		// string, keeping the order stable across runs.
		contacts.sort((a, b) => (a.email ?? '').localeCompare(b.email ?? ''));

		return contacts;
	},
});

// Query to get all property values for multiple contacts (for export)
export const getPropertyValuesForContacts = authedQuery({
	args: {
		contactIds: v.array(v.id('contacts')),
	},
	handler: async (ctx, args) => {
		if (args.contactIds.length === 0) {
			return {};
		}

		const result: Record<string, Record<string, string>> = {};

		for (const contactId of args.contactIds) {
			const contact = await ctx.db.get(contactId);
			// Skip missing or soft-deleted (GDPR-erased) contacts — their
			// property values must not re-surface in an export.
			if (!contact || contact.deletedAt !== undefined) {
				continue;
			}

			const values = await ctx.db
				.query('contactPropertyValues')
				.withIndex('by_contact', (q) => q.eq('contactId', contactId))
				.collect(); // bounded: one contact's property values

			result[contactId] = {};
			for (const value of values) {
				result[contactId][value.propertyId] = value.value;
			}
		}

		return result;
	},
});

// Cap on "select all matching". The old paginate-until-done loop accumulated
// every id into one in-memory array, which exceeded the function read/output-size
// budget and threw at hundreds-of-thousands of contacts — "select all" broke
// exactly at scale. We cap instead, and return `truncated` so the caller can warn
// the user rather than silently scoping a destructive bulk op to the first 10k.
const SELECT_ALL_LIMIT = 10000;

// Query to get all contact IDs (for bulk selection, HTTP API)
export const listAllIdsByOrganization = authedQuery({
	args: {
		search: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const search = args.search?.toLowerCase().trim();

		// Soft-deleted (GDPR-erased) contacts must never be included in a bulk
		// "select all" — filter on the search-index filterField / browse index.
		const contacts =
			search && search.length > 0
				? await ctx.db
						.query('contacts')
						.withSearchIndex('search_contacts', (q) =>
							q.search('searchableText', search).eq('deletedAt', undefined)
						)
						.take(SELECT_ALL_LIMIT)
				: await ctx.db
						.query('contacts')
						.withIndex('by_deleted_at_and_created_at', (q) => q.eq('deletedAt', undefined))
						.take(SELECT_ALL_LIMIT);

		return {
			ids: contacts.map((c) => c._id),
			truncated: contacts.length >= SELECT_ALL_LIMIT,
		};
	},
});
