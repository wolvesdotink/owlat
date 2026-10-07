/**
 * Delivery enqueues interpretation (SPEC §5 "Postbox", `afterInsert.ts` →
 * `enqueue.ts`): wider than the Reply Queue, never twice for one message,
 * never for backfill, spam or a muted thread, and the brief reads pending.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import schema from '../../../schema';
import type { Doc, Id } from '../../../_generated/dataModel';
import type { MutationCtx } from '../../../_generated/server';
import { insertDeliveredMessage } from '../../deliveryPipeline/insert';
import {
	runPostInsertInboundEffects,
	type InboundOrigin,
} from '../../deliveryPipeline/afterInsert';
import { seedFolder, seedMailbox, type SeededFolderRole } from '../../__tests__/helpers.testlib';
import { modules, type Test } from './interpret.testlib';

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

async function deliver(
	ctx: RunCtx,
	mailboxId: Id<'mailboxes'>,
	opts: {
		role?: SeededFolderRole;
		origin: InboundOrigin;
		messageId?: string;
		inReplyTo?: string;
		antiLoopHeaders?: Record<string, string>;
	}
): Promise<Doc<'mailMessages'>> {
	const mailbox = (await ctx.db.get(mailboxId))!;
	const folder = await folderOf(ctx, mailboxId, opts.role ?? 'inbox');
	const id = await insertDeliveredMessage(ctx, {
		mailbox,
		folder,
		rawStorageId: await ctx.storage.store(new Blob(['raw'])),
		rawSize: 3,
		from: 'Sam <sam@acme.test>',
		to: [mailbox.address],
		cc: [],
		bcc: [],
		subject: 'Friday?',
		textBodyInline: 'Can you confirm Friday works?',
		messageId: opts.messageId ?? '<m1@acme.test>',
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

async function outcome(t: Test, threadId: Id<'mailThreads'>) {
	return t.run(async (ctx) => ({
		jobs: (await ctx.db.system.query('_scheduled_functions').collect()).map((job) => ({
			name: job.name,
			args: job.args[0] as Record<string, unknown>,
		})),
		brief: await ctx.db
			.query('threadBriefs')
			.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
			.first(),
	}));
}

const interpretJobs = (jobs: { name: string }[]) =>
	jobs.filter((job) => job.name.includes('interpret/run'));

async function seed(t: Test, roles: SeededFolderRole[] = ['inbox']) {
	const mailboxId = await seedMailbox(t, { address: 'me@owlat.test' });
	for (const role of roles) await seedFolder(t, mailboxId, role);
	return mailboxId;
}

describe('delivery → interpretation', () => {
	it('an inbox delivery hands the message to the needs-reply classify, not a second run', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seed(t);
		const message = await t.run(async (ctx) => deliver(ctx, mailboxId, { origin: 'mx' }));

		const { jobs, brief } = await outcome(t, message.threadId);
		const classify = jobs.find((job) => job.name.includes('needsReplyClassify'));
		expect(classify?.args.interpretMessageId).toBe(message._id);
		expect(interpretJobs(jobs)).toEqual([]);
		expect(brief?.completeness).toBe('pending');
	});

	it('live mail outside the inbox is scheduled on its own, with the ingest headers', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seed(t, ['inbox', 'archive']);
		const message = await t.run(async (ctx) =>
			deliver(ctx, mailboxId, {
				origin: 'sync',
				role: 'archive',
				antiLoopHeaders: { precedence: 'bulk', 'list-id': '<news.acme.test>' },
			})
		);

		const { jobs, brief } = await outcome(t, message.threadId);
		expect(jobs.some((job) => job.name.includes('needsReplyClassify'))).toBe(false);
		expect(interpretJobs(jobs).map((job) => job.args)).toEqual([
			{
				source: { kind: 'mail', id: message._id },
				isLive: true,
				precedence: 'bulk',
				listId: '<news.acme.test>',
			},
		]);
		expect(brief?.completeness).toBe('pending');
	});

	it('a backfill is history: nothing is scheduled and no brief row appears', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seed(t);
		const message = await t.run(async (ctx) => deliver(ctx, mailboxId, { origin: 'backfill' }));

		const { jobs, brief } = await outcome(t, message.threadId);
		expect(interpretJobs(jobs)).toEqual([]);
		expect(jobs.some((job) => job.name.includes('needsReplyClassify'))).toBe(false);
		expect(brief).toBeNull();
	});

	it('spam is not interpreted', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seed(t, ['inbox', 'spam']);
		const message = await t.run(async (ctx) =>
			deliver(ctx, mailboxId, { origin: 'mx', role: 'spam' })
		);

		const { jobs, brief } = await outcome(t, message.threadId);
		expect(interpretJobs(jobs)).toEqual([]);
		expect(brief).toBeNull();
	});

	it('a muted thread is not interpreted', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seed(t, ['inbox', 'archive']);
		const first = await t.run(async (ctx) => deliver(ctx, mailboxId, { origin: 'backfill' }));
		await t.run(async (ctx) => {
			await ctx.db.patch(first.threadId, { mutedAt: Date.now() });
		});

		const reply = await t.run(async (ctx) =>
			deliver(ctx, mailboxId, {
				origin: 'mx',
				messageId: '<m2@acme.test>',
				inReplyTo: '<m1@acme.test>',
			})
		);

		expect(reply.threadId).toBe(first.threadId);
		const { jobs, brief } = await outcome(t, reply.threadId);
		expect(interpretJobs(jobs)).toEqual([]);
		expect(jobs.some((job) => job.name.includes('needsReplyClassify'))).toBe(false);
		expect(brief).toBeNull();
	});
});
