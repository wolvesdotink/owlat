/** One-time codes and sign-in links read at arrival (mail/signInCodes.ts). */

import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { modules } from '../../__tests__/testModulesWithoutNodeActions';
import { extractSignInCode, SIGN_IN_CODE_TTL_MS } from '../signInCodes';

const CODE_TEXT =
	'Hi,\n\nUse this code to sign in to your Northwind account:\n\n482913\n\nThe code expires in 10 minutes.';
const LINK_TEXT =
	'Click the link below to sign in to Fabrikam.\n\nhttps://app.fabrikam.example/login/magic?token=7f3a9c2e41\n\nHelp: https://fabrikam.example/help';

describe('extractSignInCode', () => {
	const from = { fromDomain: 'northwind.example' };

	it('reads a code on its own line', () => {
		expect(
			extractSignInCode({ ...from, subject: 'Your Northwind verification code', text: CODE_TEXT })
		).toEqual({ kind: 'code', value: '482913' });
	});

	it('reads a code after its keyword and in the subject', () => {
		expect(
			extractSignInCode({ ...from, subject: 'Sign in', text: 'Your login code: 482 913' })
		).toEqual({ kind: 'code', value: '482913' });
		expect(
			extractSignInCode({
				...from,
				subject: '771204 is your Northwind code',
				text: 'Welcome back.',
			})
		).toEqual({ kind: 'code', value: '771204' });
	});

	it('offers nothing when the message names two different codes', () => {
		expect(
			extractSignInCode({
				...from,
				subject: 'Your verification code',
				text: 'Your code is 482913.\n\n551200\n',
			})
		).toBeNull();
	});

	it('ignores coupon and discount codes', () => {
		expect(
			extractSignInCode({
				...from,
				subject: 'Your code inside',
				text: 'Use code SAVE20 for 20% off. Your code: 4821AB',
			})
		).toBeNull();
	});

	it('ignores mail that is not about a code', () => {
		expect(
			extractSignInCode({ ...from, subject: 'Order shipped', text: 'Order 482913 is on its way.' })
		).toBeNull();
	});

	it('reads the one sign-in link on the sender domain', () => {
		expect(
			extractSignInCode({
				fromDomain: 'fabrikam.example',
				subject: 'Your Fabrikam sign-in link',
				text: LINK_TEXT,
			})
		).toEqual({ kind: 'link', value: 'https://app.fabrikam.example/login/magic?token=7f3a9c2e41' });
	});

	it('reads a sign-in link from an HTML href', () => {
		expect(
			extractSignInCode({
				fromDomain: 'fabrikam.example',
				subject: 'Your Fabrikam sign-in link',
				text: 'Click the button to sign in.',
				html: '<a href="https://app.fabrikam.example/auth?a=1&amp;b=2">Sign in</a>',
			})
		).toEqual({ kind: 'link', value: 'https://app.fabrikam.example/auth?a=1&b=2' });
	});

	it('offers no link that points off the sender domain', () => {
		expect(
			extractSignInCode({
				fromDomain: 'fabrikam.example',
				subject: 'Your Fabrikam sign-in link',
				text: 'https://fabrikam.example.attacker.test/login?token=1',
			})
		).toBeNull();
	});
});

type T = ReturnType<typeof convexTest>;

async function setup(t: T): Promise<Id<'_storage'>> {
	return t.run(async (ctx) => {
		const now = Date.now();
		const mailboxId = await ctx.db.insert('mailboxes', {
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
		for (const [name, role] of [
			['INBOX', 'inbox'],
			['Archive', 'archive'],
			['Spam', 'spam'],
		] as const) {
			await ctx.db.insert('mailFolders', {
				mailboxId,
				name,
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
		}
		return ctx.storage.store(new Blob(['x']));
	});
}

let seq = 0;

async function deliver(
	t: T,
	rawStorageId: Id<'_storage'>,
	overrides: Record<string, unknown> = {}
): Promise<Id<'mailMessages'>> {
	seq += 1;
	const result = await t.mutation(internal.mail.delivery.deliverToMailbox, {
		rawStorageId,
		rawSize: 1,
		recipientAddress: 'me@example.com',
		from: 'Northwind <security@northwind.example>',
		to: ['me@example.com'],
		cc: [],
		bcc: [],
		subject: 'Your Northwind verification code',
		textBodyInline: CODE_TEXT,
		messageId: `<code-${seq}@northwind.example>`,
		receivedAt: Date.now(),
		attachments: [],
		spfResult: 'pass',
		dkimResult: 'pass',
		dmarcResult: 'pass',
		envelopeFromDomain: 'northwind.example',
		dkimSigningDomain: 'northwind.example',
		...overrides,
	});
	if (!('messageId' in result)) throw new Error('not delivered');
	return result.messageId;
}

const signInCodeOf = (t: T, id: Id<'mailMessages'>) =>
	t.run(async (ctx) => (await ctx.db.get(id))?.signInCode ?? null);

describe('recordSignInCode at delivery', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('stores the code of authenticated mail with its expiry and schedules the clear', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const raw = await setup(t);
		const receivedAt = Date.now();
		const id = await deliver(t, raw, { receivedAt });

		expect(await signInCodeOf(t, id)).toEqual({
			kind: 'code',
			value: '482913',
			senderDomain: 'northwind.example',
			expiresAt: receivedAt + SIGN_IN_CODE_TTL_MS,
		});
		const jobs = await t.run(async (ctx) =>
			(await ctx.db.system.query('_scheduled_functions').collect()).filter(
				(job) => job.name === 'mail/signInCodes:expireSignInCode'
			)
		);
		expect(jobs.map((job) => [job.scheduledTime, job.args[0]])).toEqual([
			[receivedAt + SIGN_IN_CODE_TTL_MS, { messageId: id }],
		]);
	});

	it('accepts a DKIM signature aligned with the From domain when DMARC did not pass', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const raw = await setup(t);
		const id = await deliver(t, raw, {
			dmarcResult: 'none',
			dkimSigningDomain: 'mail.northwind.example',
		});
		expect((await signInCodeOf(t, id))?.value).toBe('482913');
	});

	it.each([
		['DMARC failed', { dmarcResult: 'fail', dkimResult: 'fail' }],
		['DKIM signed by another domain', { dmarcResult: 'none', dkimSigningDomain: 'mailer.test' }],
		['no verdicts at all', { spfResult: undefined, dkimResult: undefined, dmarcResult: undefined }],
		['list mail', { unsubscribe: { httpUrl: 'https://northwind.example/u', oneClick: true } }],
		['received over 15 minutes ago', { receivedAt: Date.now() - SIGN_IN_CODE_TTL_MS - 1 }],
	])('stores nothing for %s', async (_label, overrides) => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const raw = await setup(t);
		const id = await deliver(t, raw, overrides);
		expect(await signInCodeOf(t, id)).toBeNull();
	});

	it('stores nothing for the mailbox owner’s own mail', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const raw = await setup(t);
		const id = await deliver(t, raw, {
			from: 'me@example.com',
			dkimSigningDomain: 'example.com',
		});
		expect(await signInCodeOf(t, id)).toBeNull();
	});

	it('clears the code once it expired, not before', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const raw = await setup(t);
		const receivedAt = Date.now();
		const id = await deliver(t, raw, { receivedAt });

		vi.setSystemTime(receivedAt + SIGN_IN_CODE_TTL_MS - 1);
		await t.mutation(internal.mail.signInCodes.expireSignInCode, { messageId: id });
		expect(await signInCodeOf(t, id)).not.toBeNull();

		vi.setSystemTime(receivedAt + SIGN_IN_CODE_TTL_MS);
		await t.mutation(internal.mail.signInCodes.expireSignInCode, { messageId: id });
		expect(await signInCodeOf(t, id)).toBeNull();
	});

	it('does not carry the code into an IMAP COPY', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const raw = await setup(t);
		const id = await deliver(t, raw);
		const folders = await t.run((ctx) => ctx.db.query('mailFolders').collect());
		const inbox = folders.find((f) => f.role === 'inbox');
		const archive = folders.find((f) => f.role === 'archive');
		if (!inbox || !archive) throw new Error('folders missing');
		await t.mutation(internal.mail.imap.move.copyMessages, {
			sourceFolderId: inbox._id,
			targetFolderId: archive._id,
			messageIds: [id],
		});
		const copy = await t.run((ctx) =>
			ctx.db
				.query('mailMessages')
				.withIndex('by_folder_and_uid', (q) => q.eq('folderId', archive._id))
				.first()
		);
		expect(copy?.subject).toBe('Your Northwind verification code');
		expect(copy?.signInCode).toBeUndefined();
	});
});
