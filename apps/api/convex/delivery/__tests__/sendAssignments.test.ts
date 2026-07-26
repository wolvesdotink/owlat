/**
 * The experiment record: one `sendAssignments` row per recipient per send,
 * written BEFORE dispatch and INSIDE the enqueue transaction (plan D7/D16).
 *
 * Coverage here:
 *   - campaign enqueue writes exactly one row per recipient with the right
 *     cell / arm / transport / mixVersion, using the SHIPPED MX-learned
 *     destination-provider classification;
 *   - the row is written before the workpool enqueue, and a throw from the
 *     dispatch enqueue rolls the assignment rows back with the sends;
 *   - the non-campaign chokepoint records the `automation` / `transactional`
 *     streams;
 *   - write-amplification regression: N recipients ⇒ O(N) narrow inserts, no
 *     wide `.collect()` on the path.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { createTestCampaign, createTestContact } from '../../__tests__/factories';
import {
	armForTransport,
	destinationProvidersForEmails,
	ROUTER_ONLY_MIX_VERSION,
} from '../sendAssignments';

// `vi.hoisted` so the mock factory below (hoisted above the imports) can close
// over these without hitting the temporal dead zone.
const { enqueueCampaignAction, enqueueTransactionalAction } = vi.hoisted(() => ({
	enqueueCampaignAction: vi.fn(),
	enqueueTransactionalAction: vi.fn(),
}));

vi.mock('../workpool', () => ({
	campaignEmailPool: {
		enqueueAction: (...args: unknown[]) => enqueueCampaignAction(...args),
	},
	transactionalEmailPool: {
		enqueueAction: (...args: unknown[]) => enqueueTransactionalAction(...args),
	},
}));

// The singleton-org lookup goes through the BetterAuth component, which is not
// registered in the convex-test harness. Same override the shipped routing
// tests use, so the org fallback in `recordSendAssignments` is deterministic.
vi.mock('../../lib/sessionOrganization', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../lib/sessionOrganization')>();
	return { ...actual, getSingletonOrganizationId: vi.fn().mockResolvedValue('org_experiment') };
});

const rootGlob = import.meta.glob('../../**/*.*s');
const deliveryGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../delivery/'),
		mod,
	])
);
const modules = { ...rootGlob, ...deliveryGlob };

const ORG = 'org_experiment';

beforeEach(() => {
	enqueueCampaignAction.mockReset();
	enqueueCampaignAction.mockResolvedValue(undefined);
	enqueueTransactionalAction.mockReset();
	enqueueTransactionalAction.mockResolvedValue(undefined);
	vi.stubEnv('EMAIL_PROVIDER', 'mta');
	vi.stubEnv('MTA_API_URL', 'https://mta.test');
	vi.stubEnv('MTA_API_KEY', 'test-key');
	vi.stubEnv('SMTP_RELAY_HOST', 'relay.test');
	vi.stubEnv('SMTP_RELAY_USERNAME', 'user');
	vi.stubEnv('SMTP_RELAY_PASSWORD', 'pass');
});

afterEach(() => {
	vi.unstubAllEnvs();
});

type Harness = ReturnType<typeof convexTest>;

async function seedRecipients(t: Harness, emails: readonly string[]) {
	return await t.run(async (ctx) => {
		const campaignId = await ctx.db.insert('campaigns', createTestCampaign());
		const recipients: Array<{
			emailSendId: Id<'emailSends'>;
			contactId: Id<'contacts'>;
			email: string;
		}> = [];
		for (const email of emails) {
			const contactId = await ctx.db.insert('contacts', createTestContact({ email }));
			const emailSendId = await ctx.db.insert('emailSends', {
				campaignId,
				contactId,
				contactEmail: email,
				status: 'queued' as const,
				queuedAt: Date.now(),
			});
			recipients.push({ emailSendId, contactId, email });
		}
		return { campaignId, recipients };
	});
}

function campaignArgs(
	campaignId: Id<'campaigns'>,
	recipients: Array<{ emailSendId: Id<'emailSends'>; contactId: Id<'contacts'>; email: string }>,
	overrides: Record<string, unknown> = {}
) {
	return {
		campaignId,
		emails: recipients.map((recipient) => ({
			emailSendId: recipient.emailSendId,
			contactId: recipient.contactId,
			email: recipient.email,
		})),
		from: 'news@example.com',
		subject: 'Hello',
		htmlContent: '<p>hi</p>',
		organizationId: ORG,
		...overrides,
	};
}

describe('sendAssignments — campaign write path', () => {
	it('writes one row per recipient with the correct cell, arm, transport and mix version', async () => {
		const t = convexTest(schema, modules);
		const { campaignId, recipients } = await seedRecipients(t, [
			'a@gmail.com',
			'b@outlook.com',
			'c@yahoo.com',
			'd@example.org',
		]);

		await t.mutation(
			internal.delivery.enqueue.enqueueCampaignEmails,
			campaignArgs(campaignId, recipients)
		);

		const rows = await t.run(async (ctx) => ctx.db.query('sendAssignments').collect());
		expect(rows).toHaveLength(4);
		const byEmail = new Map(
			rows.map((row) => [
				recipients.find((r) => r.emailSendId === row.sendId)?.email ?? 'unknown',
				row,
			])
		);
		expect(byEmail.get('a@gmail.com')?.cell).toBe('campaign:gmail');
		expect(byEmail.get('b@outlook.com')?.cell).toBe('campaign:microsoft');
		expect(byEmail.get('c@yahoo.com')?.cell).toBe('campaign:yahoo');
		expect(byEmail.get('d@example.org')?.cell).toBe('campaign:other');
		for (const row of rows) {
			expect(row.organizationId).toBe(ORG);
			expect(row.sendKind).toBe('campaign');
			expect(row.transport).toBe('mta');
			expect(row.arm).toBe('own');
			expect(row.isCalibration).toBe(false);
			expect(row.mixVersion).toBe(ROUTER_ONLY_MIX_VERSION);
			expect(row.engagementRank).toBeUndefined();
			expect(row.assignedAt).toBeGreaterThan(0);
		}
	});

	it('records the reference arm when the router resolved a relay transport', async () => {
		const t = convexTest(schema, modules);
		const { campaignId, recipients } = await seedRecipients(t, ['a@gmail.com']);

		await t.mutation(
			internal.delivery.enqueue.enqueueCampaignEmails,
			campaignArgs(campaignId, recipients, { providerType: 'ses' })
		);

		const rows = await t.run(async (ctx) => ctx.db.query('sendAssignments').collect());
		expect(rows).toHaveLength(1);
		expect(rows[0]?.transport).toBe('ses');
		expect(rows[0]?.arm).toBe('reference');
		expect(armForTransport('ses')).toBe('reference');
		expect(armForTransport('mta')).toBe('own');
	});

	it('prefers the MX-learned destination provider over the address-domain fallback', async () => {
		const t = convexTest(schema, modules);
		const { campaignId, recipients } = await seedRecipients(t, ['ceo@customdomain.test']);
		await t.run(async (ctx) => {
			await ctx.db.insert('destinationProviderDomains', {
				organizationId: ORG,
				domain: 'customdomain.test',
				destinationProvider: 'gmail' as const,
				observedAt: Date.now(),
				expiresAt: Date.now() + 60_000,
			});
		});

		await t.mutation(
			internal.delivery.enqueue.enqueueCampaignEmails,
			campaignArgs(campaignId, recipients)
		);

		const rows = await t.run(async (ctx) => ctx.db.query('sendAssignments').collect());
		expect(rows[0]?.cell).toBe('campaign:gmail');
	});

	it('ignores an EXPIRED MX observation and falls back to the address-domain classifier', async () => {
		const t = convexTest(schema, modules);
		const { campaignId, recipients } = await seedRecipients(t, ['ceo@customdomain.test']);
		await t.run(async (ctx) => {
			await ctx.db.insert('destinationProviderDomains', {
				organizationId: ORG,
				domain: 'customdomain.test',
				destinationProvider: 'gmail' as const,
				observedAt: Date.now() - 120_000,
				expiresAt: Date.now() - 60_000,
			});
		});

		await t.mutation(
			internal.delivery.enqueue.enqueueCampaignEmails,
			campaignArgs(campaignId, recipients)
		);

		const rows = await t.run(async (ctx) => ctx.db.query('sendAssignments').collect());
		expect(rows[0]?.cell).toBe('campaign:other');
	});

	it('writes the assignment BEFORE the workpool dispatch enqueue', async () => {
		const t = convexTest(schema, modules);
		const { campaignId, recipients } = await seedRecipients(t, ['a@gmail.com', 'b@gmail.com']);
		let rowsAtFirstDispatch = -1;
		enqueueCampaignAction.mockImplementation(async (ctx: unknown) => {
			if (rowsAtFirstDispatch === -1) {
				const mutationCtx = ctx as {
					db: { query: (table: string) => { collect: () => Promise<unknown[]> } };
				};
				const rows = await mutationCtx.db.query('sendAssignments').collect();
				rowsAtFirstDispatch = rows.length;
			}
			return undefined;
		});

		await t.mutation(
			internal.delivery.enqueue.enqueueCampaignEmails,
			campaignArgs(campaignId, recipients)
		);

		// Both assignment rows already exist when the FIRST dispatch is enqueued.
		expect(rowsAtFirstDispatch).toBe(2);
	});

	it('rolls the assignment rows back with the transaction when dispatch enqueue throws', async () => {
		const t = convexTest(schema, modules);
		const { campaignId, recipients } = await seedRecipients(t, ['a@gmail.com', 'b@gmail.com']);
		enqueueCampaignAction.mockRejectedValue(new Error('workpool unavailable'));

		await expect(
			t.mutation(
				internal.delivery.enqueue.enqueueCampaignEmails,
				campaignArgs(campaignId, recipients)
			)
		).rejects.toThrow(/workpool unavailable/);

		const rows = await t.run(async (ctx) => ctx.db.query('sendAssignments').collect());
		expect(rows).toHaveLength(0);
	});

	it('skips the row (and never throws) when no transport can be resolved', async () => {
		const t = convexTest(schema, modules);
		const { campaignId, recipients } = await seedRecipients(t, ['a@gmail.com']);

		// An unknown/stale provider key fails closed in `selectSendProviderKind`.
		// The send still goes out; only the measurement record is skipped.
		await t.mutation(
			internal.delivery.enqueue.enqueueCampaignEmails,
			campaignArgs(campaignId, recipients, { providerType: 'not_a_transport' })
		);

		expect(enqueueCampaignAction).toHaveBeenCalledTimes(1);
		const rows = await t.run(async (ctx) => ctx.db.query('sendAssignments').collect());
		expect(rows).toHaveLength(0);
	});

	it('is O(N) narrow inserts for N recipients and reads each distinct domain once', async () => {
		const t = convexTest(schema, modules);
		const emails = Array.from({ length: 25 }, (_, index) => `user${index}@gmail.com`);
		const { campaignId, recipients } = await seedRecipients(t, emails);

		await t.mutation(
			internal.delivery.enqueue.enqueueCampaignEmails,
			campaignArgs(campaignId, recipients)
		);

		const rows = await t.run(async (ctx) => ctx.db.query('sendAssignments').collect());
		expect(rows).toHaveLength(emails.length);
		// One row per recipient, all in the same cell — no fan-out, no duplicates.
		expect(new Set(rows.map((row) => row.sendId)).size).toBe(emails.length);
		expect(new Set(rows.map((row) => row.cell))).toEqual(new Set(['campaign:gmail']));

		// Static guard: the write path must not introduce a wide table scan.
		const source = await import('node:fs/promises').then((fs) =>
			fs.readFile(new URL('../sendAssignments.ts', import.meta.url), 'utf8')
		);
		expect(source).not.toMatch(/\.collect\(\)/);
		expect(source).toMatch(/withIndex\('by_org_domain'/);
	});

	it('issues exactly one by_org_domain read per DISTINCT recipient domain', async () => {
		// Behavioural, not source-shaped: the static guard above cannot tell a
		// memoized lookup from a per-recipient one when every recipient shares a
		// domain. A counting stub context can, so a regression that drops the
		// memo map fails here instead of passing quietly.
		interface IndexQueryStub {
			eq: (field: string, value: string) => IndexQueryStub;
		}
		const reads: string[] = [];
		const tables: string[] = [];
		const indexes: string[] = [];
		const countingCtx = {
			db: {
				query: (table: string) => {
					tables.push(table);
					return {
						withIndex: (indexName: string, build: (q: IndexQueryStub) => IndexQueryStub) => {
							indexes.push(indexName);
							const bound: Record<string, string> = {};
							const q: IndexQueryStub = {
								eq: (field: string, value: string) => {
									bound[field] = value;
									return q;
								},
							};
							build(q);
							reads.push(bound['domain'] ?? '');
							return { first: async () => null };
						},
					};
				},
			},
		};

		const emails = [
			'a@gmail.com',
			'b@gmail.com',
			'c@gmail.com',
			'd@outlook.com',
			'e@outlook.com',
			'f@example.org',
			'not-an-address',
		];
		const providers = await destinationProvidersForEmails(
			countingCtx as unknown as Parameters<typeof destinationProvidersForEmails>[0],
			ORG,
			emails,
			Date.now()
		);

		// Three distinct domains ⇒ three indexed point reads, for seven recipients.
		// The unparseable address costs no read at all.
		expect(reads).toEqual(['gmail.com', 'outlook.com', 'example.org']);
		expect(new Set(tables)).toEqual(new Set(['destinationProviderDomains']));
		expect(new Set(indexes)).toEqual(new Set(['by_org_domain']));
		expect(providers.get('a@gmail.com')).toBe('gmail');
		expect(providers.get('d@outlook.com')).toBe('microsoft');
		expect(providers.get('f@example.org')).toBe('other');
		expect(providers.get('not-an-address')).toBe('other');
	});
});

describe('sendAssignments — non-campaign write path', () => {
	it('records the automation stream for an automation step send', async () => {
		const t = convexTest(schema, modules);

		const { sendId } = await t.mutation(internal.delivery.enqueue.enqueueNonCampaignSend, {
			kind: 'automation' as const,
			email: 'subscriber@gmail.com',
			subject: 'Welcome',
			html: '<p>hi</p>',
			from: 'news@example.com',
			providerType: 'mta',
		});

		const rows = await t.run(async (ctx) => ctx.db.query('sendAssignments').collect());
		expect(rows).toHaveLength(1);
		expect(rows[0]?.sendId).toBe(sendId);
		expect(rows[0]?.sendKind).toBe('transactional');
		expect(rows[0]?.cell).toBe('automation:gmail');
		expect(rows[0]?.arm).toBe('own');
	});

	it('records the transactional stream for an agent reply', async () => {
		const t = convexTest(schema, modules);

		await t.mutation(internal.delivery.enqueue.enqueueNonCampaignSend, {
			kind: 'agent_reply' as const,
			email: 'customer@yahoo.com',
			subject: 'Re: order',
			html: '<p>hi</p>',
			from: 'support@example.com',
			providerType: 'smtp',
		});

		const rows = await t.run(async (ctx) => ctx.db.query('sendAssignments').collect());
		expect(rows).toHaveLength(1);
		expect(rows[0]?.cell).toBe('transactional:yahoo');
		expect(rows[0]?.arm).toBe('reference');
	});

	it('writes no assignment row when the send is suppressed before insert', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('blockedEmails', {
				email: 'blocked@gmail.com',
				reason: 'bounced' as const,
				bounceType: 'hard' as const,
				createdAt: Date.now(),
			});
		});

		await expect(
			t.mutation(internal.delivery.enqueue.enqueueNonCampaignSend, {
				kind: 'automation' as const,
				email: 'blocked@gmail.com',
				subject: 'Welcome',
				html: '<p>hi</p>',
				from: 'news@example.com',
				providerType: 'mta',
			})
		).rejects.toThrow();

		const rows = await t.run(async (ctx) => ctx.db.query('sendAssignments').collect());
		expect(rows).toHaveLength(0);
	});
});
