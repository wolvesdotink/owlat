/**
 * Our reply sent from another client is interpreted like an Owlat send
 * (`enqueue.ts#enqueueClientSentInterpretation`), so the brief items it
 * answered close and leave the Workbench's To do. Its Sent copy arrives
 * through mail sync or a desktop client's IMAP APPEND; a backfill, an old
 * APPENDed copy, an auto-reply, a draft and a muted thread are not read.
 */

import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import schema from '../../../schema';
import { internal } from '../../../_generated/api';
import type { Doc, Id } from '../../../_generated/dataModel';
import type { MutationCtx } from '../../../_generated/server';
import { insertDeliveredMessage } from '../../deliveryPipeline/insert';
import {
	runPostInsertInboundEffects,
	type InboundOrigin,
} from '../../deliveryPipeline/afterInsert';
import { LIVE_SENT_COPY_MAX_AGE_MS } from '../../imap/append';
import { seedFolder, seedMailbox, type SeededFolderRole } from '../../__tests__/helpers.testlib';
import { modules, type Test } from './interpret.testlib';

const OWNER = 'me@owlat.test';
const SENDER = 'sam@acme.test';

type RunCtx = Parameters<Parameters<Test['run']>[0]>[0];

async function folderOf(
	ctx: MutationCtx,
	mailboxId: Id<'mailboxes'>,
	role: SeededFolderRole
): Promise<Doc<'mailFolders'>> {
	const folder = await ctx.db
		.query('mailFolders')
		.withIndex('by_mailbox_and_role', (q) => q.eq('mailboxId', mailboxId).eq('role', role))
		.first();
	if (!folder) throw new Error(`no ${role}`);
	return folder;
}

/** One message through the ingest tail mail sync and MX delivery share. */
async function deliver(
	ctx: RunCtx,
	mailboxId: Id<'mailboxes'>,
	opts: {
		role: SeededFolderRole;
		origin: InboundOrigin;
		from: string;
		to: string;
		messageId: string;
		inReplyTo?: string;
		antiLoopHeaders?: Record<string, string>;
	}
): Promise<Doc<'mailMessages'>> {
	const mailbox = (await ctx.db.get(mailboxId))!;
	const folder = await folderOf(ctx, mailboxId, opts.role);
	const id = await insertDeliveredMessage(ctx, {
		mailbox,
		folder,
		rawStorageId: await ctx.storage.store(new Blob(['raw'])),
		rawSize: 3,
		from: opts.from,
		to: [opts.to],
		cc: [],
		bcc: [],
		subject: opts.inReplyTo ? 'Re: Friday?' : 'Friday?',
		textBodyInline: opts.inReplyTo ? 'Friday works.' : 'Can you confirm Friday works?',
		messageId: opts.messageId,
		...(opts.inReplyTo ? { inReplyTo: opts.inReplyTo } : {}),
		receivedAt: Date.now(),
		attachments: [],
		inboundOrigin: opts.origin,
	});
	await runPostInsertInboundEffects(ctx, {
		messageId: id,
		folder,
		origin: opts.origin,
		...(opts.antiLoopHeaders ? { antiLoopHeaders: opts.antiLoopHeaders } : {}),
	});
	return (await ctx.db.get(id))!;
}

async function seed(t: Test) {
	const mailboxId = await seedMailbox(t, { address: OWNER });
	for (const role of ['inbox', 'sent', 'drafts'] as const) await seedFolder(t, mailboxId, role);
	return mailboxId;
}

/** The asking mail, synced into the inbox. */
async function ask(t: Test, mailboxId: Id<'mailboxes'>) {
	return t.run(async (ctx) =>
		deliver(ctx, mailboxId, {
			role: 'inbox',
			origin: 'sync',
			from: `Sam <${SENDER}>`,
			to: OWNER,
			messageId: '<ask@acme.test>',
		})
	);
}

/** Our reply, synced from the provider's Sent folder. */
async function syncReply(
	t: Test,
	mailboxId: Id<'mailboxes'>,
	opts: { origin?: InboundOrigin; antiLoopHeaders?: Record<string, string> } = {}
) {
	return t.run(async (ctx) =>
		deliver(ctx, mailboxId, {
			role: 'sent',
			origin: opts.origin ?? 'sync',
			from: OWNER,
			to: SENDER,
			messageId: '<reply@owlat.test>',
			inReplyTo: '<ask@acme.test>',
			...(opts.antiLoopHeaders ? { antiLoopHeaders: opts.antiLoopHeaders } : {}),
		})
	);
}

/** Our reply, filed by a desktop client through IMAP APPEND. */
async function appendReply(
	t: Test,
	mailboxId: Id<'mailboxes'>,
	opts: { role?: 'sent' | 'drafts'; internalDate?: number; headerBlock?: string } = {}
): Promise<Doc<'mailMessages'>> {
	const { folderId, rawStorageId } = await t.run(async (ctx) => ({
		folderId: (await folderOf(ctx, mailboxId, opts.role ?? 'sent'))._id,
		rawStorageId: await ctx.storage.store(new Blob(['raw'])),
	}));
	const { messageId } = await t.mutation(internal.mail.imap.append.appendMessage, {
		folderId,
		rawStorageId,
		rawSize: 3,
		rfc822MessageId: 'reply@owlat.test',
		inReplyTo: 'ask@acme.test',
		references: ['ask@acme.test'],
		fromAddress: OWNER,
		toAddresses: [SENDER],
		ccAddresses: [],
		bccAddresses: [],
		subject: 'Re: Friday?',
		textBodyInline: 'Friday works.',
		...(opts.internalDate !== undefined ? { internalDate: opts.internalDate } : {}),
		flags: ['\\Seen'],
		...(opts.headerBlock ? { headerBlock: opts.headerBlock } : {}),
	});
	return t.run(async (ctx) => (await ctx.db.get(messageId))!);
}

/** The outbound interpretation runs scheduled so far, by source. */
async function outboundRuns(t: Test) {
	return t.run(async (ctx) =>
		(await ctx.db.system.query('_scheduled_functions').collect())
			.filter((job) => job.name.includes('outboundRun'))
			.map((job) => (job.args[0] as { source: unknown }).source)
	);
}

async function briefOf(t: Test, threadId: Id<'mailThreads'>) {
	return t.run(async (ctx) =>
		ctx.db
			.query('threadBriefs')
			.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
			.first()
	);
}

function harness(): Test {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	return t;
}

describe('our reply from another client → interpretation', () => {
	it('a reply synced live into Sent is read as our send, and the brief reads pending', async () => {
		const t = harness();
		const mailboxId = await seed(t);
		const asked = await ask(t, mailboxId);
		const reply = await syncReply(t, mailboxId);

		expect(reply.threadId).toBe(asked.threadId);
		expect(await outboundRuns(t)).toEqual([{ kind: 'outboundMail', id: reply._id }]);
		const snapshot = await t.run(async (ctx) =>
			ctx.db
				.query('interpretSources')
				.withIndex('by_source_key', (q) => q.eq('sourceKey', `outboundMail:${reply._id}`))
				.first()
		);
		expect(snapshot?.eligibility).toMatchObject({ isLive: true });
		expect((await briefOf(t, reply.threadId))?.completeness).toBe('pending');
	});

	it('a backfilled Sent copy is history: nothing is read', async () => {
		const t = harness();
		const mailboxId = await seed(t);
		await ask(t, mailboxId);
		await syncReply(t, mailboxId, { origin: 'backfill' });

		expect(await outboundRuns(t)).toEqual([]);
	});

	it('a vacation auto-reply in Sent answers nothing: nothing is read', async () => {
		const t = harness();
		const mailboxId = await seed(t);
		await ask(t, mailboxId);
		await syncReply(t, mailboxId, { antiLoopHeaders: { 'auto-submitted': 'auto-replied' } });

		expect(await outboundRuns(t)).toEqual([]);
	});

	it('a muted thread is not read', async () => {
		const t = harness();
		const mailboxId = await seed(t);
		const asked = await ask(t, mailboxId);
		await t.run(async (ctx) => {
			await ctx.db.patch(asked.threadId, { mutedAt: Date.now() });
		});
		await syncReply(t, mailboxId);

		expect(await outboundRuns(t)).toEqual([]);
	});

	it('a Sent copy a desktop client APPENDs right after sending is read as our send', async () => {
		const t = harness();
		const mailboxId = await seed(t);
		const asked = await ask(t, mailboxId);
		const reply = await appendReply(t, mailboxId, { internalDate: Date.now() - 60_000 });

		expect(reply.threadId).toBe(asked.threadId);
		expect(await outboundRuns(t)).toEqual([{ kind: 'outboundMail', id: reply._id }]);
		expect((await briefOf(t, reply.threadId))?.completeness).toBe('pending');
	});

	it('an APPENDed copy older than the live window is history: nothing is read', async () => {
		const t = harness();
		const mailboxId = await seed(t);
		await ask(t, mailboxId);
		await appendReply(t, mailboxId, {
			internalDate: Date.now() - LIVE_SENT_COPY_MAX_AGE_MS - 60_000,
		});

		expect(await outboundRuns(t)).toEqual([]);
	});

	it('an APPENDed draft or auto-reply is not read', async () => {
		const t = harness();
		const mailboxId = await seed(t);
		await ask(t, mailboxId);
		await appendReply(t, mailboxId, { role: 'drafts' });
		await appendReply(t, mailboxId, {
			headerBlock: 'Auto-Submitted: auto-replied\r\nSubject: Re: Friday?\r\n',
		});

		expect(await outboundRuns(t)).toEqual([]);
	});
});
