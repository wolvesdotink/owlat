/**
 * Per-contact data export — everything the instance holds about one person,
 * in one JSON bundle. This is the query an operator answers a GDPR
 * data-subject ACCESS request with; the org-wide CSV export only covers the
 * contact base rows and could not enumerate sends, messages, activities, or
 * extracted knowledge.
 *
 * Reads are per-contact index lookups; the high-volume collections are
 * capped with an honest `truncated` flag rather than silently cut off.
 */

import { v } from 'convex/values';
import { authedQuery } from '../lib/authedFunctions';
import { requireOrgPermission } from '../lib/sessionOrganization';
import { getOrThrow } from '../_utils/errors';
import { openInboundMessageBodyForExport, openMessageBodyForExport } from '../lib/messageBody';

const CAP = 1000;

export const exportContactData = authedQuery({
	args: { contactId: v.id('contacts') },
	handler: async (ctx, args) => {
		// Full personal-data disclosure — operator surface.
		await requireOrgPermission(ctx, 'organization:manage');

		const contact = await getOrThrow(ctx, args.contactId, 'Contact');

		const capped = async <T>(rows: T[]): Promise<{ rows: T[]; truncated: boolean }> => ({
			rows: rows.slice(0, CAP),
			truncated: rows.length > CAP,
		});

		const [
			identities,
			topics,
			propertyValues,
			activities,
			emailSends,
			transactionalSends,
			automationRuns,
			formSubmissions,
			inboundMessages,
			unifiedMessages,
			threads,
		] = await Promise.all([
			ctx.db
				.query('contactIdentities')
				.withIndex('by_contact', (q) => q.eq('contactId', args.contactId))
				.take(CAP + 1),
			ctx.db
				.query('contactTopics')
				.withIndex('by_contact', (q) => q.eq('contactId', args.contactId))
				.take(CAP + 1),
			ctx.db
				.query('contactPropertyValues')
				.withIndex('by_contact', (q) => q.eq('contactId', args.contactId))
				.take(CAP + 1),
			ctx.db
				.query('contactActivities')
				.withIndex('by_contact', (q) => q.eq('contactId', args.contactId))
				.take(CAP + 1),
			ctx.db
				.query('emailSends')
				.withIndex('by_contact', (q) => q.eq('contactId', args.contactId))
				.take(CAP + 1),
			ctx.db
				.query('transactionalSends')
				.withIndex('by_contact', (q) => q.eq('contactId', args.contactId))
				.take(CAP + 1),
			ctx.db
				.query('automationRuns')
				.withIndex('by_contact', (q) => q.eq('contactId', args.contactId))
				.take(CAP + 1),
			ctx.db
				.query('formSubmissions')
				.withIndex('by_contact', (q) => q.eq('contactId', args.contactId))
				.take(CAP + 1),
			ctx.db
				.query('inboundMessages')
				.withIndex('by_contact', (q) => q.eq('contactId', args.contactId))
				.take(CAP + 1),
			ctx.db
				.query('unifiedMessages')
				.withIndex('by_contact', (q) => q.eq('contactId', args.contactId))
				.take(CAP + 1),
			ctx.db
				.query('conversationThreads')
				.withIndex('by_contact', (q) => q.eq('contactId', args.contactId))
				.take(CAP + 1),
		]);

		// Knowledge entries linked to the contact (the junction is the
		// indexable mirror of knowledgeEntries.contactIds).
		const entryLinks = await ctx.db
			.query('knowledgeEntryContacts')
			.withIndex('by_contact', (q) => q.eq('contactId', args.contactId))
			.take(CAP + 1);
		const knowledgeEntries = (
			await Promise.all(entryLinks.slice(0, CAP).map((l) => ctx.db.get(l.entryId)))
		)
			.filter((e) => e !== null)
			.map((e) => ({
				entryType: e.entryType,
				title: e.title,
				content: e.content,
				confidence: e.confidence,
				createdAt: e.createdAt,
			}));

		// A data-subject access request must be READABLE: the message bodies are
		// sealed at rest (E8b), so DECRYPT them for the export bundle (a documented
		// E8b exception — the owner's own GDPR package is the one place plaintext
		// leaves the store). Decrypt only up to the cap we actually return.
		//
		// Use the FAIL-SAFE openers: a single row that looks sealed but fails to
		// decrypt (genuine tamper, or an attacker-crafted plaintext that happens
		// to be a structurally valid envelope during the pre-back-fill mixed-state
		// window) exports its stored value verbatim instead of throwing — one
		// crafted inbound message must not DoS the whole GDPR export. No plaintext
		// leaks either way (a real ciphertext exports as ciphertext).
		const decryptedInbound = await Promise.all(
			inboundMessages.slice(0, CAP).map(async (row) => {
				const body = await openInboundMessageBodyForExport(row);
				return { ...row, textBody: body.text, htmlBody: body.html };
			})
		);
		const decryptedUnified = await Promise.all(
			unifiedMessages.slice(0, CAP).map(async (row) => ({
				...row,
				content: await openMessageBodyForExport(row.content),
			}))
		);

		return {
			exportedAt: Date.now(),
			contact,
			identities: await capped(identities),
			topics: await capped(topics),
			propertyValues: await capped(propertyValues),
			activities: await capped(activities),
			emailSends: await capped(emailSends),
			transactionalSends: await capped(transactionalSends),
			automationRuns: await capped(automationRuns),
			formSubmissions: await capped(formSubmissions),
			inboundMessages: { rows: decryptedInbound, truncated: inboundMessages.length > CAP },
			unifiedMessages: { rows: decryptedUnified, truncated: unifiedMessages.length > CAP },
			conversationThreads: await capped(threads),
			knowledgeEntries: { rows: knowledgeEntries, truncated: entryLinks.length > CAP },
		};
	},
});
