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
import type { DatabaseWriter } from '../../_generated/server';
import {
	createTestCampaign,
	createTestContact,
	createTestDomain,
	createTestInstanceSettings,
	createTestTransactionalEmail,
} from '../../__tests__/factories';
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

/**
 * A relay identity the SHIPPED `relayDomainVerified` accepts: MTA-primary
 * domain (so the manual-primary SPF contract applies), verified SES identity
 * with fresh DKIM + custom MAIL FROM proof. Without this the deliverability
 * fallback throws `DeliverabilityRouteError` instead of returning the relay.
 */
async function seedVerifiedSesRelay(ctx: { db: DatabaseWriter }, domain: string): Promise<void> {
	const now = Date.now();
	const domainId = await ctx.db.insert('domains', {
		domain,
		providerType: 'mta' as const,
		status: 'verified' as const,
		dnsRecords: {},
		createdAt: now,
		updatedAt: now,
	});
	await ctx.db.insert('sendingDomainSesIdentities', {
		domainId,
		dkimTokens: ['token-one'],
		verificationToken: 'proof',
		dnsRecords: {
			mailFrom: [{ type: 'MX', host: 'bounce', value: 'feedback-smtp.eu-west-1.amazonses.com' }],
		},
		verificationResults: {
			dkim: [{ verified: true, lastChecked: now }],
			mailFrom: [{ verified: true, lastChecked: now }],
		},
		isProviderVerified: true,
		verifiedAt: now,
		createdAt: now,
		updatedAt: now,
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

	it('records the arm the ROUTER resolved per cell, not the page-level advisory snapshot', async () => {
		// The page-level `providerType` the orchestrator passes is resolved ONCE
		// from the first recipient and is explicitly labelled advisory. The
		// deliverability fallback is keyed PER DESTINATION PROVIDER, so a
		// mixed-domain page must not stamp the first recipient's route onto
		// every other cell. Here gmail is in fallback and microsoft is not; the
		// page-level snapshot says `mta` for everyone.
		const t = convexTest(schema, modules);
		vi.stubEnv('AWS_SES_ACCESS_KEY_ID', 'key');
		vi.stubEnv('AWS_SES_SECRET_ACCESS_KEY', 'secret');
		const { campaignId, recipients } = await seedRecipients(t, ['a@gmail.com', 'b@outlook.com']);
		await t.run(async (ctx) => {
			await seedVerifiedSesRelay(ctx, 'example.com');
			await ctx.db.insert('providerRoutes', {
				messageType: 'campaign' as const,
				strategy: 'single' as const,
				providers: [
					{ providerType: 'mta', isEnabled: true },
					{ providerType: 'ses', isEnabled: true },
				],
				deliverabilityFallback: {
					isEnabled: true,
					relayProviderType: 'ses',
					isWarmupOverflowEnabled: false,
				},
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			// Fresh signal: inside DELIVERABILITY_SIGNAL_MAX_AGE_MS, gmail only.
			await ctx.db.insert('deliverabilityRouteStates', {
				organizationId: ORG,
				destinationProvider: 'gmail' as const,
				isFallbackActive: true,
				signals: [
					{
						source: 'dnsbl_listed' as const,
						severity: 'critical' as const,
						observedAt: Date.now(),
					},
				],
				snapshotGeneratedAt: Date.now(),
				expiresAt: Date.now() + 600_000,
				updatedAt: Date.now(),
			});
		});

		await t.mutation(
			internal.delivery.enqueue.enqueueCampaignEmails,
			campaignArgs(campaignId, recipients, { providerType: 'mta' })
		);

		const rows = await t.run(async (ctx) => ctx.db.query('sendAssignments').collect());
		const byCell = new Map(rows.map((row) => [row.cell, row]));
		expect(rows).toHaveLength(2);
		// Only the cell whose route state is in fallback carries the relay arm.
		expect(byCell.get('campaign:gmail')?.transport).toBe('ses');
		expect(byCell.get('campaign:gmail')?.arm).toBe('reference');
		expect(byCell.get('campaign:microsoft')?.transport).toBe('mta');
		expect(byCell.get('campaign:microsoft')?.arm).toBe('own');
	});

	it('never fails the enqueue when route resolution THROWS', async () => {
		// Fallback active with an UNVERIFIED relay domain makes `resolveRoute`
		// throw `DeliverabilityRouteError`. The worker re-resolves and handles
		// that as a deferral; the assignment writer must swallow it — a missing
		// measurement row can never be allowed to burn a send.
		const t = convexTest(schema, modules);
		vi.stubEnv('AWS_SES_ACCESS_KEY_ID', 'key');
		vi.stubEnv('AWS_SES_SECRET_ACCESS_KEY', 'secret');
		const { campaignId, recipients } = await seedRecipients(t, ['a@gmail.com']);
		await t.run(async (ctx) => {
			await ctx.db.insert('providerRoutes', {
				messageType: 'campaign' as const,
				strategy: 'single' as const,
				providers: [
					{ providerType: 'mta', isEnabled: true },
					{ providerType: 'ses', isEnabled: true },
				],
				deliverabilityFallback: {
					isEnabled: true,
					relayProviderType: 'ses',
					isWarmupOverflowEnabled: false,
				},
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('deliverabilityRouteStates', {
				organizationId: ORG,
				destinationProvider: 'gmail' as const,
				isFallbackActive: true,
				signals: [
					{
						source: 'dnsbl_listed' as const,
						severity: 'critical' as const,
						observedAt: Date.now(),
					},
				],
				snapshotGeneratedAt: Date.now(),
				expiresAt: Date.now() + 600_000,
				updatedAt: Date.now(),
			});
		});

		await expect(
			t.mutation(
				internal.delivery.enqueue.enqueueCampaignEmails,
				campaignArgs(campaignId, recipients)
			)
		).resolves.toEqual({ enqueued: 1 });

		expect(enqueueCampaignAction).toHaveBeenCalledTimes(1);
		const rows = await t.run(async (ctx) => ctx.db.query('sendAssignments').collect());
		expect(rows).toHaveLength(0);
	});

	it('maps every catalog transport to an arm', () => {
		expect(armForTransport('mta')).toBe('own');
		expect(armForTransport('ses')).toBe('reference');
		expect(armForTransport('resend')).toBe('reference');
		expect(armForTransport('smtp')).toBe('reference');
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

		// No route config and no usable EMAIL_PROVIDER ⇒ route resolution
		// returns null. The dispatch enqueue still happens; only the
		// measurement record is skipped. Recording never blocks a send.
		vi.stubEnv('EMAIL_PROVIDER', '');
		await t.mutation(
			internal.delivery.enqueue.enqueueCampaignEmails,
			campaignArgs(campaignId, recipients)
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

		// Static guard: the write path must not introduce a wide table scan,
		// and the classifier read stays an indexed point read in the ONE shared
		// helper both this module and the route resolver call.
		const fs = await import('node:fs/promises');
		const source = await fs.readFile(new URL('../sendAssignments.ts', import.meta.url), 'utf8');
		expect(source).not.toMatch(/\.collect\(\)/);
		const classifier = await fs.readFile(
			new URL('../../lib/sendProviders/destinationProvider.ts', import.meta.url),
			'utf8'
		);
		expect(classifier).not.toMatch(/\.collect\(\)/);
		expect(classifier).toMatch(/withIndex\('by_org_domain'/);
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
			// Same domain, different casing: learned observations are stored
			// lowercase, so this must share the memo slot AND the stored row
			// rather than costing a second (missing) read.
			'D@Gmail.COM',
			'd@outlook.com',
			'e@Outlook.com',
			'f@example.org',
			'not-an-address',
		];
		const providers = await destinationProvidersForEmails(
			countingCtx as unknown as Parameters<typeof destinationProvidersForEmails>[0],
			ORG,
			emails,
			Date.now()
		);

		// Three distinct (case-normalized) domains ⇒ three indexed point reads,
		// for eight recipients. Every read is issued lowercase, and the
		// unparseable address costs no read at all.
		expect(reads).toEqual(['gmail.com', 'outlook.com', 'example.org']);
		expect(new Set(tables)).toEqual(new Set(['destinationProviderDomains']));
		expect(new Set(indexes)).toEqual(new Set(['by_org_domain']));
		expect(providers.get('a@gmail.com')).toBe('gmail');
		expect(providers.get('D@Gmail.COM')).toBe('gmail');
		expect(providers.get('d@outlook.com')).toBe('microsoft');
		expect(providers.get('e@Outlook.com')).toBe('microsoft');
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

	it('records the transactional stream and the route table for the agent-reply message type', async () => {
		const t = convexTest(schema, modules);
		// The `transactional` route table names the SMTP relay; the recorded
		// transport must come from THAT resolution, not from the producer's
		// `providerType` argument (which deliberately says something else).
		await t.run(async (ctx) => {
			await ctx.db.insert('providerRoutes', {
				messageType: 'transactional' as const,
				strategy: 'single' as const,
				providers: [{ providerType: 'smtp', isEnabled: true }],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		await t.mutation(internal.delivery.enqueue.enqueueNonCampaignSend, {
			kind: 'agent_reply' as const,
			email: 'customer@yahoo.com',
			subject: 'Re: order',
			html: '<p>hi</p>',
			from: 'support@example.com',
			providerType: 'mta',
		});

		const rows = await t.run(async (ctx) => ctx.db.query('sendAssignments').collect());
		expect(rows).toHaveLength(1);
		expect(rows[0]?.cell).toBe('transactional:yahoo');
		expect(rows[0]?.transport).toBe('smtp');
		expect(rows[0]?.arm).toBe('reference');
	});

	it('writes no assignment row for a test send (excluded from the experiment)', async () => {
		// Test sends are operator previews, not audience traffic: counting them
		// would pollute every cell's denominator. The exclusion is pinned here
		// rather than only asserted in prose.
		const t = convexTest(schema, modules);

		await t.mutation(internal.delivery.enqueue.enqueueTestSend, {
			email: 'operator@gmail.com',
			organizationId: ORG,
			from: 'news@example.com',
			subject: 'Preview',
			html: '<p>hi</p>',
		});

		expect(enqueueTransactionalAction).toHaveBeenCalledTimes(1);
		const rows = await t.run(async (ctx) => ctx.db.query('sendAssignments').collect());
		expect(rows).toHaveLength(0);
	});

	it('records the transactional Template API send — the primary producer of that stream', async () => {
		// `transactional/dispatch.ts` is a THIRD enqueue producer that bypasses
		// `delivery/enqueue.ts` entirely. Without a row here the `transactional`
		// cell axis would be populated only by agent 1:1 replies.
		const t = convexTest(schema, modules);
		const templateId = await t.run(async (ctx) => {
			await ctx.db.insert(
				'instanceSettings',
				createTestInstanceSettings({
					abuseStatus: 'clean' as const,
					defaultFromEmail: 'noreply@example.com',
					defaultFromName: 'Owlat',
				})
			);
			await ctx.db.insert(
				'domains',
				createTestDomain({
					domain: 'example.com',
					status: 'verified' as const,
					lastVerifiedAt: Date.now(),
				})
			);
			return await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({
					status: 'published' as const,
					htmlContent: '<p>Hello</p>',
					subject: 'Welcome',
					supportedLanguages: ['en'],
					defaultLanguage: 'en',
				})
			);
		});

		const outcome = await t.mutation(internal.transactional.dispatch.dispatch, {
			templateLookup: { kind: 'id' as const, id: templateId },
			email: 'buyer@gmail.com',
		});
		expect(outcome.ok).toBe(true);

		const rows = await t.run(async (ctx) => ctx.db.query('sendAssignments').collect());
		expect(rows).toHaveLength(1);
		expect(rows[0]?.organizationId).toBe(ORG);
		expect(rows[0]?.sendKind).toBe('transactional');
		expect(rows[0]?.cell).toBe('transactional:gmail');
		// The transport the route resolver returned for THIS recipient, reused
		// from step 8 of the dispatch rather than re-resolved.
		expect(rows[0]?.transport).toBe('mta');
		expect(rows[0]?.arm).toBe('own');
		expect(rows[0]?.mixVersion).toBe(ROUTER_ONLY_MIX_VERSION);
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
