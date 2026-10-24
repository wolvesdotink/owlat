/**
 * The one mailbox the IMAP wire fixtures describe
 * (`@owlat/worker-protocol/wireFixtures`, `IMAP_WIRE_FIXTURES`), seeded row for
 * row, and the bindings from each fixture placeholder to the id it got here.
 */

import { pbkdf2Sync } from 'node:crypto';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { convexTest, type TestConvex } from 'convex-test';
import {
	IMAP_FIXTURE_ENVELOPE_1,
	IMAP_FIXTURE_ENVELOPE_2,
	IMAP_FIXTURE_FOLDERS,
	IMAP_WIRE_IDS,
} from '@owlat/worker-protocol/wireFixtures';
import type { Id } from '../../_generated/dataModel';
import schema from '../../schema';
import { enableFeatures } from '../../__tests__/factories';
import { modules } from './helpers.testlib';

export const IMAP_FIXTURE_ADDRESS = 'fixture@owlat.example';
export const IMAP_FIXTURE_PASSWORD = 'ABCDEFGHJKLMNPQR';

export interface ImapWireWorld {
	readonly t: TestConvex<typeof schema>;
	readonly mailboxId: Id<'mailboxes'>;
	readonly folders: Record<'inbox' | 'sent' | 'receipts' | 'gone', Id<'mailFolders'>>;
	readonly messages: Record<'one' | 'two' | 'gone', Id<'mailMessages'>>;
	/** Placeholder → the id or value this deployment minted for it. */
	readonly ids: Record<string, string>;
}

/** The fixture's PBKDF2 encoding (`<salt-hex>:<hash-hex>`), as `appPasswords.generate` stores it. */
function hashFixturePassword(cleartext: string): string {
	const salt = Buffer.alloc(16, 7);
	const hash = pbkdf2Sync(cleartext, salt, 100_000, 32, 'sha256');
	return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export async function seedImapWireWorld(): Promise<ImapWireWorld> {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	await enableFeatures(t, ['mail.external']);
	const seeded = await t.run(async (ctx) => {
		const now = Date.now();
		const mailboxId = await ctx.db.insert('mailboxes', {
			userId: 'user-fixture',
			organizationId: 'org-fixture',
			address: IMAP_FIXTURE_ADDRESS,
			domain: 'owlat.example',
			status: 'active',
			usedBytes: 0,
			uidValidity: 1_700_000_000,
			createdAt: now,
			updatedAt: now,
		});
		const appPasswordId = await ctx.db.insert('mailAppPasswords', {
			mailboxId,
			userId: 'user-fixture',
			label: 'Fixture client',
			passwordHash: hashFixturePassword(IMAP_FIXTURE_PASSWORD),
			passwordPrefix: IMAP_FIXTURE_PASSWORD.slice(0, 4).toLowerCase(),
			scopes: ['imap', 'smtp'],
			createdAt: now,
		});
		const folder = async (
			fields: (typeof IMAP_FIXTURE_FOLDERS)[keyof typeof IMAP_FIXTURE_FOLDERS],
			extra: { parentId?: Id<'mailFolders'>; subscribed: boolean }
		) => {
			const { _id: _placeholder, ...rest } = fields;
			return await ctx.db.insert('mailFolders', {
				mailboxId,
				...rest,
				...extra,
				createdAt: now,
				updatedAt: now,
			});
		};
		const inbox = await folder(IMAP_FIXTURE_FOLDERS.inbox, { subscribed: true });
		const sent = await folder(IMAP_FIXTURE_FOLDERS.sent, { subscribed: true });
		const receipts = await folder(IMAP_FIXTURE_FOLDERS.receipts, {
			parentId: inbox,
			subscribed: false,
		});
		const gone = await folder(IMAP_FIXTURE_FOLDERS.sent, { subscribed: true });
		await ctx.db.delete(gone);

		const message = async (
			envelope: typeof IMAP_FIXTURE_ENVELOPE_1 | typeof IMAP_FIXTURE_ENVELOPE_2,
			folderId: Id<'mailFolders'>
		) => {
			const { _id: _placeholder, ...fields } = envelope;
			const threadId = await ctx.db.insert('mailThreads', {
				mailboxId,
				normalizedSubject: fields.subject,
				participants: [fields.fromAddress],
				messageCount: 1,
				unreadCount: fields.flagSeen ? 0 : 1,
				hasFlagged: fields.flagFlagged,
				hasAttachments: fields.hasAttachments,
				lastMessageAt: fields.internalDate,
				firstMessageAt: fields.internalDate,
				latestSnippet: fields.subject,
				latestFromAddress: fields.fromAddress,
				latestSubject: fields.subject,
				folderRoles: ['inbox'],
				labelIds: [],
				createdAt: now,
				updatedAt: now,
			});
			const rawStorageId = await ctx.storage.store(new Blob(['raw message']));
			return await ctx.db.insert('mailMessages', {
				...fields,
				mailboxId,
				folderId,
				threadId,
				normalizedSubject: fields.subject,
				snippet: fields.subject,
				rawStorageId,
				labelIds: [],
				receivedAt: fields.internalDate,
				createdAt: now,
				updatedAt: now,
			});
		};
		const one = await message(IMAP_FIXTURE_ENVELOPE_1, inbox);
		const two = await message(IMAP_FIXTURE_ENVELOPE_2, inbox);
		const goneMessage = await message(IMAP_FIXTURE_ENVELOPE_2, inbox);
		await ctx.db.delete(goneMessage);

		// INBOX's membership is maintained and current; Receipts' is still being built.
		const inboxMembership = await ctx.db.insert('mailFolderMembership', {
			folderId: inbox,
			isReady: true,
			revision: 7,
			cursor: null,
			startedAt: now,
			completedAt: now,
			updatedAt: now,
		});
		await ctx.db.insert('mailFolderUidBlocks', { folderId: inbox, firstUid: 1, uids: [1, 2] });
		const receiptsMembership = await ctx.db.insert('mailFolderMembership', {
			folderId: receipts,
			isReady: false,
			revision: 0,
			cursor: null,
			startedAt: now,
			updatedAt: now,
		});
		return {
			mailboxId,
			appPasswordId,
			folders: { inbox, sent, receipts, gone },
			messages: { one, two, gone: goneMessage },
			inboxVersion: `${inboxMembership}:7`,
			receiptsVersion: `${receiptsMembership}:0`,
		};
	});
	return {
		t,
		mailboxId: seeded.mailboxId,
		folders: seeded.folders,
		messages: seeded.messages,
		ids: {
			[IMAP_WIRE_IDS.mailbox]: seeded.mailboxId,
			[IMAP_WIRE_IDS.appPassword]: seeded.appPasswordId,
			[IMAP_WIRE_IDS.inbox]: seeded.folders.inbox,
			[IMAP_WIRE_IDS.sent]: seeded.folders.sent,
			[IMAP_WIRE_IDS.receipts]: seeded.folders.receipts,
			[IMAP_WIRE_IDS.goneFolder]: seeded.folders.gone,
			[IMAP_WIRE_IDS.message1]: seeded.messages.one,
			[IMAP_WIRE_IDS.message2]: seeded.messages.two,
			[IMAP_WIRE_IDS.goneMessage]: seeded.messages.gone,
			[IMAP_WIRE_IDS.inboxMembership]: seeded.inboxVersion,
			[IMAP_WIRE_IDS.receiptsMembership]: seeded.receiptsVersion,
		},
	};
}
