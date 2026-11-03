/**
 * Brand logos for authenticated senders: what the cache schedules on
 * delivery, what a lookup commits, and which rows the list and reader reads
 * attach a logo to.
 */

import { convexTest } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import type { Doc, Id } from '../../_generated/dataModel';
import { modules, seedFolder, seedMailbox, seedMessage } from './helpers.testlib';
import { requestSenderLogo } from '../senderLogos/cache';

const sessionMocks = vi.hoisted(() => ({ getBetterAuthSessionWithRole: vi.fn() }));
vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return { ...actual, getBetterAuthSessionWithRole: sessionMocks.getBetterAuthSessionWithRole };
});

beforeEach(() => {
	sessionMocks.getBetterAuthSessionWithRole.mockResolvedValue({
		userId: 'test-user',
		role: 'owner',
		activeOrganizationId: 'test-org',
	});
});

type T = ReturnType<typeof convexTest>;
const DOMAIN = 'acme-bank.com';
const DAY_MS = 24 * 60 * 60 * 1000;

async function seedInbox(t: T): Promise<Id<'mailboxes'>> {
	const mailboxId = await seedMailbox(t, {
		userId: 'test-user',
		organizationId: 'test-org',
		address: 'me@example.com',
		domain: 'example.com',
	});
	await seedFolder(t, mailboxId, 'inbox');
	return mailboxId;
}

async function seedFromBank(
	t: T,
	mailboxId: Id<'mailboxes'>,
	verdict: Partial<Doc<'mailMessages'>>,
	subject: string
): Promise<Id<'mailMessages'>> {
	const id = await seedMessage(t, mailboxId, { subject, fromAddress: `alerts@${DOMAIN}` });
	await t.run((ctx) => ctx.db.patch(id, verdict));
	return id;
}

/** A found cache row for the bank, with a stored image. */
async function seedFoundLogo(t: T): Promise<void> {
	await t.run(async (ctx) => {
		const storageId = await ctx.storage.store(new Blob(['<svg/>'], { type: 'image/svg+xml' }));
		const now = Date.now();
		await ctx.db.insert('senderLogos', {
			domain: DOMAIN,
			status: 'found',
			source: 'bimi',
			storageId,
			requestedAt: now,
			checkedAt: now,
		});
	});
}

describe('sender logos on list and reader rows', () => {
	it('attaches the logo only to the message that passed DMARC', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedInbox(t);
		const passed = await seedFromBank(t, mailboxId, { dmarcResult: 'pass' }, 'Real');
		const spoofed = await seedFromBank(t, mailboxId, { dmarcResult: 'fail' }, 'Spoof');
		await seedFoundLogo(t);

		const { messages } = await t.query(api.mail.mailbox.queries.listMessages, {
			mailboxId,
			folderRole: 'inbox',
		});
		const byId = new Map(messages.map((m) => [m._id, m]));
		expect(byId.get(passed)?.senderLogoUrl).toMatch(/^https?:\/\//);
		expect(byId.get(spoofed)).not.toHaveProperty('senderLogoUrl');
	});

	it('attaches it in the reader reads too', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedInbox(t);
		const passed = await seedFromBank(t, mailboxId, { dmarcResult: 'pass' }, 'Real');
		await seedFoundLogo(t);

		const single = await t.query(api.mail.mailbox.messages.getMessage, { messageId: passed });
		expect(single?.senderLogoUrl).toMatch(/^https?:\/\//);
		const thread = await t.query(api.mail.mailbox.messages.listThreadMessages, {
			messageId: passed,
		});
		expect(thread?.messages[0]?.senderLogoUrl).toMatch(/^https?:\/\//);
	});

	it('attaches nothing once the viewer turns logos off', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedInbox(t);
		await seedFromBank(t, mailboxId, { dmarcResult: 'pass' }, 'Real');
		await seedFoundLogo(t);
		await t.run((ctx) =>
			ctx.db.insert('mailUserSettings', {
				userId: 'test-user',
				autoAdvance: 'next',
				isSenderLogosOn: false,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			})
		);

		const { messages } = await t.query(api.mail.mailbox.queries.listMessages, {
			mailboxId,
			folderRole: 'inbox',
		});
		expect(messages[0]).not.toHaveProperty('senderLogoUrl');
		expect(await t.query(api.mail.settings.get, {})).toMatchObject({ isSenderLogosOn: false });
	});

	it('attaches nothing while the domain has no found logo', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedInbox(t);
		await seedFromBank(t, mailboxId, { dmarcResult: 'pass' }, 'Real');

		const { messages } = await t.query(api.mail.mailbox.queries.listMessages, {
			mailboxId,
			folderRole: 'inbox',
		});
		expect(messages[0]).not.toHaveProperty('senderLogoUrl');
	});
});

describe('requestSenderLogo', () => {
	const message = { fromAddress: `alerts@${DOMAIN}`, dmarcResult: 'pass' };

	async function logoRows(t: T) {
		return t.run((ctx) => ctx.db.query('senderLogos').collect());
	}

	async function scheduledLookups(t: T) {
		const jobs = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
		return jobs.filter((job) => job.name.includes('senderLogos/fetch'));
	}

	it('schedules one lookup per domain until it goes stale', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		await t.run((ctx) => requestSenderLogo(ctx, message, now));
		await t.run((ctx) => requestSenderLogo(ctx, message, now + 1000));

		expect(await logoRows(t)).toMatchObject([{ domain: DOMAIN, status: 'pending' }]);
		expect(await scheduledLookups(t)).toHaveLength(1);
	});

	it('schedules nothing for mail that may not show a logo', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		await t.run(async (ctx) => {
			await requestSenderLogo(ctx, { ...message, dmarcResult: 'fail' }, now);
			await requestSenderLogo(ctx, { fromAddress: 'ada@gmail.com', dmarcResult: 'pass' }, now);
			await requestSenderLogo(ctx, { fromAddress: 'a@shop.example', dmarcResult: 'pass' }, now);
		});
		expect(await logoRows(t)).toEqual([]);
		expect(await scheduledLookups(t)).toEqual([]);
	});

	it('keeps a found logo showing while a stale one is looked up again', async () => {
		const t = convexTest(schema, modules);
		await seedFoundLogo(t);
		const later = Date.now() + 30 * DAY_MS;
		await t.run((ctx) => requestSenderLogo(ctx, message, later));

		const [row] = await logoRows(t);
		expect(row).toMatchObject({ status: 'found', requestedAt: later });
		expect(await scheduledLookups(t)).toHaveLength(1);
	});
});

describe('commitSenderLogo', () => {
	it('stores the newest lookup and frees the logo it replaces', async () => {
		const t = convexTest(schema, modules);
		await seedFoundLogo(t);
		const requestedAt = Date.now() + 30 * DAY_MS;
		await t.run((ctx) =>
			requestSenderLogo(ctx, { fromAddress: `a@${DOMAIN}`, dmarcResult: 'pass' }, requestedAt)
		);
		const [before] = await t.run((ctx) => ctx.db.query('senderLogos').collect());
		const next = await t.run((ctx) => ctx.storage.store(new Blob(['<svg/>'])));

		const result = await t.mutation(internal.mail.senderLogos.cache.commitSenderLogo, {
			domain: DOMAIN,
			requestedAt,
			logo: { source: 'icon', storageId: next },
		});
		expect(result).toEqual({ isKept: true });
		const [after] = await t.run((ctx) => ctx.db.query('senderLogos').collect());
		expect(after).toMatchObject({ status: 'found', source: 'icon', storageId: next });
		expect(await t.run((ctx) => ctx.storage.getUrl(before!.storageId!))).toBeNull();
	});

	it('leaves the row alone when a newer lookup owns it', async () => {
		const t = convexTest(schema, modules);
		await seedFoundLogo(t);
		const [row] = await t.run((ctx) => ctx.db.query('senderLogos').collect());
		const stray = await t.run((ctx) => ctx.storage.store(new Blob(['<svg/>'])));

		const result = await t.mutation(internal.mail.senderLogos.cache.commitSenderLogo, {
			domain: DOMAIN,
			requestedAt: row!.requestedAt - 1,
			logo: { source: 'icon', storageId: stray },
		});
		expect(result).toEqual({ isKept: false });
		const [after] = await t.run((ctx) => ctx.db.query('senderLogos').collect());
		expect(after?.storageId).toBe(row!.storageId);
	});

	it('records a domain that stopped publishing a logo', async () => {
		const t = convexTest(schema, modules);
		await seedFoundLogo(t);
		const [row] = await t.run((ctx) => ctx.db.query('senderLogos').collect());

		await t.mutation(internal.mail.senderLogos.cache.commitSenderLogo, {
			domain: DOMAIN,
			requestedAt: row!.requestedAt,
			logo: null,
		});
		const [after] = await t.run((ctx) => ctx.db.query('senderLogos').collect());
		expect(after).toMatchObject({ status: 'none' });
		expect(after).not.toHaveProperty('storageId');
		expect(await t.run((ctx) => ctx.storage.getUrl(row!.storageId!))).toBeNull();
	});
});
