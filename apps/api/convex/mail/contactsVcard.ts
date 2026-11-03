/**
 * vCard import into and export out of the Postbox address book
 * (`mailContacts`).
 *
 * The browser parses the .vcf file (`@owlat/shared/postboxVcard`) and sends
 * its entries here in batches. Every entry is normalized again with the
 * parser's own bounds before it is written, so a hand-made call can store no
 * more than an honest file could.
 *
 * Merging is by address. A row the mail already built keeps its name,
 * organization and use counts; the import fills what is missing and adds
 * phone numbers and postal addresses. A new row counts as an address-book
 * entry everywhere else (screener, cold-pitch verdicts) with `useCount` 0,
 * because nobody has been written to yet.
 *
 * Export pages through the whole book, so it can hand back more rows than the
 * contacts page loads.
 */

import { paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';
import {
	VCARD_IMPORT_BATCH_SIZE,
	mergeVcardAddresses,
	mergeVcardPhones,
	normalizeVcardImportEntry,
} from '@owlat/shared/postboxVcard';
import { postboxMutation, postboxQuery } from './_helpers';
import { requireMailboxAccess } from './permissions';
import { loadSenderContact } from './senderEvidence';
import { voidColdPitchVerdictsOfSender } from './arrival/coldPitch';
import { throwForbidden, throwInvalidInput } from '../_utils/errors';
import { mailContactImportEntryValidator } from '../lib/validators/mailContacts';

/** Rows one export page holds at most. */
const EXPORT_PAGE_LIMIT = 500;

/** Write one batch of parsed vCard entries into a mailbox's address book. */
// authz: mailbox access via requireMailboxAccess; org membership via the postbox builder.
export const importBatch = postboxMutation({
	args: {
		mailboxId: v.id('mailboxes'),
		entries: v.array(mailContactImportEntryValidator),
	},
	handler: async (ctx, args) => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
		if (!owned.ok) throwForbidden('Mailbox not accessible');
		if (args.entries.length > VCARD_IMPORT_BATCH_SIZE) {
			throwInvalidInput(`At most ${VCARD_IMPORT_BATCH_SIZE} contacts per batch`);
		}

		const now = Date.now();
		let created = 0;
		let merged = 0;
		let skipped = 0;
		for (const raw of args.entries) {
			const entry = normalizeVcardImportEntry(raw);
			if (!entry) {
				skipped++;
				continue;
			}
			const existing = await loadSenderContact(ctx, args.mailboxId, entry.email);
			if (existing) {
				const phones = mergeVcardPhones(existing.phones, entry.phones);
				const postalAddresses = mergeVcardAddresses(
					existing.postalAddresses,
					entry.postalAddresses
				);
				await ctx.db.patch(existing._id, {
					displayName: existing.displayName ?? entry.displayName,
					organization: existing.organization ?? entry.organization,
					phones: phones.length > 0 ? phones : undefined,
					postalAddresses: postalAddresses.length > 0 ? postalAddresses : undefined,
					importedAt: now,
				});
				merged++;
				continue;
			}
			await voidColdPitchVerdictsOfSender(ctx, args.mailboxId, entry.email);
			await ctx.db.insert('mailContacts', {
				mailboxId: args.mailboxId,
				email: entry.email,
				displayName: entry.displayName,
				organization: entry.organization,
				phones: entry.phones,
				postalAddresses: entry.postalAddresses,
				useCount: 0,
				lastUsedAt: now,
				importedAt: now,
				createdAt: now,
			});
			created++;
		}
		return { created, merged, skipped };
	},
});

/** One page of a mailbox's address book, in the shape the .vcf export writes. */
// authz: mailbox access via requireMailboxAccess; org membership via the postbox builder.
export const exportPage = postboxQuery({
	args: { mailboxId: v.id('mailboxes'), paginationOpts: paginationOptsValidator },
	handler: async (ctx, args) => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
		if (!owned.ok) throwForbidden('Mailbox not accessible');
		const result = await ctx.db
			.query('mailContacts')
			.withIndex('by_mailbox_and_email', (q) => q.eq('mailboxId', args.mailboxId))
			.paginate({
				...args.paginationOpts,
				numItems: Math.min(args.paginationOpts.numItems, EXPORT_PAGE_LIMIT),
			});
		return {
			...result,
			page: result.page.map((contact) => ({
				email: contact.email,
				displayName: contact.displayName,
				organization: contact.organization,
				phones: contact.phones,
				postalAddresses: contact.postalAddresses,
			})),
		};
	},
});
