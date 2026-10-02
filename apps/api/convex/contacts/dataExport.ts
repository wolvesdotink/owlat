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
import { internalQuery, type QueryCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { authedAction, authedQuery } from '../lib/authedFunctions';
import { hasPermission, requireOrgPermission, requirePermission } from '../lib/sessionOrganization';
import { isSharedInboxReader } from '../inbox/access';
import { getOrThrow } from '../_utils/errors';
import { utf8Bytes } from '../lib/bytes';
import { redactContactCapabilityFields } from './listing';
import {
	openBodyPreservingLegacyForContactExport,
	openConversationPreviewPreservingLegacyForContactExport,
	openInboundBodyPreservingLegacyForContactExport,
	readStoredInboundPartForContactExport,
	type StoredPartExportAvailability,
} from '../lib/messageBodyExport';

const CAP = 1000;

/**
 * How large the whole bundle may get, as JSON. It is one action result, which
 * Convex caps at 16 MiB; the rest is headroom for the envelope. The inline
 * bundle is charged first and the stored parts share what is left.
 */
const EXPORT_RESULT_BUDGET_BYTES = 12 * 1024 * 1024;

/** The size of a stored body part, for the action to budget before reading. */
async function storedSize(
	ctx: QueryCtx,
	storageId: Id<'_storage'> | undefined
): Promise<number | undefined> {
	return storageId ? (await ctx.db.system.get(storageId))?.size : undefined;
}

/**
 * The bundle, minus the Team Inbox body parts held in storage — a query cannot
 * read blob contents. Each inbound row that has one carries its excerpt and
 * the stored sizes; {@link exportContactDataBundle} fills the parts in.
 */
async function collectContactData(ctx: QueryCtx, contactId: Id<'contacts'>) {
	const contact = await getOrThrow(ctx, contactId, 'Contact');

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
			.withIndex('by_contact', (q) => q.eq('contactId', contactId))
			.take(CAP + 1),
		ctx.db
			.query('contactTopics')
			.withIndex('by_contact', (q) => q.eq('contactId', contactId))
			.take(CAP + 1),
		ctx.db
			.query('contactPropertyValues')
			.withIndex('by_contact', (q) => q.eq('contactId', contactId))
			.take(CAP + 1),
		ctx.db
			.query('contactActivities')
			.withIndex('by_contact', (q) => q.eq('contactId', contactId))
			.take(CAP + 1),
		ctx.db
			.query('emailSends')
			.withIndex('by_contact', (q) => q.eq('contactId', contactId))
			.take(CAP + 1),
		ctx.db
			.query('transactionalSends')
			.withIndex('by_contact', (q) => q.eq('contactId', contactId))
			.take(CAP + 1),
		ctx.db
			.query('automationRuns')
			.withIndex('by_contact', (q) => q.eq('contactId', contactId))
			.take(CAP + 1),
		ctx.db
			.query('formSubmissions')
			.withIndex('by_contact', (q) => q.eq('contactId', contactId))
			.take(CAP + 1),
		ctx.db
			.query('inboundMessages')
			.withIndex('by_contact', (q) => q.eq('contactId', contactId))
			.take(CAP + 1),
		ctx.db
			.query('unifiedMessages')
			.withIndex('by_contact', (q) => q.eq('contactId', contactId))
			.take(CAP + 1),
		ctx.db
			.query('conversationThreads')
			.withIndex('by_contact', (q) => q.eq('contactId', contactId))
			.take(CAP + 1),
	]);

	// Knowledge entries linked to the contact (the junction is the
	// indexable mirror of knowledgeEntries.contactIds).
	const entryLinks = await ctx.db
		.query('knowledgeEntryContacts')
		.withIndex('by_contact', (q) => q.eq('contactId', contactId))
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
	// decrypt (tamper, key mismatch, or a structurally valid attacker-crafted
	// envelope) is quarantined as blank instead of throwing. Ordinary legacy
	// plaintext still passes through, while ciphertext never crosses the
	// export boundary or turns one damaged row into a whole-export failure.
	const decryptedInbound = await Promise.all(
		inboundMessages.slice(0, CAP).map(async (row) => {
			const body = await openInboundBodyPreservingLegacyForContactExport(row);
			const storedBodySizes = {
				text: await storedSize(ctx, row.textBodyStorageId),
				html: await storedSize(ctx, row.htmlBodyStorageId),
			};
			return {
				...row,
				textBody: body.text,
				htmlBody: body.html,
				bodyExcerpt: body.excerpt,
				storedBodySizes,
			};
		})
	);
	const decryptedUnified = await Promise.all(
		unifiedMessages.slice(0, CAP).map(async (row) => ({
			...row,
			content: await openBodyPreservingLegacyForContactExport(row.content),
		}))
	);
	const decryptedThreads = await Promise.all(
		threads.slice(0, CAP).map(openConversationPreviewPreservingLegacyForContactExport)
	);

	return {
		exportedAt: Date.now(),
		// The pending DOI token is a consent capability, not personal data
		// about the subject; a bundle handed outside the instance must not
		// carry it.
		contact: redactContactCapabilityFields(contact),
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
		conversationThreads: {
			rows: decryptedThreads,
			truncated: threads.length > CAP,
		},
		knowledgeEntries: { rows: knowledgeEntries, truncated: entryLinks.length > CAP },
	};
}

type ContactDataBundle = Awaited<ReturnType<typeof collectContactData>>;

/** An inbound row of the complete export: a stored part says what became of it. */
type InboundExportRow = ContactDataBundle['inboundMessages']['rows'][number] & {
	storedBodyAvailability?: {
		text?: StoredPartExportAvailability;
		html?: StoredPartExportAvailability;
	};
};

type ContactDataExport = Omit<ContactDataBundle, 'inboundMessages'> & {
	inboundMessages: { rows: InboundExportRow[]; truncated: boolean };
};

/**
 * The previous contact page's export, a query and so without the stored body
 * parts. Kept one release for tabs opened before the deploy
 * (`scripts/entryWiringPreviousRelease.ts`); remove after the next release.
 */
export const exportContactData = authedQuery({
	args: { contactId: v.id('contacts') },
	handler: async (ctx, args, session) => {
		// Full personal-data disclosure — operator surface. The bundle carries the
		// contact's Team Inbox mail and threads, so the caller must also pass the
		// shared-inbox reader gate (inbox/access.ts): a bundle with those left out
		// would not answer an access request.
		requirePermission(hasPermission(session.role, 'organization:manage'));
		requirePermission(isSharedInboxReader(session));
		return await collectContactData(ctx, args.contactId);
	},
});

/** The authorization and the database half of {@link exportContactDataBundle}. */
export const readContactDataForExport = internalQuery({
	args: { contactId: v.id('contacts') },
	handler: async (ctx, args): Promise<ContactDataBundle> => {
		// Same gate as exportContactData; the identity is the calling action's.
		const session = await requireOrgPermission(ctx, 'organization:manage');
		requirePermission(isSharedInboxReader(session));
		return await collectContactData(ctx, args.contactId);
	},
});

/**
 * The per-contact export, complete: the query's bundle with every Team Inbox
 * body part that lives in storage read back in, within
 * {@link EXPORT_RESULT_BUDGET_BYTES}. A part that could not be included says
 * why in `storedBodyAvailability`, and its row keeps the excerpt.
 */
// authz: gate lives in internal.contacts.dataExport.readContactDataForExport (organization:manage + shared-inbox reader, inherited identity).
export const exportContactDataBundle = authedAction({
	args: { contactId: v.id('contacts') },
	handler: async (ctx, args): Promise<ContactDataExport> => {
		const bundle: ContactDataBundle = await ctx.runQuery(
			internal.contacts.dataExport.readContactDataForExport,
			args
		);
		const budget = {
			remainingBytes: Math.max(
				0,
				EXPORT_RESULT_BUDGET_BYTES - utf8Bytes(JSON.stringify(bundle)).byteLength
			),
		};
		const rows: InboundExportRow[] = [];
		// In order, so the budget is spent on the rows the bundle lists first.
		for (const row of bundle.inboundMessages.rows) {
			if (!row.textBodyStorageId && !row.htmlBodyStorageId) {
				rows.push(row);
				continue;
			}
			const read = (id: Id<'_storage'> | undefined, size: number | undefined) =>
				id
					? readStoredInboundPartForContactExport(ctx.storage, id, size, budget)
					: Promise.resolve(undefined);
			const text = await read(row.textBodyStorageId, row.storedBodySizes.text);
			const html = await read(row.htmlBodyStorageId, row.storedBodySizes.html);
			rows.push({
				...row,
				...(text ? { textBody: text.content } : {}),
				...(html ? { htmlBody: html.content } : {}),
				storedBodyAvailability: { text: text?.availability, html: html?.availability },
			});
		}
		return { ...bundle, inboundMessages: { ...bundle.inboundMessages, rows } };
	},
});
