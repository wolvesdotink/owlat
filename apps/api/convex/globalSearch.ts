import { v } from 'convex/values';
import type { QueryCtx } from './_generated/server';
import { internalQuery } from './_generated/server';
import { getUserIdFromSession } from './lib/sessionOrganization';
import { authedQuery } from './lib/authedFunctions';

export interface GlobalSearchResults {
	contacts: Array<{ id: string; type: 'contact'; title: string; subtitle: string; url: string }>;
	emails: Array<{ id: string; type: 'email'; title: string; subtitle: string; url: string }>;
	campaigns: Array<{ id: string; type: 'campaign'; title: string; subtitle: string; url: string }>;
}

/**
 * Core global search over contacts, email templates, transactional emails, and
 * campaigns via Convex search indexes. Shared by the authed UI query (`search`)
 * and the internal variant the assistant tool calls from the identity-less
 * runner (`searchInternal`). No auth inside — callers gate.
 */
export async function runGlobalSearch(
	ctx: QueryCtx,
	rawQuery: string,
	rawLimit?: number
): Promise<GlobalSearchResults> {
	const searchQuery = rawQuery.trim();
	const limit = Math.max(1, Math.min(rawLimit ?? 5, 25)); // per category

	if (!searchQuery || searchQuery.length < 2) {
		return { contacts: [], emails: [], campaigns: [] };
	}

	// Search all categories in parallel using searchIndex
	const [contacts, emails, transactionalEmails, campaigns] = await Promise.all([
		ctx.db
			.query('contacts')
			.withSearchIndex('search_contacts', (q) =>
				// Exclude soft-deleted (GDPR-erased) contacts — their PII must
				// not be discoverable via global search.
				q.search('searchableText', searchQuery).eq('deletedAt', undefined)
			)
			.take(limit),
		ctx.db
			.query('emailTemplates')
			.withSearchIndex('search_templates', (q) => q.search('searchableText', searchQuery))
			.take(limit),
		ctx.db
			.query('transactionalEmails')
			.withSearchIndex('search_transactional', (q) => q.search('searchableText', searchQuery))
			.take(limit),
		ctx.db
			.query('campaigns')
			.withSearchIndex('search_campaigns', (q) => q.search('searchableText', searchQuery))
			.take(limit),
	]);

	const matchedContacts = contacts.map((contact) => {
		const fullName = `${contact.firstName ?? ''} ${contact.lastName ?? ''}`.trim();
		const email = contact.email ?? '';
		return {
			id: contact._id as string,
			type: 'contact' as const,
			title: fullName || email,
			subtitle: email,
			url: `/dashboard/contacts/${contact._id}`,
		};
	});

	const matchedEmails = emails.map((template) => ({
		id: template._id as string,
		type: 'email' as const,
		title: template.name,
		subtitle: template.subject ?? '',
		url: `/dashboard/send/emails/${template._id}/edit`,
	}));

	const matchedTransactional = transactionalEmails.map((email) => ({
		id: email._id as string,
		type: 'email' as const,
		title: email.name,
		subtitle: `${email.subject ?? ''} (${email.slug})`,
		url: `/dashboard/send/transactional/${email._id}/edit`,
	}));

	const matchedCampaigns = campaigns.map((campaign) => ({
		id: campaign._id as string,
		type: 'campaign' as const,
		title: campaign.name,
		subtitle: campaign.subject ?? campaign.status,
		url: `/dashboard/campaigns/${campaign._id}`,
	}));

	return {
		contacts: matchedContacts,
		emails: [...matchedEmails, ...matchedTransactional],
		campaigns: matchedCampaigns,
	};
}

// Global search query that searches across contacts, emails, and campaigns
// Uses Convex searchIndex for efficient prefix-based full-text search
export const search = authedQuery({
	args: {
		query: v.string(),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args): Promise<GlobalSearchResults> => {
		await getUserIdFromSession(ctx);
		return runGlobalSearch(ctx, args.query, args.limit);
	},
});

/**
 * Internal variant for the assistant `searchEverything` tool. The conversation
 * runner is a scheduled action with no user identity, so it cannot call the
 * authed `search`; this internal query exposes the same single-org dataset to
 * the tool layer (the org is the only tenant — see lib/sessionOrganization.ts).
 */
export const searchInternal = internalQuery({
	args: {
		query: v.string(),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args): Promise<GlobalSearchResults> => {
		return runGlobalSearch(ctx, args.query, args.limit);
	},
});
