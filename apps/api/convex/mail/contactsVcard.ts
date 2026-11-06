/**
 * vCard import into and export out of the Postbox address book
 * (`mailContacts`).
 *
 * The browser parses the .vcf file (`@owlat/shared/postboxVcard`) and sends
 * its entries here in batches. Every entry is normalized again with the
 * parser's own bounds before it is written, so a hand-made call can store no
 * more than an honest file could.
 *
 * Merging is by address (`contactsMerge.ts`). Pictures do not travel in these
 * batches: the browser sends them afterwards through `contactsPhotos.ts`,
 * because only an action can put them in file storage.
 *
 * Export pages through the whole book, so it can hand back more rows than the
 * contacts page loads. A row's picture comes back as a short-lived URL the
 * browser reads and writes into the card.
 */

import { paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';
import { VCARD_IMPORT_BATCH_SIZE, normalizeVcardImportEntry } from '@owlat/shared/postboxVcard';
import { postboxMutation, postboxQuery } from './_helpers';
import { requireMailboxAccess } from './permissions';
import { writeAddressBookEntry } from './contactsMerge';
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
			const written = await writeAddressBookEntry(
				ctx,
				args.mailboxId,
				entry,
				{ kind: 'vcard' },
				now
			);
			if (written.outcome === 'created') created++;
			else merged++;
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
		const page = await Promise.all(
			result.page.map(async (contact) => ({
				email: contact.email,
				displayName: contact.displayName,
				organization: contact.organization,
				phones: contact.phones,
				postalAddresses: contact.postalAddresses,
				photoUrl: contact.photoStorageId
					? ((await ctx.storage.getUrl(contact.photoStorageId)) ?? undefined)
					: undefined,
			}))
		);
		return { ...result, page };
	},
});
