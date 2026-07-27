/**
 * (b) The seed shadow copy goes through the IDENTICAL composer and the
 * IDENTICAL transport, carries the probe id, clears the worker's pre-dispatch
 * gates, and is EXCLUDED from analytics and reputation denominators (D18).
 *
 * The secret is set at MODULE scope, before any `describe` body runs: vitest
 * executes describe bodies at collection time, so a `beforeAll` would be too
 * late for the composition performed there and the whole file would fail to
 * collect (which is exactly what happened in review round 1).
 */
import { convexTest } from 'convex-test';
import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import {
	buildSeedShadowEnvelope,
	enqueueSeedShadowCopies,
	isSeedShadowEnvelope,
} from '../seedShadowCopy';
import type { CampaignEnvelopeInput } from '../seedShadowCopy';
import { assertSeedShadowExclusion, buildComposeInput } from '../worker';
import { assertMarketingOneClickHeaders } from '../marketingCompliance';
import { composeForSend } from '../sendComposition';
import { SEED_PROBE_HEADER } from '@owlat/shared/seedPlacement';
import schema from '../../schema';
import { insertExternalAccountRow } from '../../mail/externalAccountShared';
import { campaignEmailPool } from '../workpool';
import { SEED_PROBE_RETENTION_MS } from '../../schema/seedPlacement';
import type { Id } from '../../_generated/dataModel';

// The Workpool component is not registered in convex-test, and the worker action
// would need provider credentials. Stubbing it lets us assert exactly WHAT was
// handed to the pool, which is the "identical transport" half of the claim.
vi.mock('../workpool', () => ({
	transactionalEmailPool: { enqueueAction: vi.fn().mockResolvedValue(undefined) },
	campaignEmailPool: { enqueueAction: vi.fn().mockResolvedValue(undefined) },
}));

const PREV_SECRET = process.env['UNSUBSCRIBE_SECRET'];
process.env['UNSUBSCRIBE_SECRET'] = 'test-unsubscribe-secret';

afterAll(() => {
	if (PREV_SECRET === undefined) delete process.env['UNSUBSCRIBE_SECRET'];
	else process.env['UNSUBSCRIBE_SECRET'] = PREV_SECRET;
});

const CONTACT_ID = 'contact1' as Id<'contacts'>;
const SEND_ID = 'send1' as Id<'emailSends'>;
const CAMPAIGN_ID = 'campaign1' as Id<'campaigns'>;
const PROBE_REF = 'probe1' as Id<'seedPlacementProbes'>;
const PROBE_ID = 'sp_abcdefghij0123456789kl';
const SEED_ADDRESS = 'owlat.seed.01@gmail.example';

// A real campaign envelope. The template carries no personalization tokens so
// the byte-identity assertions below compare composition, not substitution.
const realSend: CampaignEnvelopeInput = {
	kind: 'campaign',
	deliveryDomain: 'production',
	to: 'jane@example.com',
	from: 'news@org.example',
	replyTo: 'hello@org.example',
	providerType: 'mta',
	ipPool: 'marketing',
	template: {
		subject: 'March newsletter',
		htmlContent: '<p>Hello there <a href="https://org.example/read">read</a></p>',
	},
	contactInfo: {
		contactId: CONTACT_ID,
		email: 'jane@example.com',
		firstName: 'Jane',
		lastName: 'Doe',
	},
	audienceType: 'topic',
	emailSendId: SEND_ID,
	campaignId: CAMPAIGN_ID,
	organizationId: 'org_1',
	siteUrl: 'https://app.example',
	convexSiteUrl: 'https://convex.example',
	trackingBaseUrl: 'https://track.example',
	viewInBrowserUrl: 'https://app.example/archive/1',
	listId: '"March" <topic-1.org.example>',
};

const shadow = buildSeedShadowEnvelope(realSend, {
	address: SEED_ADDRESS,
	probeId: PROBE_ID,
	probeRef: PROBE_REF,
});

describe('buildSeedShadowEnvelope — identical transport', () => {
	it('keeps the same kind, so it goes through the same worker and composer', () => {
		expect(shadow.kind).toBe('campaign');
	});

	it('keeps every routing field that decides HOW the mail leaves', () => {
		expect(shadow.from).toBe(realSend.from);
		expect(shadow.replyTo).toBe(realSend.replyTo);
		expect(shadow.providerType).toBe(realSend.providerType);
		expect(shadow.ipPool).toBe(realSend.ipPool);
		expect(shadow.deliveryDomain).toBe(realSend.deliveryDomain);
	});

	it('addresses the seed mailbox and nobody else', () => {
		expect(shadow.to).toBe(SEED_ADDRESS);
		expect(shadow.contactInfo.email).toBe(SEED_ADDRESS);
	});

	it('never mutates the real envelope', () => {
		expect(realSend.to).toBe('jane@example.com');
		expect(realSend.seedProbeId).toBeUndefined();
	});

	it('reaches the wire as the probe header, and only on the shadow copy', () => {
		const shadowHeaders = composeForSend(buildComposeInput(shadow)).headers;
		const realHeaders = composeForSend(buildComposeInput(realSend)).headers;
		expect(shadowHeaders[SEED_PROBE_HEADER]).toBe(PROBE_ID);
		expect(realHeaders[SEED_PROBE_HEADER]).toBeUndefined();
	});

	it('is recognisable as a shadow copy; a real send never is', () => {
		expect(isSeedShadowEnvelope(shadow)).toBe(true);
		expect(isSeedShadowEnvelope(realSend)).toBe(false);
	});
});

describe('shadow composition is identical apart from the probe header', () => {
	const shadowOut = composeForSend(buildComposeInput(shadow));
	const realOut = composeForSend(buildComposeInput(realSend));

	it('produces the same subject, html and plain-text alternative', () => {
		expect(shadowOut.subject).toBe(realOut.subject);
		expect(shadowOut.html).toBe(realOut.html);
		expect(shadowOut.text).toBe(realOut.text);
	});

	it('produces the same bulk-mail and list headers', () => {
		expect(shadowOut.headers['Precedence']).toBe(realOut.headers['Precedence']);
		expect(shadowOut.headers['Auto-Submitted']).toBe(realOut.headers['Auto-Submitted']);
		expect(shadowOut.headers['List-Id']).toBe(realOut.headers['List-Id']);
		expect(shadowOut.headers['Feedback-ID']).toBe(realOut.headers['Feedback-ID']);
	});

	it('carries the SAME one-click contract, differing only in the token target', () => {
		expect(shadowOut.headers['List-Unsubscribe-Post']).toBe(
			realOut.headers['List-Unsubscribe-Post']
		);
		// A probe's target is probe-scoped: a real subscriber's one-click token
		// must never land in an operator mailbox.
		expect(shadowOut.headers['List-Unsubscribe']).not.toBe(realOut.headers['List-Unsubscribe']);
		expect(shadowOut.headers['List-Unsubscribe']).toContain('/unsub/probe/');
	});

	it('adds exactly one header and re-targets exactly one', () => {
		const differing = new Set<string>();
		for (const key of new Set([
			...Object.keys(shadowOut.headers),
			...Object.keys(realOut.headers),
		])) {
			if (shadowOut.headers[key] !== realOut.headers[key]) differing.add(key);
		}
		expect([...differing].sort()).toEqual(['List-Unsubscribe', SEED_PROBE_HEADER]);
	});

	it('carries the same wire features a filter weighs: pixel and wrapped links', () => {
		expect(shadowOut.transformConfig?.trackingPixelUrl).toBeDefined();
		expect(shadowOut.transformConfig?.trackedLinkBase).toBeDefined();
		expect(realOut.transformConfig?.trackingPixelUrl).toBeDefined();
	});
});

/** (b) A probe must clear the two pre-dispatch gates that used to throw. */
describe('dispatch path — the probe clears every pre-dispatch gate', () => {
	it('passes the marketing one-click assertion the campaign worker applies', () => {
		const composed = composeForSend(buildComposeInput(shadow));
		expect(() => assertMarketingOneClickHeaders('marketing', composed.headers)).not.toThrow();
	});

	it('passes the seed-shadow exclusion invariant, as does a real send', () => {
		expect(() => assertSeedShadowExclusion(shadow)).not.toThrow();
		expect(() => assertSeedShadowExclusion(realSend)).not.toThrow();
	});

	it('carries a durable dispatch reference, so the governed boundary accepts it', () => {
		// `governedDispatch` refuses a dispatch with no durable reference. The
		// probe supplies its ledger row instead of a Send.
		expect(shadow.seedProbeRef).toBe(PROBE_REF);
		expect(shadow.emailSendId).toBeUndefined();
	});

	it('rejects an envelope that would be both a probe and a countable Send', () => {
		expect(() => assertSeedShadowExclusion({ ...shadow, emailSendId: SEND_ID })).toThrow(
			/must not carry a countable Send/
		);
		expect(() =>
			assertSeedShadowExclusion({
				...shadow,
				contactInfo: { email: SEED_ADDRESS, contactId: CONTACT_ID },
			})
		).toThrow(/must not carry a countable Send/);
	});

	it('rejects a probe envelope with no ledger reference', () => {
		const orphan: CampaignEnvelopeInput = { ...shadow };
		delete orphan.seedProbeRef;
		expect(() => assertSeedShadowExclusion(orphan)).toThrow(/probe ledger reference/);
	});
});

/** (b) D18 — EXCLUDED from analytics denominators AND reputation denominators. */
describe('D18 exclusion — a shadow copy is not a Send', () => {
	it('carries no emailSendId, so no emailSends row and no sendRef exist for it', () => {
		expect(shadow.emailSendId).toBeUndefined();
	});

	it('carries no contactId, so no contact-scoped URL or activity can attach', () => {
		expect(shadow.contactInfo.contactId).toBeUndefined();
	});

	it('tracks under the opaque probe id, never under a countable Send id', () => {
		const composed = composeForSend(buildComposeInput(shadow));
		expect(composed.transformConfig?.trackingPixelUrl).toContain(PROBE_ID);
		expect(composed.transformConfig?.trackingPixelUrl).not.toContain(SEND_ID);
		expect(composed.transformConfig?.trackedLinkBase?.emailSendId).toBe(PROBE_ID);
	});

	it('drops the contact-scoped footer and archive URLs', () => {
		expect(shadow.siteUrl).toBeUndefined();
		expect(shadow.viewInBrowserUrl).toBeUndefined();
	});

	it('keeps the campaign attribution needed for Feedback-ID without becoming countable', () => {
		expect(shadow.campaignId).toBe(CAMPAIGN_ID);
		expect(shadow.emailSendId).toBeUndefined();
	});
});

// ── (b) THE EMISSION HALF: probes with seeds actually PRESENT ──────────────
//
// Everything above proves the shadow envelope is right. This proves the module
// that produces it does: one ledger row and one pool item per seed, the
// (org, campaign, variant) idempotency that stops the campaign walker minting a
// duplicate probe set on every page, and the D18 denominator exclusion asserted
// against the SHIPPED counters rather than by construction alone.

const rootGlob = import.meta.glob('../../**/*.*s');
const deliveryGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, module]) => [
		path.replace(/^\.\.\//, '../../delivery/'),
		module,
	])
);
const modules = { ...rootGlob, ...deliveryGlob };

const NOW = 1_800_000_000_000;
const ORG = 'org_seed_emission';

const SEEDS = [
	{ address: 'owlat.seed.gmail@gmail.example', provider: 'gmail' as const, login: 'seed-g' },
	{ address: 'owlat.seed.ms@outlook.example', provider: 'microsoft' as const, login: 'seed-m' },
];

async function connectSeeds(t: ReturnType<typeof convexTest>): Promise<void> {
	await t.run(async (ctx) => {
		for (const seed of SEEDS) {
			const [, domain] = seed.address.split('@');
			const mailboxId = await ctx.db.insert('mailboxes', {
				userId: 'user_1',
				organizationId: ORG,
				address: seed.address,
				domain: domain ?? 'example',
				kind: 'external' as const,
				status: 'active' as const,
				usedBytes: 0,
				uidValidity: NOW,
				createdAt: NOW,
				updatedAt: NOW,
			});
			await insertExternalAccountRow(ctx, {
				userId: 'user_1',
				organizationId: ORG,
				mailboxId,
				address: seed.address,
				seed: { seedProvider: seed.provider },
				fields: {
					emailAddress: seed.address,
					imapHost: 'imap.example',
					imapPort: 993,
					isImapSecure: true,
					smtpHost: 'smtp.example',
					smtpPort: 587,
					isSmtpSecure: false,
					imapUsername: seed.login,
					authMethod: 'password' as const,
					secretCiphertext: 'ct',
					secretIv: 'iv',
					secretAuthTag: 'tag',
					secretEnvelopeVersion: 1,
				},
				now: NOW,
			});
		}
	});
}

async function makeCampaign(t: ReturnType<typeof convexTest>): Promise<Id<'campaigns'>> {
	return t.run(async (ctx) =>
		ctx.db.insert('campaigns', {
			name: 'March',
			subject: 'March newsletter',
			status: 'sending' as const,
			createdAt: NOW,
			updatedAt: NOW,
		})
	);
}

describe('enqueueSeedShadowCopies — with seed mailboxes present', () => {
	beforeEach(() => {
		vi.mocked(campaignEmailPool.enqueueAction).mockClear();
	});

	it('writes one ledger row per seed with the full cell key', async () => {
		const t = convexTest(schema, modules);
		await connectSeeds(t);
		const campaignId = await makeCampaign(t);

		const outcome = await t.run(async (ctx) =>
			enqueueSeedShadowCopies(ctx, {
				organizationId: ORG,
				campaignId,
				abVariant: 'A',
				base: { ...realSend, campaignId, organizationId: ORG },
				now: NOW,
			})
		);
		expect(outcome).toEqual({ enqueued: 2 });

		const rows = await t.run(async (ctx) => ctx.db.query('seedPlacementProbes').collect());
		expect(rows).toHaveLength(2);
		expect(rows.map((r) => r.provider).sort()).toEqual(['gmail', 'microsoft']);
		for (const row of rows) {
			expect(row.organizationId).toBe(ORG);
			expect(row.stream).toBe('campaign');
			expect(row.campaignId).toBe(campaignId);
			expect(row.abVariant).toBe('A');
			expect(row.sentAt).toBe(NOW);
			expect(row.expiresAt).toBe(NOW + SEED_PROBE_RETENTION_MS);
			// Not dispatched yet — the worker stamps that, and nothing may read a
			// probe as MISSING before it does.
			expect(row.dispatchedAt).toBeUndefined();
			expect(row.placement).toBeUndefined();
		}
	});

	it('enqueues one worker action per seed carrying the cloned envelope', async () => {
		const t = convexTest(schema, modules);
		await connectSeeds(t);
		const campaignId = await makeCampaign(t);
		await t.run(async (ctx) =>
			enqueueSeedShadowCopies(ctx, {
				organizationId: ORG,
				campaignId,
				base: { ...realSend, campaignId, organizationId: ORG },
				now: NOW,
			})
		);

		const enqueueAction = vi.mocked(campaignEmailPool.enqueueAction);
		expect(enqueueAction).toHaveBeenCalledTimes(2);
		const rows = await t.run(async (ctx) => ctx.db.query('seedPlacementProbes').collect());
		const probeIds = new Set(rows.map((r) => r.probeId));

		for (const call of enqueueAction.mock.calls) {
			const envelope = call[2]?.['envelopeInput'] as CampaignEnvelopeInput;
			// IDENTICAL transport: same routing fields as the real send.
			expect(envelope.from).toBe(realSend.from);
			expect(envelope.providerType).toBe(realSend.providerType);
			expect(envelope.ipPool).toBe(realSend.ipPool);
			expect(envelope.template).toEqual(realSend.template);
			// Addressed to a seed, tagged with its probe, and NOT countable.
			expect(SEEDS.map((s) => s.address)).toContain(envelope.to);
			expect(probeIds.has(envelope.seedProbeId ?? '')).toBe(true);
			expect(envelope.seedProbeRef).toBeDefined();
			expect(envelope.emailSendId).toBeUndefined();
			expect(envelope.contactInfo.contactId).toBeUndefined();
			// No `onComplete`: there is no Send lifecycle to complete (D18).
			expect(call[3]).toBeUndefined();
		}
	});

	it('is idempotent per (org, campaign, variant) across the walker pages', async () => {
		const t = convexTest(schema, modules);
		await connectSeeds(t);
		const campaignId = await makeCampaign(t);
		const base = { ...realSend, campaignId, organizationId: ORG };

		const first = await t.run(async (ctx) =>
			enqueueSeedShadowCopies(ctx, {
				organizationId: ORG,
				campaignId,
				abVariant: 'A',
				base,
				now: NOW,
			})
		);
		const second = await t.run(async (ctx) =>
			enqueueSeedShadowCopies(ctx, {
				organizationId: ORG,
				campaignId,
				abVariant: 'A',
				base,
				now: NOW + 1_000,
			})
		);
		expect(first).toEqual({ enqueued: 2 });
		expect(second).toEqual({ enqueued: 0 });
		expect(vi.mocked(campaignEmailPool.enqueueAction)).toHaveBeenCalledTimes(2);
		const rows = await t.run(async (ctx) => ctx.db.query('seedPlacementProbes').collect());
		expect(rows).toHaveLength(2);
	});

	it('gives the OTHER A/B arm its own probe set — they are different messages', async () => {
		const t = convexTest(schema, modules);
		await connectSeeds(t);
		const campaignId = await makeCampaign(t);
		const base = { ...realSend, campaignId, organizationId: ORG };

		await t.run(async (ctx) =>
			enqueueSeedShadowCopies(ctx, {
				organizationId: ORG,
				campaignId,
				abVariant: 'A',
				base,
				now: NOW,
			})
		);
		const armB = await t.run(async (ctx) =>
			enqueueSeedShadowCopies(ctx, {
				organizationId: ORG,
				campaignId,
				abVariant: 'B',
				base,
				now: NOW,
			})
		);
		expect(armB).toEqual({ enqueued: 2 });
		const rows = await t.run(async (ctx) => ctx.db.query('seedPlacementProbes').collect());
		expect(rows.filter((r) => r.abVariant === 'A')).toHaveLength(2);
		expect(rows.filter((r) => r.abVariant === 'B')).toHaveLength(2);
	});

	it('does not answer "no probe set yet" once a campaign has many probe rows', async () => {
		// The idempotency lookup used to be a bounded page plus a linear scan; past
		// the bound it silently started minting a duplicate set on every page.
		const t = convexTest(schema, modules);
		await connectSeeds(t);
		const campaignId = await makeCampaign(t);
		await t.run(async (ctx) => {
			const account = await ctx.db.query('externalMailAccounts').first();
			if (!account) throw new Error('fixture missing');
			for (let i = 0; i < 250; i += 1) {
				await ctx.db.insert('seedPlacementProbes', {
					organizationId: ORG,
					probeId: `sp_pad${String(i).padStart(19, '0')}`,
					accountId: account._id,
					provider: 'gmail' as const,
					stream: 'campaign' as const,
					campaignId,
					abVariant: 'B' as const,
					sentAt: NOW - i,
					expiresAt: NOW + SEED_PROBE_RETENTION_MS,
				});
			}
		});

		const outcome = await t.run(async (ctx) =>
			enqueueSeedShadowCopies(ctx, {
				organizationId: ORG,
				campaignId,
				abVariant: 'B',
				base: { ...realSend, campaignId, organizationId: ORG },
				now: NOW,
			})
		);
		expect(outcome).toEqual({ enqueued: 0 });
		expect(vi.mocked(campaignEmailPool.enqueueAction)).not.toHaveBeenCalled();
	});

	/**
	 * (b) The D18 denominator proof against the SHIPPED counters. A probe must
	 * leave no trace in the campaign stat shards or in `sendingReputation` — the
	 * two places a real Send is counted.
	 */
	it('writes no campaign stat shard and no sendingReputation event', async () => {
		const t = convexTest(schema, modules);
		await connectSeeds(t);
		const campaignId = await makeCampaign(t);
		await t.run(async (ctx) =>
			enqueueSeedShadowCopies(ctx, {
				organizationId: ORG,
				campaignId,
				base: { ...realSend, campaignId, organizationId: ORG },
				now: NOW,
			})
		);

		const counted = await t.run(async (ctx) => ({
			shards: await ctx.db.query('campaignStatShards').collect(),
			reputation: await ctx.db.query('sendingReputation').collect(),
			sends: await ctx.db.query('emailSends').collect(),
			transactional: await ctx.db.query('transactionalSends').collect(),
		}));
		expect(counted.shards).toEqual([]);
		expect(counted.reputation).toEqual([]);
		expect(counted.sends).toEqual([]);
		expect(counted.transactional).toEqual([]);
	});
});
