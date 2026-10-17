/**
 * Fixtures for the Senders lane tests: a personal mailbox with its system
 * folders, a sender profile in any state, and one hosted MX delivery.
 */

import type { TestConvex } from 'convex-test';
import type { SenderStatus } from '@owlat/shared/arrival';
import type { Doc, Id } from '../../../_generated/dataModel';
import { internal } from '../../../_generated/api';
import type schema from '../../../schema';
import { seedFolder, seedMailbox, type SeededFolderRole } from '../../__tests__/helpers.testlib';
import { newSenderProfile } from '../profiles';

export type T = TestConvex<typeof schema>;
export type Folders = Record<SeededFolderRole, Id<'mailFolders'>>;

export const OWNER = 'me@owlat.test';
export const SENDER = 'news@shop.example';

const ROLES: SeededFolderRole[] = ['inbox', 'archive', 'trash', 'spam', 'sent'];

/** A personal (or shared) mailbox owned by `user-A` in `org-1`, every system folder seeded. */
export async function seedPersonalMailbox(
	t: T,
	opts: { scope?: 'shared' } = {}
): Promise<{ mailboxId: Id<'mailboxes'>; folders: Folders }> {
	const mailboxId = await seedMailbox(t, {
		userId: 'user-A',
		address: OWNER,
		...(opts.scope ? { scope: opts.scope } : {}),
	});
	const folders = {} as Folders;
	for (const role of ROLES) folders[role] = await seedFolder(t, mailboxId, role);
	return { mailboxId, folders };
}

/** A profile for `address` with the given status and counters. */
export async function seedProfile(
	t: T,
	mailboxId: Id<'mailboxes'>,
	opts: Partial<Doc<'mailSenderProfiles'>> & { address?: string; status?: SenderStatus } = {}
): Promise<Doc<'mailSenderProfiles'>> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		const id = await ctx.db.insert('mailSenderProfiles', {
			...newSenderProfile({ mailboxId, address: opts.address ?? SENDER, now }),
			...opts,
		});
		return (await ctx.db.get(id))!;
	});
}

/** One hosted MX delivery into the mailbox; returns the new message id or null when skipped. */
export async function deliverHosted(
	t: T,
	opts: {
		from?: string;
		subject?: string;
		id?: string;
		unsubscribe?: Doc<'mailMessages'>['unsubscribe'];
		spamVerdict?: 'spam';
	} = {}
): Promise<Id<'mailMessages'> | null> {
	const rawStorageId = await t.run(async (ctx) => await ctx.storage.store(new Blob(['raw'])));
	const result = await t.mutation(internal.mail.delivery.deliverToMailbox, {
		rawStorageId,
		rawSize: 3,
		recipientAddress: OWNER,
		from: opts.from ?? `Shop <${SENDER}>`,
		to: [OWNER],
		cc: [],
		bcc: [],
		subject: opts.subject ?? 'Autumn sale',
		textBodyInline: 'Everything is on sale.',
		snippet: 'Everything is on sale.',
		messageId: `<${opts.id ?? Math.random().toString(36).slice(2)}@shop.example>`,
		receivedAt: Date.now(),
		attachments: [],
		...(opts.unsubscribe ? { unsubscribe: opts.unsubscribe } : {}),
		...(opts.spamVerdict ? { spamVerdict: opts.spamVerdict, spamScore: 90 } : {}),
	});
	return 'messageId' in result ? result.messageId : null;
}

/** The role of the folder a message sits in. */
export async function roleOf(t: T, messageId: Id<'mailMessages'>): Promise<string | undefined> {
	return await t.run(async (ctx) => {
		const message = await ctx.db.get(messageId);
		return message ? (await ctx.db.get(message.folderId))?.role : undefined;
	});
}

export async function profileOf(
	t: T,
	mailboxId: Id<'mailboxes'>,
	address = SENDER
): Promise<Doc<'mailSenderProfiles'> | null> {
	return await t.run(async (ctx) => {
		const rows = await ctx.db
			.query('mailSenderProfiles')
			.withIndex('by_mailbox_last', (q) => q.eq('mailboxId', mailboxId))
			.collect();
		return rows.find((row) => row.address === address) ?? null;
	});
}
