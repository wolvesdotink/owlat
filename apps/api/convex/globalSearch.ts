import { v } from 'convex/values';
import type { QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { internalQuery } from './_generated/server';
import { getBetterAuthSessionWithRole, getUserIdFromSession } from './lib/sessionOrganization';
import { authedQuery } from './lib/authedFunctions';
import { loadAccessibleMailboxes } from './mail/permissions';

export interface GlobalSearchResults {
	contacts: Array<{ id: string; type: 'contact'; title: string; subtitle: string; url: string }>;
	emails: Array<{ id: string; type: 'email'; title: string; subtitle: string; url: string }>;
	campaigns: Array<{ id: string; type: 'campaign'; title: string; subtitle: string; url: string }>;
	/**
	 * Received/sent MAIL. Empty unless the caller passed its own mailbox set —
	 * mail is per-user, so it is never derived inside the shared core (the
	 * identity-less assistant runner calls the same function).
	 *
	 * `title` is the raw subject and may be empty; the UI supplies its own
	 * "(no subject)" wording rather than the backend inventing untranslated copy.
	 */
	mail: Array<{
		id: string;
		type: 'mail';
		title: string;
		subtitle: string;
		url: string;
		mailboxId: string;
	}>;
}

/** Folders whose messages must never surface in a cross-app search. */
const HIDDEN_MAIL_ROLES = new Set(['spam', 'trash']);

/**
 * Newest matching messages across the given mailboxes.
 *
 * Each mailbox is searched on its own (the search index is filtered by
 * `mailboxId`), and the per-mailbox hits are merged newest-first — relevance
 * scores from separate index queries are not comparable across mailboxes, so
 * arrival time is the only honest shared ordering. Spam and Trash are dropped
 * after the fact, which can shrink the list below `limit`; a palette row for a
 * quarantined message would be worse than a short list.
 */
async function searchMail(
	ctx: QueryCtx,
	searchQuery: string,
	limit: number,
	mailboxIds: readonly Id<'mailboxes'>[]
): Promise<GlobalSearchResults['mail']> {
	const hits = (
		await Promise.all(
			mailboxIds.map((mailboxId) =>
				ctx.db
					.query('mailMessages')
					.withSearchIndex('search_messages', (q) =>
						q.search('snippet', searchQuery).eq('mailboxId', mailboxId)
					)
					.take(limit)
			)
		)
	)
		.flat()
		.sort((left, right) => right.receivedAt - left.receivedAt)
		.slice(0, limit);

	const rows: GlobalSearchResults['mail'] = [];
	for (const message of hits) {
		const folder = await ctx.db.get(message.folderId);
		if (folder?.role && HIDDEN_MAIL_ROLES.has(folder.role)) continue;
		// The Postbox route takes either a system-folder role or a custom folder id.
		const folderParam = folder?.role ?? message.folderId;
		rows.push({
			id: message._id as string,
			type: 'mail' as const,
			title: message.subject,
			subtitle: `${message.fromName || message.fromAddress} · ${message.snippet}`.trim(),
			url: `/dashboard/postbox/${folderParam}/${message._id}`,
			mailboxId: message.mailboxId as string,
		});
	}
	return rows;
}

/**
 * Core global search over contacts, email templates, transactional emails,
 * campaigns and — when the caller supplies its mailboxes — mail, via Convex
 * search indexes. Shared by the authed UI query (`search`) and the internal
 * variant the assistant tool calls from the identity-less runner
 * (`searchInternal`). No auth inside — callers gate, which is exactly why the
 * mailbox set is an ARGUMENT: a caller that cannot name a user cannot get mail.
 */
export async function runGlobalSearch(
	ctx: QueryCtx,
	rawQuery: string,
	rawLimit?: number,
	mailboxIds: readonly Id<'mailboxes'>[] = []
): Promise<GlobalSearchResults> {
	const searchQuery = rawQuery.trim();
	const limit = Math.max(1, Math.min(rawLimit ?? 5, 25)); // per category

	if (!searchQuery || searchQuery.length < 2) {
		return { contacts: [], emails: [], campaigns: [], mail: [] };
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
		mail: mailboxIds.length > 0 ? await searchMail(ctx, searchQuery, limit, mailboxIds) : [],
	};
}

// Global search query that searches across contacts, emails, campaigns and mail
// Uses Convex searchIndex for efficient prefix-based full-text search
export const search = authedQuery({
	args: {
		query: v.string(),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args): Promise<GlobalSearchResults> => {
		await getUserIdFromSession(ctx);
		// Mail is the one category scoped to the CALLER rather than to the org, so
		// the mailbox set is derived from their session here (own mailboxes +
		// explicit shared memberships, active only) and never taken from an
		// argument.
		const session = await getBetterAuthSessionWithRole(ctx);
		const organizationId = session?.activeOrganizationId;
		const mailboxIds = organizationId
			? (await loadAccessibleMailboxes(ctx, session.userId, organizationId))
					.filter((mailbox) => mailbox.status === 'active')
					.map((mailbox) => mailbox._id)
			: [];
		return runGlobalSearch(ctx, args.query, args.limit, mailboxIds);
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
