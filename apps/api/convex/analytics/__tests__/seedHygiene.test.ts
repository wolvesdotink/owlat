import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import { internal } from '../../_generated/api';
import schema from '../../schema';
import { insertExternalAccountRow } from '../../mail/externalAccountShared';
import { loadSeedAccounts } from '../seedPlacement';
import type { Id } from '../../_generated/dataModel';
import {
	planSeedHygiene,
	shouldRemindSeedRotation,
	SEED_CLICK_PROBABILITY,
	SEED_ROTATION_INTERVAL_MS,
} from '@owlat/shared/seedPlacement';

const DAY = 24 * 60 * 60 * 1000;

/**
 * (d) Seed hygiene is part of the feature, not a follow-up: a seed that never
 * opens anything trains the provider to distrust us.
 */
describe('planSeedHygiene — probes are marked read', () => {
	it('marks a delivered probe read', () => {
		expect(
			planSeedHygiene({
				placement: 'inbox',
				alreadyMarkedRead: false,
				alreadyClicked: false,
				clickRoll: 0.9,
			})
		).toEqual({ markRead: true, click: false });
	});

	it('marks a probe read wherever it landed — spam and tabs included', () => {
		for (const placement of ['spam', 'category'] as const) {
			expect(
				planSeedHygiene({
					placement,
					alreadyMarkedRead: false,
					alreadyClicked: false,
					clickRoll: 0.99,
				}).markRead
			).toBe(true);
		}
	});

	it('is idempotent — an already-read probe is not marked again', () => {
		expect(
			planSeedHygiene({
				placement: 'inbox',
				alreadyMarkedRead: true,
				alreadyClicked: false,
				clickRoll: 0.99,
			}).markRead
		).toBe(false);
	});

	it('cannot open a probe that was never found', () => {
		expect(
			planSeedHygiene({
				placement: 'missing',
				alreadyMarkedRead: false,
				alreadyClicked: false,
				clickRoll: 0,
			})
		).toEqual({ markRead: false, click: false });
	});
});

describe('planSeedHygiene — the occasional click', () => {
	it('fires below the click probability', () => {
		expect(
			planSeedHygiene({
				placement: 'inbox',
				alreadyMarkedRead: false,
				alreadyClicked: false,
				clickRoll: SEED_CLICK_PROBABILITY - 0.01,
			}).click
		).toBe(true);
	});

	it('does not fire at or above it — the click is OCCASIONAL, not every probe', () => {
		expect(
			planSeedHygiene({
				placement: 'inbox',
				alreadyMarkedRead: false,
				alreadyClicked: false,
				clickRoll: SEED_CLICK_PROBABILITY,
			}).click
		).toBe(false);
	});

	it('never double-clicks the same probe', () => {
		expect(
			planSeedHygiene({
				placement: 'inbox',
				alreadyMarkedRead: true,
				alreadyClicked: true,
				clickRoll: 0,
			})
		).toEqual({ markRead: false, click: false });
	});

	it('keeps the click rate a minority of probes', () => {
		expect(SEED_CLICK_PROBABILITY).toBeGreaterThan(0);
		expect(SEED_CLICK_PROBABILITY).toBeLessThan(0.5);
	});
});

/** (d) The rotation reminder surfaces on schedule — and is only ever a nudge. */
describe('shouldRemindSeedRotation', () => {
	const connectedAt = 1_700_000_000_000;

	it('stays quiet on a freshly connected seed', () => {
		expect(shouldRemindSeedRotation({ connectedAt, now: connectedAt + 30 * DAY })).toBe(false);
	});

	it('fires once the rotation interval has elapsed since connection', () => {
		expect(
			shouldRemindSeedRotation({ connectedAt, now: connectedAt + SEED_ROTATION_INTERVAL_MS })
		).toBe(true);
	});

	it('restarts the clock from the last reminder, so it does not nag', () => {
		const lastRemindedAt = connectedAt + SEED_ROTATION_INTERVAL_MS;
		expect(
			shouldRemindSeedRotation({ connectedAt, lastRemindedAt, now: lastRemindedAt + DAY })
		).toBe(false);
		expect(
			shouldRemindSeedRotation({
				connectedAt,
				lastRemindedAt,
				now: lastRemindedAt + SEED_ROTATION_INTERVAL_MS,
			})
		).toBe(true);
	});

	it('does not fire on clock skew (a "now" before the connection)', () => {
		expect(shouldRemindSeedRotation({ connectedAt, now: connectedAt - DAY })).toBe(false);
	});
});

// ── The EXECUTOR side: the plan is carried out, not merely computed ────────

const rootGlob = import.meta.glob('../../**/*.*s');
const analyticsGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, module]) => [
		path.replace(/^\.\.\//, '../../analytics/'),
		module,
	])
);
const modules = { ...rootGlob, ...analyticsGlob };
const NOW = 1_800_000_000_000;
const ORG = 'org_hygiene';
const PROBE_ID = 'sp_abcdefghij0123456789kl';

const CREDS = {
	emailAddress: 'owlat.seed.02@outlook.example',
	imapHost: 'imap.outlook.example',
	imapPort: 993,
	isImapSecure: true,
	smtpHost: 'smtp.outlook.example',
	smtpPort: 587,
	isSmtpSecure: false,
	imapUsername: 'seed-login-02',
	authMethod: 'password' as const,
	secretCiphertext: 'ct',
	secretIv: 'iv',
	secretAuthTag: 'tag',
	secretEnvelopeVersion: 1,
};

/** Step 1 (connect): tag an external account as a deliverability seed. */
async function connectSeed(t: ReturnType<typeof convexTest>): Promise<{
	accountId: Id<'externalMailAccounts'>;
}> {
	return t.run(async (ctx) => {
		const mailboxId = await ctx.db.insert('mailboxes', {
			userId: 'user_1',
			organizationId: ORG,
			address: 'owlat.seed.02@outlook.example',
			domain: 'outlook.example',
			kind: 'external' as const,
			status: 'active' as const,
			usedBytes: 0,
			uidValidity: NOW,
			createdAt: NOW,
			updatedAt: NOW,
		});
		const accountId = await insertExternalAccountRow(ctx, {
			userId: 'user_1',
			organizationId: ORG,
			mailboxId,
			address: 'owlat.seed.02@outlook.example',
			seed: { seedProvider: 'microsoft' },
			fields: CREDS,
			now: NOW,
		});
		return { accountId };
	});
}

describe('step 1 — connecting a seed mailbox tags it', () => {
	it('writes purpose=seed and the mailbox provider, and the prober finds it', async () => {
		const t = convexTest(schema, modules);
		const { accountId } = await connectSeed(t);
		const row = await t.run(async (ctx) => ctx.db.get(accountId));
		expect(row?.purpose).toBe('seed');
		expect(row?.seedProvider).toBe('microsoft');

		const accounts = await t.run(async (ctx) => loadSeedAccounts(ctx.db, ORG, NOW));
		expect(accounts.map((a) => a.provider)).toEqual(['microsoft']);
	});
});

describe('the hygiene plan is EXECUTED against the ledger row', () => {
	async function withProbe(
		t: ReturnType<typeof convexTest>,
		accountId: Id<'externalMailAccounts'>
	): Promise<Id<'seedPlacementProbes'>> {
		return t.run(async (ctx) =>
			ctx.db.insert('seedPlacementProbes', {
				organizationId: ORG,
				probeId: PROBE_ID,
				accountId,
				provider: 'microsoft',
				stream: 'campaign',
				sentAt: NOW,
				// A probe is only classifiable once it has actually been dispatched.
				dispatchedAt: NOW,
				expiresAt: NOW + 1_000,
			})
		);
	}

	it('marks a found probe read and fires the occasional click', async () => {
		const t = convexTest(schema, modules);
		const { accountId } = await connectSeed(t);
		const probeRef = await withProbe(t, accountId);
		const outcome = await t.mutation(
			internal.analytics.seedPlacement.recordSeedProbeClassification,
			{
				organizationId: ORG,
				probeId: PROBE_ID,
				folderName: 'Junk E-mail',
				now: NOW + 10,
				clickRoll: 0, // below SEED_CLICK_PROBABILITY — the click fires
			}
		);
		expect(outcome).toMatchObject({ recorded: true, placement: 'spam' });
		const row = await t.run(async (ctx) => ctx.db.get(probeRef));
		expect(row?.markedReadAt).toBe(NOW + 10);
		expect(row?.clickedAt).toBe(NOW + 10);
	});

	it('does not click on the common roll, and never touches a MISSING probe', async () => {
		const t = convexTest(schema, modules);
		const { accountId } = await connectSeed(t);
		const probeRef = await withProbe(t, accountId);
		await t.mutation(internal.analytics.seedPlacement.recordSeedProbeClassification, {
			organizationId: ORG,
			probeId: PROBE_ID,
			folderName: null,
			now: NOW + 10,
			clickRoll: 0,
		});
		const row = await t.run(async (ctx) => ctx.db.get(probeRef));
		expect(row?.placement).toBe('missing');
		expect(row?.markedReadAt).toBeUndefined();
		expect(row?.clickedAt).toBeUndefined();
	});

	it('refuses a classification from another organization', async () => {
		const t = convexTest(schema, modules);
		const { accountId } = await connectSeed(t);
		const probeRef = await withProbe(t, accountId);
		const outcome = await t.mutation(
			internal.analytics.seedPlacement.recordSeedProbeClassification,
			{
				organizationId: 'org_other',
				probeId: PROBE_ID,
				folderName: 'INBOX',
				now: NOW + 10,
				clickRoll: 0.9,
			}
		);
		expect(outcome).toEqual({ recorded: false });
		const row = await t.run(async (ctx) => ctx.db.get(probeRef));
		expect(row?.placement).toBeUndefined();
	});
});

describe('the rotation reminder surfaces on schedule', () => {
	it('is due after the interval and is recorded, org-scoped', async () => {
		const t = convexTest(schema, modules);
		const { accountId } = await connectSeed(t);
		const later = NOW + SEED_ROTATION_INTERVAL_MS + DAY;

		const before = await t.run(async (ctx) => loadSeedAccounts(ctx.db, ORG, NOW));
		expect(before[0]?.rotationReminderDue).toBe(false);

		const due = await t.run(async (ctx) => loadSeedAccounts(ctx.db, ORG, later));
		expect(due[0]?.rotationReminderDue).toBe(true);

		expect(
			await t.mutation(internal.analytics.seedPlacement.markSeedRotationReminded, {
				organizationId: 'org_other',
				accountId,
				now: later,
			})
		).toEqual({ updated: false });

		expect(
			await t.mutation(internal.analytics.seedPlacement.markSeedRotationReminded, {
				organizationId: ORG,
				accountId,
				now: later,
			})
		).toEqual({ updated: true });

		const after = await t.run(async (ctx) => loadSeedAccounts(ctx.db, ORG, later));
		expect(after[0]?.rotationReminderDue).toBe(false);
	});
});
