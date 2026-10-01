/**
 * Shared seeds for the Answer mode "Draft with AI" suites
 * (answerAskDraft / answerAskFiles integration tests): a Postbox mailbox, the
 * customer's email asking for the September invoice, the customer as a contact,
 * and files that may or may not be the one asked for.
 */

import type { TestConvex } from 'convex-test';
import type schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { seedFolder, seedMailbox, seedMessage } from '../../mail/__tests__/helpers.testlib';
import { createTestContact, createTestContactIdentity } from '../factories';

export const OWNER_ADDRESS = 'ada@example.com';
export const CUSTOMER = 'jonas@example.org';
export const ORG = 'org-a';

export const INVOICE_REQUEST =
	'Hi Ada,\n\ncould you send us the invoice for September? Our books close on Friday. ' +
	'Please make sure our PO number BP-2231 is on it, as agreed.\n\nThanks,\nJonas';

type T = TestConvex<typeof schema>;

/** A mailbox for `userId` with the customer's request in its inbox. */
export async function seedRequest(
	t: T,
	opts: { userId?: string; address?: string; text?: string } = {}
): Promise<{ mailboxId: Id<'mailboxes'>; messageId: Id<'mailMessages'> }> {
	const mailboxId = await seedMailbox(t, {
		userId: opts.userId ?? 'user-a',
		organizationId: ORG,
		address: opts.address ?? OWNER_ADDRESS,
	});
	await seedFolder(t, mailboxId, 'inbox');
	await seedFolder(t, mailboxId, 'sent');
	const messageId = await seedMessage(t, mailboxId, {
		subject: 'September invoice',
		fromAddress: CUSTOMER,
		fromName: 'Jonas Berg',
		textBodyInline: opts.text ?? INVOICE_REQUEST,
	});
	return { mailboxId, messageId };
}

/** The customer as a contact reachable by their address. */
export async function seedCustomer(t: T, email = CUSTOMER): Promise<Id<'contacts'>> {
	return await t.run(async (ctx) => {
		const contactId = await ctx.db.insert(
			'contacts',
			createTestContact({ email, firstName: 'Jonas', lastName: 'Berg', language: 'en' })
		);
		await ctx.db.insert(
			'contactIdentities',
			createTestContactIdentity({ contactId, identifier: email })
		);
		return contactId;
	});
}

/** A Files row with real bytes, optionally linked to contacts. */
export async function seedFile(
	t: T,
	opts: { filename: string; contactIds?: Id<'contacts'>[]; bytes?: string }
): Promise<Id<'semanticFiles'>> {
	return await t.run(async (ctx) => {
		const storageId = await ctx.storage.store(
			new Blob([opts.bytes ?? `%PDF ${opts.filename}`], { type: 'application/pdf' })
		);
		const now = Date.now();
		return await ctx.db.insert('semanticFiles', {
			storageId,
			filename: opts.filename,
			mimeType: 'application/pdf',
			fileSize: 20,
			sourceType: 'upload',
			version: 1,
			embedding: [],
			...(opts.contactIds ? { contactIds: opts.contactIds } : {}),
			createdAt: now,
			updatedAt: now,
		});
	});
}

/**
 * An attachment of a message in `mailboxId`, indexed in `mailAttachments` and
 * cut out as a stored part, the way MX delivery leaves it.
 */
export async function seedMailAttachment(
	t: T,
	mailboxId: Id<'mailboxes'>,
	filename: string
): Promise<Id<'mailAttachments'>> {
	const messageId = await seedMessage(t, mailboxId, {
		subject: `Files: ${filename}`,
		fromAddress: OWNER_ADDRESS,
		attachments: [{ filename, contentType: 'application/pdf', size: 20, partIndex: '0' }],
	});
	return await t.run(async (ctx) => {
		const message = (await ctx.db.get(messageId))!;
		const partId = await ctx.storage.store(
			new Blob([`%PDF ${filename}`], { type: 'application/pdf' })
		);
		await ctx.db.insert('mailMessageParts', {
			rawStorageId: message.rawStorageId,
			status: 'stored',
			parts: [{ filename, contentType: 'application/pdf', size: 20, storageId: partId }],
			createdAt: Date.now(),
		});
		return await ctx.db.insert('mailAttachments', {
			mailboxId,
			messageId,
			filename,
			contentType: 'application/pdf',
			size: 20,
			receivedAt: message.receivedAt,
			fromAddress: OWNER_ADDRESS,
			partIndex: '0',
		});
	});
}

/** A fresh browser upload owned by `userId`, not yet bound to anything. */
export async function seedUpload(
	t: T,
	opts: { userId?: string; filename?: string } = {}
): Promise<Id<'_storage'>> {
	return await t.run(async (ctx) => {
		const storageId = await ctx.storage.store(
			new Blob([`%PDF ${opts.filename ?? 'upload.pdf'}`], { type: 'application/pdf' })
		);
		await ctx.db.insert('storageUploads', {
			userId: opts.userId ?? 'user-a',
			organizationId: ORG,
			status: 'uploaded',
			storageId,
			expiresAt: Date.now() + 60 * 60 * 1000,
		});
		return storageId;
	});
}
