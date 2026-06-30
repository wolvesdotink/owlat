/**
 * PR-45: vacation auto-reply must not backscatter to bounces / DSNs.
 *
 * `mail.delivery.deliverToMailbox` schedules `mail.deliveryHooks.runPostDelivery`,
 * which fires the mailbox's vacation responder. RFC 3834 §2 / RFC 5321 §4.5.5
 * forbid auto-replying to a message with a null SMTP return-path (MAIL FROM:<>) —
 * the envelope of a bounce/DSN. The loop guard keys off the *envelope*
 * return-path threaded from the MTA, NOT the spoofable `From:` header, so a DSN
 * arriving with `From: MAILER-DAEMON` and no `Auto-Submitted` header is skipped.
 *
 * This pins the Convex end of that pipeline end to end: deliver → scheduled
 * post-delivery hook → (no) MTA /send call + (no) vacation-log write.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { DatabaseWriter } from '../_generated/server';
import type { Id } from '../_generated/dataModel';

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('agentSecurity') &&
			!path.includes('llmProvider'),
	),
);

async function insertMailbox(ctx: { db: DatabaseWriter }): Promise<Id<'mailboxes'>> {
	const now = Date.now();
	return ctx.db.insert('mailboxes', {
		userId: 'test-user',
		organizationId: 'test-org',
		address: 'me@example.com',
		domain: 'example.com',
		status: 'active',
		usedBytes: 0,
		uidValidity: now,
		createdAt: now,
		updatedAt: now,
	});
}

async function insertInbox(
	ctx: { db: DatabaseWriter },
	mailboxId: Id<'mailboxes'>,
): Promise<Id<'mailFolders'>> {
	const now = Date.now();
	return ctx.db.insert('mailFolders', {
		mailboxId,
		name: 'INBOX',
		role: 'inbox',
		uidValidity: now,
		uidNext: 1,
		highestModseq: 1,
		totalCount: 0,
		unseenCount: 0,
		subscribed: true,
		createdAt: now,
		updatedAt: now,
	});
}

async function enableResponder(
	ctx: { db: DatabaseWriter },
	mailboxId: Id<'mailboxes'>,
): Promise<void> {
	const now = Date.now();
	await ctx.db.insert('mailVacationResponders', {
		mailboxId,
		isEnabled: true,
		subject: 'Out of office',
		bodyText: 'I am away.',
		replyIntervalDays: 7,
		createdAt: now,
		updatedAt: now,
	});
}

interface DeliverArgs {
	messageId: string;
	from: string;
	returnPath?: string;
	references?: string;
}

/**
 * Deliver, then drain the `runAfter(0)`-scheduled post-delivery hook. The hook
 * is a Node action, so convex-test runs it under fake timers +
 * finishAllScheduledFunctions.
 */
async function deliverAndDrain(
	t: ReturnType<typeof convexTest>,
	rawStorageId: Id<'_storage'>,
	args: DeliverArgs,
): Promise<void> {
	vi.useFakeTimers();
	try {
		await t.mutation(internal.mail.delivery.deliverToMailbox, {
			rawStorageId,
			rawSize: 1,
			recipientAddress: 'me@example.com',
			from: args.from,
			returnPath: args.returnPath,
			to: ['me@example.com'],
			cc: [],
			bcc: [],
			subject: 'hello',
			textBodyInline: 'hi',
			snippet: 'hi',
			receivedAt: Date.now(),
			attachments: [],
			messageId: args.messageId,
			references: args.references,
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers);
	} finally {
		vi.useRealTimers();
	}
}

interface SendBody {
	from: string;
	to: string;
	subject: string;
	headers: Record<string, string>;
}

/** Spy on global fetch; return the captured /send POST url + parsed body. */
function captureSend() {
	const calls: Array<{ url: string; body: SendBody }> = [];
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
		calls.push({
			url: String(url),
			body: JSON.parse(String((init as RequestInit | undefined)?.body ?? '{}')) as SendBody,
		});
		return new Response('{}', { status: 200 });
	});
	return calls;
}

beforeEach(() => {
	// getMtaConfig() resolves from these — present so the hook *would* call /send
	// if it weren't suppressed (the suppression is what we're testing).
	vi.stubEnv('MTA_INTERNAL_URL', 'https://mta.test');
	vi.stubEnv('MTA_API_KEY', 'secret');
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe('vacation auto-reply — null-return-path bounce suppression (PR-45)', () => {
	it('does NOT auto-reply to a DSN (null envelope return-path, From: MAILER-DAEMON)', async () => {
		const t = convexTest(schema, modules);
		const calls = captureSend();

		let mailboxId!: Id<'mailboxes'>;
		let rawStorageId!: Id<'_storage'>;
		await t.run(async (ctx) => {
			mailboxId = await insertMailbox(ctx);
			await insertInbox(ctx, mailboxId);
			await enableResponder(ctx, mailboxId);
			rawStorageId = await ctx.storage.store(new Blob(['x']));
		});

		await deliverAndDrain(t, rawStorageId, {
			messageId: '<dsn-1@mx.isp.example>',
			// Spoofable header looks like a daemon but is otherwise a plain From
			// with no Auto-Submitted — isAutomatedMail does NOT catch it.
			from: 'MAILER-DAEMON@mx.isp.example',
			// Null SMTP return-path (MAIL FROM:<>) — the actual bounce signal.
			returnPath: '',
		});

		// No MTA /send call: the auto-reply (and any forward) was suppressed.
		expect(calls).toHaveLength(0);
		// And no vacation-log row was written (internalRecordReply not reached).
		await t.run(async (ctx: { db: DatabaseWriter }) => {
			const log = await ctx.db.query('mailVacationLog').collect();
			expect(log).toHaveLength(0);
		});
	});

	it('does NOT auto-reply when there is no From address to reply to', async () => {
		const t = convexTest(schema, modules);
		const calls = captureSend();

		let mailboxId!: Id<'mailboxes'>;
		let rawStorageId!: Id<'_storage'>;
		await t.run(async (ctx) => {
			mailboxId = await insertMailbox(ctx);
			await insertInbox(ctx, mailboxId);
			await enableResponder(ctx, mailboxId);
			rawStorageId = await ctx.storage.store(new Blob(['x']));
		});

		await deliverAndDrain(t, rawStorageId, {
			messageId: '<no-from-1@mx.isp.example>',
			from: '',
			returnPath: 'someone@isp.example',
		});

		expect(calls).toHaveLength(0);
		await t.run(async (ctx: { db: DatabaseWriter }) => {
			expect(await ctx.db.query('mailVacationLog').collect()).toHaveLength(0);
		});
	});

	it('DOES auto-reply to a normal message with a real envelope return-path', async () => {
		const t = convexTest(schema, modules);
		const calls = captureSend();

		let mailboxId!: Id<'mailboxes'>;
		let rawStorageId!: Id<'_storage'>;
		await t.run(async (ctx) => {
			mailboxId = await insertMailbox(ctx);
			await insertInbox(ctx, mailboxId);
			await enableResponder(ctx, mailboxId);
			rawStorageId = await ctx.storage.store(new Blob(['x']));
		});

		await deliverAndDrain(t, rawStorageId, {
			messageId: '<human-1@isp.example>',
			from: 'alice@isp.example',
			returnPath: 'alice@isp.example',
		});

		// Positive control: the responder fired (one /send) and logged the reply.
		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe('https://mta.test/send');
		await t.run(async (ctx: { db: DatabaseWriter }) => {
			const log = await ctx.db.query('mailVacationLog').collect();
			expect(log).toHaveLength(1);
			expect(log[0]!.senderEmail).toBe('alice@isp.example');
		});
	});
});

/**
 * PR-47: the vacation auto-reply must thread onto the triggering message and be
 * addressed to the envelope return-path.
 *
 * RFC 3834 §3.1.5/§3.1.6 require the responder to carry `In-Reply-To` and
 * `References` pointing at the message it answers, so it lands inside the
 * original thread rather than orphaning a new one. RFC 3834 §4 requires the
 * response to go to the envelope return-path (RFC 5321 MAIL FROM), not the
 * spoofable `From:` header. Before the fix the responder sent to the `From:`
 * header, omitted the threading headers, and emitted a non-standard
 * `Precedence: auto_reply`.
 */
describe('vacation auto-reply — threading + envelope return-path (PR-47)', () => {
	it('threads In-Reply-To/References to the triggering message and replies to the envelope return-path', async () => {
		const t = convexTest(schema, modules);
		const calls = captureSend();

		let mailboxId!: Id<'mailboxes'>;
		let rawStorageId!: Id<'_storage'>;
		await t.run(async (ctx) => {
			mailboxId = await insertMailbox(ctx);
			await insertInbox(ctx, mailboxId);
			await enableResponder(ctx, mailboxId);
			rawStorageId = await ctx.storage.store(new Blob(['x']));
		});

		const triggeringMsgId = '<original-msg-id@isp.example>';
		const priorRef = '<thread-root@isp.example>';
		await deliverAndDrain(t, rawStorageId, {
			messageId: triggeringMsgId,
			// `From:` header and envelope return-path deliberately DIFFER, so we can
			// assert the reply goes to the envelope (return-path), not `From:`.
			from: 'alice-display@isp.example',
			returnPath: 'bounce+alice@isp.example',
			references: priorRef,
		});

		expect(calls).toHaveLength(1);
		const body = calls[0]!.body;

		// RFC 3834 §3.1.5: In-Reply-To is the triggering Message-Id.
		expect(body.headers['In-Reply-To']).toBe(triggeringMsgId);
		// RFC 3834 §3.1.6 / RFC 5322 §3.6.4: References contains the triggering id
		// (and preserves the prior chain).
		expect(body.headers['References']).toContain(triggeringMsgId);
		expect(body.headers['References']).toContain(priorRef);

		// RFC 3834 §4: addressed to the envelope return-path, NOT the `From:` header.
		expect(body.to).toBe('bounce+alice@isp.example');
		expect(body.to).not.toBe('alice-display@isp.example');

		// RFC 3834 §5: a recognized auto-reply marker, and the non-standard
		// `Precedence: auto_reply` is gone.
		expect(body.headers['Auto-Submitted']).toBe('auto-replied');
		expect(body.headers['Precedence']).toBeUndefined();
	});

	it('falls back to the From header when the envelope was not threaded (legacy MTA)', async () => {
		const t = convexTest(schema, modules);
		const calls = captureSend();

		let mailboxId!: Id<'mailboxes'>;
		let rawStorageId!: Id<'_storage'>;
		await t.run(async (ctx) => {
			mailboxId = await insertMailbox(ctx);
			await insertInbox(ctx, mailboxId);
			await enableResponder(ctx, mailboxId);
			rawStorageId = await ctx.storage.store(new Blob(['x']));
		});

		await deliverAndDrain(t, rawStorageId, {
			messageId: '<legacy-1@isp.example>',
			from: 'carol@isp.example',
			// returnPath omitted → undefined (legacy build that didn't thread it).
		});

		expect(calls).toHaveLength(1);
		// No envelope return-path → reply to the From header.
		expect(calls[0]!.body.to).toBe('carol@isp.example');
		expect(calls[0]!.body.headers['In-Reply-To']).toBe('<legacy-1@isp.example>');
	});
});
