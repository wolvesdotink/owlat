/**
 * Fixtures for the rules lane tests: filters of every origin, the
 * arrival record, the rule operation log and an external sync delivery. The
 * personal mailbox and hosted delivery come from the senders fixtures.
 */

import type { Doc, Id } from '../../../_generated/dataModel';
import { internal } from '../../../_generated/api';
import type { T } from '../../senders/__tests__/senders.testlib';

export {
	deliverHosted,
	OWNER,
	roleOf,
	SENDER,
	seedPersonalMailbox,
	seedProfile,
	type Folders,
	type T,
} from '../../senders/__tests__/senders.testlib';

type FilterFields = Partial<Omit<Doc<'mailFilters'>, '_id' | '_creationTime'>>;

/** A filter row as stored; defaults to a plain-language rule matching the shop sender. */
export async function seedFilter(
	t: T,
	mailboxId: Id<'mailboxes'>,
	fields: FilterFields = {}
): Promise<Id<'mailFilters'>> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		return await ctx.db.insert('mailFilters', {
			mailboxId,
			name: 'rule',
			isEnabled: true,
			priority: 100,
			conditions: [{ field: 'from', op: 'contains', value: 'shop.example' }],
			actions: [{ type: 'markFlagged' }],
			stopProcessing: false,
			origin: 'plain_language',
			createdAt: now,
			updatedAt: now,
			...fields,
		});
	});
}

/** A user folder (no role). */
export async function seedUserFolder(
	t: T,
	mailboxId: Id<'mailboxes'>,
	name: string
): Promise<Id<'mailFolders'>> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		return await ctx.db.insert('mailFolders', {
			mailboxId,
			name,
			uidValidity: now,
			uidNext: 1,
			highestModseq: 1,
			totalCount: 0,
			unseenCount: 0,
			subscribed: true,
			createdAt: now,
			updatedAt: now,
		});
	});
}

export async function seedLabel(
	t: T,
	mailboxId: Id<'mailboxes'>,
	name = 'Finance'
): Promise<Id<'mailLabels'>> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		return await ctx.db.insert('mailLabels', { mailboxId, name, createdAt: now });
	});
}

export async function messageOf(t: T, id: Id<'mailMessages'>): Promise<Doc<'mailMessages'>> {
	return (await t.run(async (ctx) => await ctx.db.get(id)))!;
}

export async function recordOf(
	t: T,
	messageId: Id<'mailMessages'>
): Promise<Doc<'mailArrivalRecords'> | null> {
	return await t.run(
		async (ctx) =>
			await ctx.db
				.query('mailArrivalRecords')
				.withIndex('by_message', (q) => q.eq('messageId', messageId))
				.first()
	);
}

/** Every operation of the mailbox, oldest first, each with its change rows. */
export async function operationsOf(
	t: T,
	mailboxId: Id<'mailboxes'>
): Promise<(Doc<'mailArrivalOperations'> & { changes: Doc<'mailArrivalOperationChanges'>[] })[]> {
	return await t.run(async (ctx) => {
		const operations = await ctx.db
			.query('mailArrivalOperations')
			.withIndex('by_mailbox_created', (q) => q.eq('mailboxId', mailboxId))
			.collect();
		const out = [];
		for (const operation of operations) {
			const changes = await ctx.db
				.query('mailArrivalOperationChanges')
				.withIndex('by_operation', (q) => q.eq('operationId', operation._id))
				.collect();
			out.push({ ...operation, changes });
		}
		return out;
	});
}

export async function delayedOf(
	t: T,
	messageId: Id<'mailMessages'>
): Promise<Doc<'mailDelayedActions'>[]> {
	return await t.run(
		async (ctx) =>
			await ctx.db
				.query('mailDelayedActions')
				.withIndex('by_message', (q) => q.eq('messageId', messageId))
				.collect()
	);
}

/** Commit R2 answers for one message through the internal mutation R2 uses. */
export async function answer(
	t: T,
	messageId: Id<'mailMessages'>,
	answers: { filterId: Id<'mailFilters'>; revision: number; answer: boolean | null }[]
): Promise<void> {
	await t.mutation(internal.mail.arrival.r2.commitArrivalAiAnswers, { messageId, answers });
}

/** Turn the code detector preference on for the fixture owner. */
export async function turnCodeDetectorOn(t: T): Promise<void> {
	await t.run(async (ctx) => {
		const now = Date.now();
		await ctx.db.insert('mailUserSettings', {
			userId: 'user-A',
			autoAdvance: 'next',
			isCodeAutoArchiveOn: true,
			createdAt: now,
			updatedAt: now,
		});
	});
}

/** An external (IMAP-synced) personal mailbox with its account and system folders. */
export async function seedExternalMailbox(t: T): Promise<{
	accountId: Id<'externalMailAccounts'>;
	mailboxId: Id<'mailboxes'>;
	folders: Record<'inbox' | 'archive' | 'sent' | 'trash', Id<'mailFolders'>>;
}> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		const mailboxId = await ctx.db.insert('mailboxes', {
			userId: 'user-A',
			organizationId: 'org-1',
			address: 'me@gmail.example',
			domain: 'gmail.example',
			kind: 'external',
			status: 'active',
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
		const folder = async (role: 'inbox' | 'archive' | 'sent' | 'trash') =>
			await ctx.db.insert('mailFolders', {
				mailboxId,
				name: role.toUpperCase(),
				role,
				uidValidity: now,
				uidNext: 1,
				highestModseq: 1,
				totalCount: 0,
				unseenCount: 0,
				subscribed: true,
				createdAt: now,
				updatedAt: now,
			});
		const folders = {
			inbox: await folder('inbox'),
			archive: await folder('archive'),
			sent: await folder('sent'),
			trash: await folder('trash'),
		};
		const accountId = await ctx.db.insert('externalMailAccounts', {
			userId: 'user-A',
			organizationId: 'org-1',
			mailboxId,
			imapHost: 'imap.gmail.example',
			imapPort: 993,
			isImapSecure: true,
			smtpHost: 'smtp.gmail.example',
			smtpPort: 465,
			isSmtpSecure: true,
			authMethod: 'password' as const,
			imapUsername: 'me@gmail.example',
			secretCiphertext: 'x',
			secretIv: 'x',
			secretAuthTag: 'x',
			secretEnvelopeVersion: 1,
			status: 'connected' as const,
			createdAt: now,
			updatedAt: now,
		});
		await ctx.db.patch(mailboxId, { externalAccountId: accountId });
		return { accountId, mailboxId, folders };
	});
}

/** One forward-synced (or backfilled) message into the external Inbox. */
export async function ingestSynced(
	t: T,
	accountId: Id<'externalMailAccounts'>,
	opts: { origin?: 'sync' | 'backfill'; uid?: number; from?: string; subject?: string } = {}
): Promise<Id<'mailMessages'> | null> {
	const rawStorageId = await t.run(async (ctx) => await ctx.storage.store(new Blob(['raw'])));
	const uid = opts.uid ?? 42;
	const result = await t.mutation(internal.mail.external.delivery.ingestExternalMessage, {
		accountId,
		folderRole: 'inbox',
		remoteName: 'INBOX',
		remoteUid: uid,
		remoteUidValidity: 7,
		rawStorageId,
		rawSize: 3,
		from: opts.from ?? 'Shop <news@shop.example>',
		to: ['me@gmail.example'],
		cc: [],
		bcc: [],
		subject: opts.subject ?? 'Autumn sale',
		textBodyInline: 'Everything is on sale.',
		messageId: `<s${uid}@shop.example>`,
		receivedAt: Date.now(),
		attachments: [],
		origin: opts.origin ?? 'sync',
	});
	return 'messageId' in result ? result.messageId : null;
}
