/**
 * THE SCHEDULED SEED PROBE — gate 5's evidence for the streams with no campaign
 * to shadow (P4-7, issue #500).
 *
 * Gate 5 could reach a verdict only on `campaign` cells, because
 * `delivery/seedShadowCopy.ts` is the only producer of probe rows and it
 * shadows a campaign send. The transactional and automation cells of every
 * provider therefore held forever — honestly, and deliberately without
 * borrowing the campaign cell's sweep.
 *
 * What this file asserts, in the order the evidence has to survive:
 *
 *   1. the sweep WRITES the ledger rows, on the right streams, keyed to the
 *      right seed and provider, with no campaign attribution to borrow;
 *   2. it hands the SAME producer/pool/router the stream's real mail uses, with
 *      an envelope that is a probe by construction — the durable reference is
 *      the ledger row and there is no countable Send id anywhere on it;
 *   3. the probe leaves NO trace in any denominator (D18) — no
 *      `transactionalSends` row, no `sendAssignments` row, no reputation event;
 *   4. the CADENCE guard makes a re-run a no-op, which is what makes a retried
 *      tick and an organization split across two pages safe;
 *   5. every absence — no seeds, no sender, an unverified domain — is a silent
 *      no-op and never an error (D2);
 *   6. the message the worker composes carries the poller's join header, and the
 *      automation probe carries a real RFC 8058 one-click target, so the two
 *      streams are measured with the mail those streams actually send;
 *   7. the cron REGISTRATION exists — a sweep nothing starts is a widget.
 *
 * The secret is set at MODULE scope, before any `describe` body runs: vitest
 * executes describe bodies at collection time, so a `beforeAll` would be too
 * late for the composition performed there.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convexTest } from 'convex-test';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { SEED_PROBE_HEADER } from '@owlat/shared/seedPlacement';
import { insertExternalAccountRow } from '../../mail/external/accountShared';
import { createTestDomain, createTestInstanceSettings } from '../../__tests__/factories';
import { SEED_PROBE_RETENTION_MS } from '../../schema/seedPlacement';
import { assertMarketingOneClickHeaders } from '../marketingCompliance';
import { composeForSend } from '../sendComposition';
import {
	SCHEDULED_SEED_PROBE_INTERVAL_MS,
	SCHEDULED_SEED_PROBE_STREAMS,
	buildScheduledSeedProbeMessage,
} from '../seedScheduledProbe';
import { assertSeedShadowExclusion, buildComposeInput } from '../worker';
import { isSeedShadowEnvelope, type WorkerEnvelopeInput } from '../workerEnvelope';
import { transactionalEmailPool } from '../workpool';

// The Workpool component is not registered in convex-test, and the worker action
// would need provider credentials. Stubbing it lets us assert exactly WHAT was
// handed to the pool, which is the "identical transport" half of the claim.
vi.mock('../workpool', () => ({
	transactionalEmailPool: { enqueueAction: vi.fn().mockResolvedValue(undefined) },
	campaignEmailPool: { enqueueAction: vi.fn().mockResolvedValue(undefined) },
}));

const PREV_SECRET = process.env['UNSUBSCRIBE_SECRET'];
process.env['UNSUBSCRIBE_SECRET'] = 'test-unsubscribe-secret';
// The origin the probe's own one-click target is minted against. Every real
// deployment has one; the suite below pins what happens when it does not.
const PREV_SITE_URL = process.env['CONVEX_SITE_URL'];
process.env['CONVEX_SITE_URL'] = 'https://site.convex.example';

afterAll(() => {
	if (PREV_SECRET === undefined) delete process.env['UNSUBSCRIBE_SECRET'];
	else process.env['UNSUBSCRIBE_SECRET'] = PREV_SECRET;
	if (PREV_SITE_URL === undefined) delete process.env['CONVEX_SITE_URL'];
	else process.env['CONVEX_SITE_URL'] = PREV_SITE_URL;
});

// Vite's `import.meta.glob` excludes the directory chain it climbed through, so
// the `../../**` glob omits this file's own `delivery/*` siblings. Merge a
// second glob rooted at `delivery/` and re-prefix its keys, exactly as the
// sibling seed suites do.
const rootGlob = import.meta.glob('../../**/*.*s');
const deliveryGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, module]) => [
		path.replace(/^\.\.\//, '../../delivery/'),
		module,
	])
);
const modules = { ...rootGlob, ...deliveryGlob };

const ORG = 'org_scheduled_probe';
const FROM_EMAIL = 'noreply@org.example';
const FROM_DOMAIN = 'org.example';

const GMAIL_SEED_ADDRESS = 'owlat.seed.gmail@gmail.example';
const MICROSOFT_SEED_ADDRESS = 'owlat.seed.ms@outlook.example';
const SEEDS = [
	{ address: GMAIL_SEED_ADDRESS, provider: 'gmail' as const, login: 'seed-g' },
	{ address: MICROSOFT_SEED_ADDRESS, provider: 'microsoft' as const, login: 'seed-m' },
];

type Harness = ReturnType<typeof convexTest>;

async function connectSeeds(t: Harness, organizationId: string = ORG): Promise<void> {
	const now = Date.now();
	await t.run(async (ctx) => {
		for (const seed of SEEDS) {
			const [, domain] = seed.address.split('@');
			const mailboxId = await ctx.db.insert('mailboxes', {
				userId: 'user_1',
				organizationId,
				address: seed.address,
				domain: domain ?? 'example',
				kind: 'external' as const,
				status: 'active' as const,
				usedBytes: 0,
				uidValidity: now,
				createdAt: now,
				updatedAt: now,
			});
			await insertExternalAccountRow(ctx, {
				userId: 'user_1',
				organizationId,
				mailboxId,
				address: seed.address,
				seed: { seedProvider: seed.provider },
				fields: {
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
				now,
			});
		}
	});
}

/** The deployment's sending identity: a default sender on a VERIFIED domain. */
async function configureSender(
	t: Harness,
	overrides: { fromEmail?: string | null; domainStatus?: 'verified' | 'pending' } = {}
): Promise<void> {
	await t.run(async (ctx) => {
		const fromEmail = overrides.fromEmail === undefined ? FROM_EMAIL : overrides.fromEmail;
		await ctx.db.insert(
			'instanceSettings',
			createTestInstanceSettings({
				defaultFromName: 'Owlat',
				...(fromEmail === null ? { defaultFromEmail: undefined } : { defaultFromEmail: fromEmail }),
			})
		);
		await ctx.db.insert(
			'domains',
			createTestDomain({
				domain: FROM_DOMAIN,
				status: overrides.domainStatus ?? 'verified',
				lastVerifiedAt: Date.now(),
			})
		);
	});
}

function enqueuedEnvelopes(): WorkerEnvelopeInput[] {
	return vi
		.mocked(transactionalEmailPool.enqueueAction)
		.mock.calls.map((call) => call[2]?.['envelopeInput'] as WorkerEnvelopeInput);
}

async function sweep(t: Harness): Promise<{ enqueued: number; examined: number; done: boolean }> {
	return await t.mutation(internal.delivery.seedScheduledProbe.sweepScheduledSeedProbes, {});
}

beforeEach(() => {
	vi.mocked(transactionalEmailPool.enqueueAction).mockClear();
});

// ── (1) + (2) THE ROWS AND THE ENVELOPES ────────────────────────────────────

describe('sweepScheduledSeedProbes — the probes it writes', () => {
	it('covers the two streams that have no campaign to shadow, and only those', () => {
		// Stated as a property of the constant rather than read off a run: the
		// `campaign` cells already have a strictly better producer (a shadow of a
		// real send), and a second producer for them would double their volume.
		expect([...SCHEDULED_SEED_PROBE_STREAMS].sort()).toEqual(['automation', 'transactional']);
	});

	it('writes one ledger row per seed per stream, with the cell key and no campaign', async () => {
		const t = convexTest(schema, modules);
		await connectSeeds(t);
		await configureSender(t);

		const outcome = await sweep(t);
		expect(outcome.enqueued).toBe(4);
		expect(outcome.done).toBe(true);

		const rows = await t.run(async (ctx) => ctx.db.query('seedPlacementProbes').collect());
		expect(rows).toHaveLength(4);
		for (const stream of SCHEDULED_SEED_PROBE_STREAMS) {
			const perStream = rows.filter((row) => row.stream === stream);
			expect(perStream.map((row) => row.provider).sort()).toEqual(['gmail', 'microsoft']);
		}
		for (const row of rows) {
			expect(row.organizationId).toBe(ORG);
			// A scheduled probe shadows no campaign: borrowing a campaign id would
			// put it in the campaign probe set's idempotency key and let one cell's
			// evidence suppress another's.
			expect(row.campaignId).toBeUndefined();
			expect(row.abVariant).toBeUndefined();
			expect(row.expiresAt).toBe(row.sentAt + SEED_PROBE_RETENTION_MS);
			// Not dispatched yet — the worker stamps that, and nothing may read a
			// probe as MISSING before it does.
			expect(row.dispatchedAt).toBeUndefined();
			expect(row.placement).toBeUndefined();
		}
	});

	it('never writes a campaign-stream row — that cell keeps its own producer', async () => {
		const t = convexTest(schema, modules);
		await connectSeeds(t);
		await configureSender(t);
		await sweep(t);

		const rows = await t.run(async (ctx) => ctx.db.query('seedPlacementProbes').collect());
		expect(rows.filter((row) => row.stream === 'campaign')).toEqual([]);
	});

	it('hands the transactional pool an envelope that is a probe by construction', async () => {
		const t = convexTest(schema, modules);
		await connectSeeds(t);
		await configureSender(t);
		await sweep(t);

		const rows = await t.run(async (ctx) => ctx.db.query('seedPlacementProbes').collect());
		const probeIds = new Set(rows.map((row) => row.probeId));
		const calls = vi.mocked(transactionalEmailPool.enqueueAction).mock.calls;
		expect(calls).toHaveLength(4);

		for (const call of calls) {
			const envelope = call[2]?.['envelopeInput'] as WorkerEnvelopeInput;
			if (envelope.kind !== 'transactional') throw new Error('expected a transactional envelope');
			// The CELL: the stream axis is stated on the envelope, which is what
			// makes the governed router route it as that stream's mail.
			expect(SCHEDULED_SEED_PROBE_STREAMS).toContain(envelope.messageType);
			expect(envelope.emailPurpose).toBe(
				envelope.messageType === 'automation' ? 'marketing' : 'transactional'
			);
			expect(envelope.from).toBe(`Owlat <${FROM_EMAIL}>`);
			expect(envelope.providerType).toBe('mta');
			expect(SEEDS.map((seed) => seed.address)).toContain(envelope.to);
			// A probe, and NOT a Send: the ledger row is the whole durable record.
			expect(probeIds.has(envelope.seedProbeId ?? '')).toBe(true);
			expect(envelope.seedProbeRef).toBeDefined();
			expect(envelope.sendId).toBeUndefined();
			expect(envelope.contactId).toBeUndefined();
			expect(isSeedShadowEnvelope(envelope)).toBe(true);
			// No `onComplete`: there is no Send lifecycle to complete (D18).
			expect(call[3]).toBeUndefined();
		}

		// Each stream reaches every seed exactly once.
		for (const stream of SCHEDULED_SEED_PROBE_STREAMS) {
			const recipients = enqueuedEnvelopes()
				.filter((env) => env.kind === 'transactional' && env.messageType === stream)
				.map((env) => env.to)
				.sort();
			expect(recipients).toEqual([GMAIL_SEED_ADDRESS, MICROSOFT_SEED_ADDRESS].sort());
		}
	});

	// ── (3) THE D18 DENOMINATOR PROOF, against the shipped counters ───────────
	it('writes no Send row, no send assignment and no reputation event', async () => {
		const t = convexTest(schema, modules);
		await connectSeeds(t);
		await configureSender(t);
		await sweep(t);

		const counted = await t.run(async (ctx) => ({
			transactional: await ctx.db.query('transactionalSends').collect(),
			sends: await ctx.db.query('emailSends').collect(),
			assignments: await ctx.db.query('sendAssignments').collect(),
			reputation: await ctx.db.query('sendingReputation').collect(),
			shards: await ctx.db.query('campaignStatShards').collect(),
		}));
		expect(counted.transactional).toEqual([]);
		expect(counted.sends).toEqual([]);
		// No `sendAssignments` row is what keeps `analytics/transportOutcomes.ts`
		// from ever bumping the cell's arm shard for a probe.
		expect(counted.assignments).toEqual([]);
		expect(counted.reputation).toEqual([]);
		expect(counted.shards).toEqual([]);
	});
});

// ── (4) THE CADENCE GUARD ───────────────────────────────────────────────────

describe('sweepScheduledSeedProbes — the cadence guard', () => {
	it('is a no-op when the streams were already probed inside the window', async () => {
		const t = convexTest(schema, modules);
		await connectSeeds(t);
		await configureSender(t);

		const first = await sweep(t);
		const second = await sweep(t);
		expect(first.enqueued).toBe(4);
		expect(second.enqueued).toBe(0);
		expect(vi.mocked(transactionalEmailPool.enqueueAction)).toHaveBeenCalledTimes(4);
		const rows = await t.run(async (ctx) => ctx.db.query('seedPlacementProbes').collect());
		expect(rows).toHaveLength(4);
	});

	it('probes again once the window has passed', async () => {
		const t = convexTest(schema, modules);
		await connectSeeds(t);
		await configureSender(t);
		await sweep(t);

		// Age the ledger rather than the clock: the guard reads `sentAt`, so this
		// is the same thing a day of wall time would produce.
		await t.run(async (ctx) => {
			for (const row of await ctx.db.query('seedPlacementProbes').collect()) {
				await ctx.db.patch(row._id, {
					sentAt: row.sentAt - SCHEDULED_SEED_PROBE_INTERVAL_MS - 1,
				});
			}
		});

		const second = await sweep(t);
		expect(second.enqueued).toBe(4);
		const rows = await t.run(async (ctx) => ctx.db.query('seedPlacementProbes').collect());
		expect(rows).toHaveLength(8);
	});

	it('does not let one stream suppress the other', async () => {
		const t = convexTest(schema, modules);
		await connectSeeds(t);
		await configureSender(t);
		await sweep(t);

		await t.run(async (ctx) => {
			for (const row of await ctx.db.query('seedPlacementProbes').collect()) {
				if (row.stream !== 'transactional') continue;
				await ctx.db.patch(row._id, {
					sentAt: row.sentAt - SCHEDULED_SEED_PROBE_INTERVAL_MS - 1,
				});
			}
		});

		vi.mocked(transactionalEmailPool.enqueueAction).mockClear();
		const second = await sweep(t);
		expect(second.enqueued).toBe(2);
		const streams = enqueuedEnvelopes().map((env) =>
			env.kind === 'transactional' ? env.messageType : 'campaign'
		);
		expect(streams).toEqual(['transactional', 'transactional']);
	});
});

// ── (5) D2 — EVERY ABSENCE IS A SILENT NO-OP ────────────────────────────────

describe('sweepScheduledSeedProbes — absence is a supported configuration', () => {
	it('does nothing at all with no seed mailboxes connected', async () => {
		const t = convexTest(schema, modules);
		await configureSender(t);

		const outcome = await sweep(t);
		expect(outcome).toEqual({ enqueued: 0, examined: 0, done: true });
		expect(vi.mocked(transactionalEmailPool.enqueueAction)).not.toHaveBeenCalled();
		const rows = await t.run(async (ctx) => ctx.db.query('seedPlacementProbes').collect());
		expect(rows).toEqual([]);
		// And nothing scheduled behind it either.
		const scheduled = await t.run(async (ctx) =>
			ctx.db.system.query('_scheduled_functions').collect()
		);
		expect(scheduled).toEqual([]);
	});

	it('mails nothing when the deployment has no default sender', async () => {
		const t = convexTest(schema, modules);
		await connectSeeds(t);
		await configureSender(t, { fromEmail: null });

		const saved = process.env['DEFAULT_FROM_EMAIL'];
		delete process.env['DEFAULT_FROM_EMAIL'];
		try {
			const outcome = await sweep(t);
			expect(outcome.enqueued).toBe(0);
		} finally {
			if (saved !== undefined) process.env['DEFAULT_FROM_EMAIL'] = saved;
		}
		expect(vi.mocked(transactionalEmailPool.enqueueAction)).not.toHaveBeenCalled();
	});

	it('mails nothing from an UNVERIFIED sending domain', async () => {
		// A probe from an unverified domain measures the deployment's DNS, not its
		// placement: it would be filtered on authentication alone and would teach
		// gate 5 that every non-campaign cell had collapsed.
		const t = convexTest(schema, modules);
		await connectSeeds(t);
		await configureSender(t, { domainStatus: 'pending' });

		const outcome = await sweep(t);
		expect(outcome.enqueued).toBe(0);
		expect(vi.mocked(transactionalEmailPool.enqueueAction)).not.toHaveBeenCalled();
		const rows = await t.run(async (ctx) => ctx.db.query('seedPlacementProbes').collect());
		expect(rows).toEqual([]);
	});

	it('skips only the AUTOMATION stream when there is no origin to mint a one-click target against', async () => {
		// Marketing-shaped mail must carry an RFC 8058 one-click target; without an
		// origin the probe would be a materially different message from the
		// stream's real mail, so that stream goes unmeasured rather than measured
		// wrong. The transactional stream needs no such target and is unaffected.
		const t = convexTest(schema, modules);
		await connectSeeds(t);
		await configureSender(t);

		const saved = process.env['CONVEX_SITE_URL'];
		delete process.env['CONVEX_SITE_URL'];
		try {
			const outcome = await sweep(t);
			expect(outcome.enqueued).toBe(2);
		} finally {
			if (saved !== undefined) process.env['CONVEX_SITE_URL'] = saved;
		}
		const rows = await t.run(async (ctx) => ctx.db.query('seedPlacementProbes').collect());
		expect(new Set(rows.map((row) => row.stream))).toEqual(new Set(['transactional']));
	});

	it('mails nothing to a seed the poller will never walk', async () => {
		const t = convexTest(schema, modules);
		await connectSeeds(t);
		await configureSender(t);
		await t.run(async (ctx) => {
			for (const account of await ctx.db.query('externalMailAccounts').collect()) {
				const mailbox = await ctx.db.get(account.mailboxId);
				if (mailbox?.address !== GMAIL_SEED_ADDRESS) continue;
				await ctx.db.patch(account._id, { status: 'auth_error' as const, updatedAt: Date.now() });
			}
		});

		const outcome = await sweep(t);
		expect(outcome.enqueued).toBe(2);
		const recipients = new Set(enqueuedEnvelopes().map((env) => env.to));
		expect([...recipients]).toEqual([MICROSOFT_SEED_ADDRESS]);
	});
});

// ── (6) THE MESSAGE THE WORKER COMPOSES ─────────────────────────────────────

describe('the scheduled probe as a composed message', () => {
	const NOW = 1_800_000_000_000;
	const PROBE_ID = 'sp_a1b2c3d4e5f60718293a4b';
	const PROBE_REF = 'probe1' as Id<'seedPlacementProbes'>;

	function probeEnvelope(stream: 'transactional' | 'automation'): WorkerEnvelopeInput {
		return {
			kind: 'transactional',
			deliveryDomain: 'production',
			messageType: stream,
			emailPurpose: stream === 'automation' ? 'marketing' : 'transactional',
			to: GMAIL_SEED_ADDRESS,
			from: FROM_EMAIL,
			providerType: 'mta',
			template: buildScheduledSeedProbeMessage(stream, NOW),
			organizationId: ORG,
			convexSiteUrl: 'https://site.convex.example',
			...(stream === 'automation' ? { listUnsubscribe: true } : {}),
			seedProbeId: PROBE_ID,
			seedProbeRef: PROBE_REF,
		};
	}

	it('stamps the poller its join header, and stamps it on nothing else', () => {
		const probe = composeForSend(buildComposeInput(probeEnvelope('transactional')));
		expect(probe.headers[SEED_PROBE_HEADER]).toBe(PROBE_ID);

		const real = probeEnvelope('transactional');
		if (real.kind !== 'transactional') throw new Error('unreachable');
		delete real.seedProbeId;
		delete real.seedProbeRef;
		const composedReal = composeForSend(buildComposeInput(real));
		expect(composedReal.headers[SEED_PROBE_HEADER]).toBeUndefined();
	});

	it('gives the automation probe a real RFC 8058 one-click target of its own', async () => {
		const envelope = probeEnvelope('automation');
		const { buildTransactionalListUnsubscribe } = await import('../worker');
		const headers = {
			...buildTransactionalListUnsubscribe(envelope),
			...composeForSend(buildComposeInput(envelope)).headers,
		};
		// The gate every marketing-shaped message must clear — the probe measures
		// the automation stream's mail, so it has to be that mail.
		expect(() => assertMarketingOneClickHeaders('marketing', headers)).not.toThrow();
		// Probe-scoped, not contact-scoped: it can reach no contact record.
		expect(headers['List-Unsubscribe']).toContain('/unsub/probe/');
	});

	it('carries no one-click pair on the transactional stream, exactly as real 1:1 mail does not', async () => {
		const { buildTransactionalListUnsubscribe } = await import('../worker');
		expect(buildTransactionalListUnsubscribe(probeEnvelope('transactional'))).toEqual({});
	});

	it('renders a distinct message per day, so the instrument does not become a pattern', () => {
		const day1 = buildScheduledSeedProbeMessage('transactional', NOW);
		const day2 = buildScheduledSeedProbeMessage('transactional', NOW + 24 * 60 * 60 * 1000);
		expect(day1.subject).not.toBe(day2.subject);
	});
});

// ── THE D18 EXCLUSION, ON THE ENVELOPE THAT CARRIES A COUNTABLE ID ──────────

describe('assertSeedShadowExclusion — now that a transactional envelope can be a probe', () => {
	const PROBE_ID = 'sp_a1b2c3d4e5f60718293a4b';
	const PROBE_REF = 'probe1' as Id<'seedPlacementProbes'>;
	const base = {
		kind: 'transactional' as const,
		emailPurpose: 'transactional' as const,
		to: GMAIL_SEED_ADDRESS,
		from: FROM_EMAIL,
		template: { subject: 'Delivery check', htmlContent: '<p>Check</p>' },
		seedProbeId: PROBE_ID,
		seedProbeRef: PROBE_REF,
	};

	it('accepts a probe carrying only its ledger reference', () => {
		expect(() => assertSeedShadowExclusion(base)).not.toThrow();
	});

	it('refuses a probe that also carries a countable transactional Send', () => {
		expect(() =>
			assertSeedShadowExclusion({ ...base, sendId: 's1' as Id<'transactionalSends'> })
		).toThrow(/countable Send or a contact/);
	});

	it('refuses a probe that also carries a contact', () => {
		expect(() => assertSeedShadowExclusion({ ...base, contactId: 'c1' as Id<'contacts'> })).toThrow(
			/countable Send or a contact/
		);
	});

	it('refuses a probe with no ledger reference to be attributed against', () => {
		const orphan = { ...base } as Record<string, unknown>;
		delete orphan['seedProbeRef'];
		expect(() => assertSeedShadowExclusion(orphan as WorkerEnvelopeInput)).toThrow(
			/probe ledger reference/
		);
	});
});

// ── (7) A SWEEP NOTHING STARTS IS A WIDGET ──────────────────────────────────

describe('the scheduled probe is registered as a cron', () => {
	const convexRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

	it('names both the cron and the entry point, and the registration is called', () => {
		// Assert BOTH halves, so neither the registration nor the call into it can
		// be dropped unnoticed: a cron target with no registration never runs, and
		// a registration `crons.ts` never calls registers nothing.
		const registration = readFileSync(join(convexRoot, 'delivery', 'cronRegistration.ts'), 'utf8');
		expect(registration).toContain("'sweep scheduled seed probes'");
		expect(registration).toContain('internal.delivery.seedScheduledProbe.sweepScheduledSeedProbes');
		const crons = readFileSync(join(convexRoot, 'crons.ts'), 'utf8');
		expect(crons).toContain('registerDeliveryCrons(crons)');
	});
});
