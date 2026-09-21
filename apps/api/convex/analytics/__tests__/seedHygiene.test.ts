import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import { api, internal } from '../../_generated/api';
import schema from '../../schema';
import { insertExternalAccountRow } from '../../mail/external/accountShared';
import { summarizeSeedPlacementWindow } from '../seedPlacement';
import { loadSeedAccounts } from '../seedAccounts';
import type { Id } from '../../_generated/dataModel';
import { modules } from '../../__tests__/testModules';
import {
	planSeedHygiene,
	shouldRemindSeedRotation,
	SEED_CLICK_PROBABILITY,
	SEED_ROTATION_INTERVAL_MS,
} from '@owlat/shared/seedPlacement';

/**
 * The rotation nudge has to be readable through a query the PRODUCT exposes,
 * and dismissable only by a human — so this suite drives `auditLogs.list`
 * (adminQuery) and `mail.external.accountsSeed.acknowledgeSeedRotation`
 * (adminMutation) for real. Both sit behind the org session, which convex-test
 * has no identity for; the mock is the shipped pattern from
 * `__tests__/auditLogsRead.integration.test.ts`. The internal mutations this
 * file also exercises never touch the session, so they are unaffected.
 */
vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	const session = { userId: 'admin-1', activeOrganizationId: 'org_hygiene', role: 'owner' };
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue(session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue(session.userId),
		getMutationContext: vi.fn().mockResolvedValue(session),
		requireOrgPermission: vi.fn().mockResolvedValue(session),
		requireAdminContext: vi.fn().mockResolvedValue(session),
		getBetterAuthSessionWithRole: vi.fn().mockResolvedValue(session),
	};
});

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

	it('restarts the clock from the operator ACKNOWLEDGEMENT, so it does not nag', () => {
		const lastAcknowledgedAt = connectedAt + SEED_ROTATION_INTERVAL_MS;
		expect(
			shouldRemindSeedRotation({
				connectedAt,
				lastAcknowledgedAt,
				now: lastAcknowledgedAt + DAY,
			})
		).toBe(false);
		expect(
			shouldRemindSeedRotation({
				connectedAt,
				lastAcknowledgedAt,
				now: lastAcknowledgedAt + SEED_ROTATION_INTERVAL_MS,
			})
		).toBe(true);
	});

	it('does not fire on clock skew (a "now" before the connection)', () => {
		expect(shouldRemindSeedRotation({ connectedAt, now: connectedAt - DAY })).toBe(false);
	});
});

// ── The EXECUTOR side: the plan is carried out, not merely computed ────────

const NOW = 1_800_000_000_000;
const ORG = 'org_hygiene';
const PROBE_ID = 'sp_a1b2c3d4e5f60718293a4b';

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
async function connectSeed(
	t: ReturnType<typeof convexTest>,
	organizationId: string = ORG,
	address: string = 'owlat.seed.02@outlook.example'
): Promise<{
	accountId: Id<'externalMailAccounts'>;
}> {
	return t.run(async (ctx) => {
		const mailboxId = await ctx.db.insert('mailboxes', {
			userId: 'user_1',
			organizationId,
			address,
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
			organizationId,
			mailboxId,
			address,
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
		// Named reason, not a bare refusal: the worker has to be able to tell
		// "not yours" from "gone".
		expect(outcome).toEqual({ recorded: false, reason: 'foreign_organization' });
		const row = await t.run(async (ctx) => ctx.db.get(probeRef));
		expect(row?.placement).toBeUndefined();
	});
});

describe('the rotation reminder surfaces on schedule', () => {
	/**
	 * THE PRODUCTION PATH, end to end.
	 *
	 * The nudge is emitted by a Convex cron and nothing else — no IMAP session,
	 * no credential, no worker — so these cases drive the cron mutation the way
	 * the scheduler does, with the wall clock pinned (the cron takes no clock
	 * from its caller, by design: a background sweep has no business being told
	 * what time it is).
	 */
	async function sweep(
		t: ReturnType<typeof convexTest>,
		at: number
	): Promise<{ reminded: number; examined: number; done: boolean }> {
		const clock = vi.spyOn(Date, 'now').mockReturnValue(at);
		try {
			return await t.mutation(internal.analytics.seedRotationSweep.sweepSeedRotationReminders, {});
		} finally {
			clock.mockRestore();
		}
	}

	/**
	 * The reminders an OPERATOR can actually see — read back through
	 * `auditLogs.list`, the admin query the product ships, not through a raw
	 * table scan. An artifact only a test can find is not a reminder.
	 */
	async function reminders(t: ReturnType<typeof convexTest>) {
		const res = await t.query(api.auditLogs.list, { action: 'seed_mailbox.rotation_reminder' });
		return res.logs;
	}

	/** The other readable surface: what P3-6's cell screen renders. */
	async function remindersDue(t: ReturnType<typeof convexTest>, now: number): Promise<number> {
		const summary = await t.run(async (ctx) => summarizeSeedPlacementWindow(ctx.db, ORG, now));
		return summary.rotationRemindersDue;
	}

	/**
	 * The OPERATOR dismisses the nudge, at a stated instant.
	 *
	 * `acknowledgeSeedRotation` stamps `Date.now()` (a user-facing mutation has no
	 * business taking a clock from its caller), so the wall clock is pinned for
	 * the call — otherwise the synthetic timeline these cases run on would land
	 * the acknowledgement BEFORE the reminder it answers and the assertions would
	 * be measuring the test's own clock skew.
	 */
	async function acknowledge(
		t: ReturnType<typeof convexTest>,
		accountId: Id<'externalMailAccounts'>,
		at: number
	): Promise<void> {
		const clock = vi.spyOn(Date, 'now').mockReturnValue(at);
		try {
			await t.mutation(api.mail.external.accountsSeed.acknowledgeSeedRotation, { accountId });
		} finally {
			clock.mockRestore();
		}
	}

	it('is due after the interval and EMITS an artifact the operator can read', async () => {
		const t = convexTest(schema, modules);
		const { accountId } = await connectSeed(t);
		const later = NOW + SEED_ROTATION_INTERVAL_MS + DAY;

		const before = await t.run(async (ctx) => loadSeedAccounts(ctx.db, ORG, NOW));
		expect(before[0]?.rotationReminderDue).toBe(false);
		// A sweep before the interval says nothing at all.
		expect(await sweep(t, NOW + DAY)).toMatchObject({ reminded: 0, examined: 1 });
		expect(await reminders(t)).toEqual([]);

		const due = await t.run(async (ctx) => loadSeedAccounts(ctx.db, ORG, later));
		expect(due[0]?.rotationReminderDue).toBe(true);
		expect(await sweep(t, later)).toMatchObject({ reminded: 1, done: true });

		// THE ARTIFACT, through the shipped admin query.
		const emitted = await reminders(t);
		expect(emitted).toHaveLength(1);
		expect(emitted[0]?.resource).toBe('seed_mailbox');
		expect(emitted[0]?.resourceId).toBe(accountId);
		expect(emitted[0]?.details).toEqual({ provider: 'microsoft', ageDays: 91 });
		// Advisory, and carrying no address or credential (D2 + the security rule).
		expect(JSON.stringify(emitted[0])).not.toContain('owlat.seed.02@outlook.example');
	});

	it('reaches an IDLE seed — one with no probe work whatsoever (the round-3 defect)', async () => {
		// The seed the operator most needs nudged is the one nothing is happening
		// to: every probe long since classified, or none ever sent. While the
		// emission hung off `listSeedProbeWork` this account produced no work item
		// and therefore no reminder, for as long as the deployment stayed idle.
		const t = convexTest(schema, modules);
		await connectSeed(t);
		const later = NOW + SEED_ROTATION_INTERVAL_MS + DAY;

		const work = await t.query(internal.analytics.seedProbePoller.listSeedProbeWork, {
			now: later,
			cursor: null,
		});
		expect(work.items).toEqual([]);

		expect(await sweep(t, later)).toMatchObject({ reminded: 1, examined: 1, done: true });
		expect(await reminders(t)).toHaveLength(1);
		expect(await remindersDue(t, later)).toBe(1);
	});

	it('reaches a seed in auth_error — the one most in need of replacing', async () => {
		// `CONNECTABLE_ACCOUNT_STATUSES` is the right filter for "can the worker
		// open this mailbox" and exactly the wrong one for "should the operator be
		// told to replace this seed", so the cron applies no status filter at all.
		const t = convexTest(schema, modules);
		const { accountId } = await connectSeed(t);
		await t.run(async (ctx) => ctx.db.patch(accountId, { status: 'auth_error' as const }));
		const later = NOW + SEED_ROTATION_INTERVAL_MS + DAY;

		// The IMAP poller still skips it — that half is unchanged and correct.
		const work = await t.query(internal.analytics.seedProbePoller.listSeedProbeWork, {
			now: later,
			cursor: null,
		});
		expect(work.items).toEqual([]);

		expect(await sweep(t, later)).toMatchObject({ reminded: 1 });
		expect(await reminders(t)).toHaveLength(1);
	});

	it('scopes each artifact to the org that owns the seed', async () => {
		const t = convexTest(schema, modules);
		await connectSeed(t);
		await connectSeed(t, 'org_other', 'seed@other.example');
		const later = NOW + SEED_ROTATION_INTERVAL_MS + DAY;

		expect(await sweep(t, later)).toMatchObject({ reminded: 2, examined: 2 });
		// The admin query is org-scoped, so the session's org sees ONE row: its own.
		const emitted = await reminders(t);
		expect(emitted).toHaveLength(1);
		expect(emitted[0]?.organizationId).toBe(ORG);
		expect(JSON.stringify(emitted)).not.toContain('seed@other.example');
	});

	it('does NOT extinguish the due count — only an operator can (the round-2 defect)', async () => {
		const t = convexTest(schema, modules);
		const { accountId } = await connectSeed(t);
		const later = NOW + SEED_ROTATION_INTERVAL_MS + DAY;
		expect(await remindersDue(t, later)).toBe(1);

		// Three cron ticks with no human anywhere near them.
		for (const now of [later, later + 1000, later + 2000]) await sweep(t, now);
		// One audit row, not one per tick...
		expect(await reminders(t)).toHaveLength(1);
		// ...and the readable count is still standing. A background sweep must
		// never be able to clear the signal it just raised.
		expect(await remindersDue(t, later + 2000)).toBe(1);

		// The operator dismisses it — and only that restarts the 90-day clock.
		await acknowledge(t, accountId, later + 3000);
		expect(await remindersDue(t, later + 4000)).toBe(0);
	});

	it('emits NOTHING and clears NOTHING when the reminder is not yet due', async () => {
		const t = convexTest(schema, modules);
		await connectSeed(t);

		expect(await sweep(t, NOW + DAY)).toMatchObject({ reminded: 0 });
		expect(await reminders(t)).toEqual([]);

		// The clock was never restarted, so the reminder still arrives on schedule.
		const later = NOW + SEED_ROTATION_INTERVAL_MS + DAY;
		expect(await remindersDue(t, later)).toBe(1);
	});

	it('re-arms after an acknowledgement, one artifact per un-acknowledged cycle', async () => {
		const t = convexTest(schema, modules);
		const { accountId } = await connectSeed(t);
		const first = NOW + SEED_ROTATION_INTERVAL_MS + DAY;
		await sweep(t, first);
		const acknowledgedAt = first + DAY;
		await acknowledge(t, accountId, acknowledgedAt);
		expect(
			await t.run(async (ctx) => (await ctx.db.get(accountId))?.seedRotationAcknowledgedAt)
		).toBe(acknowledgedAt);

		const second = acknowledgedAt + SEED_ROTATION_INTERVAL_MS + DAY;
		expect(await remindersDue(t, second)).toBe(1);
		expect(await sweep(t, second)).toMatchObject({ reminded: 1 });
		expect(await reminders(t)).toHaveLength(2);
	});

	it('is a silent no-op with no seed mailboxes connected at all (D2)', async () => {
		const t = convexTest(schema, modules);
		expect(await sweep(t, NOW + SEED_ROTATION_INTERVAL_MS)).toEqual({
			reminded: 0,
			examined: 0,
			done: true,
		});
		expect(await reminders(t)).toEqual([]);
	});

	it('refuses to acknowledge another org’s seed', async () => {
		const t = convexTest(schema, modules);
		const { accountId } = await connectSeed(t, 'org_other', 'seed@other.example');
		await expect(
			t.mutation(api.mail.external.accountsSeed.acknowledgeSeedRotation, { accountId })
		).rejects.toThrow();
	});
});
