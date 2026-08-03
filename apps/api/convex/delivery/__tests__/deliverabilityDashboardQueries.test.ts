/**
 * Deliverability dashboard — the org-scoped read queries (plan D2, D5, D14).
 *
 * What this file pins:
 *
 *   - the query returns THE SUMMARIZER'S numbers, unchanged. Every rate is
 *     compared field-by-field against `summarizeTransportOutcomeBuckets` run
 *     over the same rows, so a hand-rolled division sneaking into the read path
 *     fails here rather than in production, where the screen and the ramp
 *     controller would quietly disagree (ADR-0042 / plan D5);
 *   - CROSS-TENANT READS ARE REFUSED: another organization's buckets are never
 *     summed in, and a caller who is not an org member gets nothing at all;
 *   - the STANDALONE configuration (no reference transport) is clean: every
 *     cell reports `reference: null`, no gate fails, nothing throws (plan D2);
 *   - a legacy, share-less route state resolves through D1's helper;
 *   - thin data HOLDS rather than failing (plan D10).
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import schema from '../../schema';
import { api } from '../../_generated/api';
import type { Doc } from '../../_generated/dataModel';
import type { DatabaseWriter } from '../../_generated/server';
import { deliverabilityCellKey } from '@owlat/shared/deliverabilityRouting';
import { summarizeTransportOutcomeBuckets } from '../../analytics/transportOutcomeSummary';
import { startOfDayUtc } from '../../lib/clock';
import { ENGAGEMENT_GATE_THRESHOLDS } from '../ramp/engagementConfig';
import { RAMP_GATE_SAMPLE_FLOORS } from '../ramp/gateConfig';
import type { DeliverabilityDashboard } from '../deliverabilityDashboard';
import { modules } from '../../__tests__/testModules';

const DASHBOARD_ORG = 'org_dashboard';
const OTHER_ORG = 'org_intruder';

const sessionMocks = vi.hoisted(() => ({ refuse: false }));

vi.mock('../../lib/sessionOrganization', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../lib/sessionOrganization')>();
	return {
		...actual,
		requireOrgMember: vi.fn(async () => {
			if (sessionMocks.refuse) throw new Error('You do not have access to this organization');
			return { userId: 'user-1', role: 'owner' as const, activeOrganizationId: 'org_dashboard' };
		}),
		getUserIdFromSession: vi.fn().mockResolvedValue('user-1'),
		// The literal, not the constant: `vi.mock` factories are hoisted above the
		// imports, so referencing one here is a TDZ error at load time.
		getSingletonOrganizationId: vi.fn().mockResolvedValue('org_dashboard'),
	};
});

/**
 * THE CLOCK IS PART OF THE FIXTURE. Every row below is placed relative to a UTC
 * day the test computes, and the query reads its own `Date.now()` to derive the
 * window it summarizes over. A run that straddles UTC midnight would put the two
 * on different days and the trend assertions would fail for a reason that has
 * nothing to do with the code — so it is pinned, mid-day, well away from the
 * boundary.
 */
const FIXED_NOW = new Date('2026-07-15T12:00:00.000Z');

beforeEach(() => {
	// ONLY the clock: faking timers as well would stall convex-test's own async
	// machinery, and the thing under test here is the date, not scheduling.
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(FIXED_NOW);
});

afterEach(() => {
	vi.useRealTimers();
	sessionMocks.refuse = false;
});

const GMAIL_CAMPAIGN = deliverabilityCellKey({ stream: 'campaign', destinationProvider: 'gmail' });

type BucketRow = Omit<Doc<'transportOutcomes'>, '_id' | '_creationTime'>;

function bucket(overrides: Partial<BucketRow> & { periodStart: number }): BucketRow {
	return {
		organizationId: DASHBOARD_ORG,
		cell: GMAIL_CAMPAIGN,
		arm: 'own',
		shardKey: 0,
		sent: 0,
		delivered: 0,
		deferred: 0,
		softBounced: 0,
		hardBounced: 0,
		complained: 0,
		opened: 0,
		clicked: 0,
		unsubscribed: 0,
		calibrationSent: 0,
		calibrationOpened: 0,
		calibrationClicked: 0,
		lastRecordedAt: overrides.periodStart,
		...overrides,
	};
}

/** A relay route makes the deployment two-armed; omitting it is standalone. */
async function seedRelayRoute(ctx: { db: DatabaseWriter }): Promise<void> {
	await ctx.db.insert('providerRoutes', {
		messageType: 'campaign',
		strategy: 'priority_failover',
		providers: [
			{ providerType: 'mta', isEnabled: true },
			{ providerType: 'ses', isEnabled: true },
		],
		createdAt: 0,
		updatedAt: 0,
	});
}

function gmailCell(dashboard: DeliverabilityDashboard): DeliverabilityDashboard['cells'][number] {
	const cell = dashboard.cells.find((entry) => entry.cellKey === GMAIL_CAMPAIGN);
	if (cell === undefined) throw new Error('gmail campaign cell missing from the dashboard');
	return cell;
}

describe('getDeliverabilityDashboard — derived rates', () => {
	it('returns the summarizer’s rates verbatim for both arms', async () => {
		const t = convexTest(schema, modules);
		const day = startOfDayUtc(Date.now()) - 24 * 60 * 60 * 1000;
		const ownRows = [
			bucket({ periodStart: day, shardKey: 0, sent: 600, delivered: 580, hardBounced: 6 }),
			bucket({
				periodStart: day,
				shardKey: 3,
				sent: 400,
				delivered: 390,
				hardBounced: 4,
				opened: 200,
				calibrationSent: 500,
				calibrationOpened: 120,
			}),
		];
		const referenceRows = [
			bucket({ periodStart: day, shardKey: 1, arm: 'reference', sent: 900, delivered: 880 }),
		];
		await t.run(async (ctx) => {
			await seedRelayRoute(ctx);
			for (const row of [...ownRows, ...referenceRows]) {
				await ctx.db.insert('transportOutcomes', row);
			}
		});

		const dashboard = await t.query(
			api.delivery.deliverabilityDashboard.getDeliverabilityDashboard,
			{}
		);
		const cell = gmailCell(dashboard);
		const window = { since: dashboard.windowStart, until: dashboard.windowEnd };

		// The ONE derivation seam, run here over the same rows: the query may not
		// produce a different number from it, ever.
		expect(cell.own).toEqual(summarizeTransportOutcomeBuckets(ownRows, window));
		expect(cell.reference).toEqual(summarizeTransportOutcomeBuckets(referenceRows, window));
		expect(cell.own.sent).toBe(1000);
		expect(cell.own.hardBounceRate).toBeCloseTo(0.01, 10);
		expect(dashboard.referenceTransportId).toBe('ses');
	});

	it('emits one trend point per day of the window, each derived by the summarizer', async () => {
		const t = convexTest(schema, modules);
		const dayMs = 24 * 60 * 60 * 1000;
		const yesterday = startOfDayUtc(Date.now()) - dayMs;
		const row = bucket({ periodStart: yesterday, shardKey: 0, sent: 40, delivered: 39 });
		await t.run(async (ctx) => {
			await ctx.db.insert('transportOutcomes', row);
		});

		const dashboard = await t.query(
			api.delivery.deliverabilityDashboard.getDeliverabilityDashboard,
			{}
		);
		const cell = gmailCell(dashboard);
		const point = cell.trend.find((entry) => entry.day === yesterday);
		expect(cell.trend.length).toBe(7);
		expect(point?.own).toEqual(
			summarizeTransportOutcomeBuckets([row], { since: yesterday, until: yesterday + dayMs })
		);
		// A quiet day is still a point — a trend with holes reads as continuous traffic.
		expect(cell.trend.every((entry) => entry.own.sent >= 0)).toBe(true);
	});
});

describe('getDeliverabilityDashboard — tenant isolation', () => {
	it('never sums another organization’s buckets into a cell', async () => {
		const t = convexTest(schema, modules);
		const day = startOfDayUtc(Date.now()) - 24 * 60 * 60 * 1000;
		await t.run(async (ctx) => {
			await ctx.db.insert('transportOutcomes', bucket({ periodStart: day, sent: 10 }));
			await ctx.db.insert(
				'transportOutcomes',
				bucket({ periodStart: day, shardKey: 1, organizationId: OTHER_ORG, sent: 5000 })
			);
		});

		const dashboard = await t.query(
			api.delivery.deliverabilityDashboard.getDeliverabilityDashboard,
			{}
		);
		expect(gmailCell(dashboard).own.sent).toBe(10);
	});

	it('never reads another organization’s route state', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('deliverabilityRouteStates', {
				organizationId: OTHER_ORG,
				destinationProvider: 'gmail',
				stream: 'campaign',
				isFallbackActive: true,
				ownShare: 0.1,
				signals: [],
				snapshotGeneratedAt: 0,
				expiresAt: Date.now() + 60_000,
				updatedAt: 0,
			});
		});

		const dashboard = await t.query(
			api.delivery.deliverabilityDashboard.getDeliverabilityDashboard,
			{}
		);
		// No row for THIS org: D1's default — the own MTA carries everything.
		expect(gmailCell(dashboard).ownShare).toBe(1);
	});

	it('refuses a caller who is not an organization member', async () => {
		const t = convexTest(schema, modules);
		sessionMocks.refuse = true;
		await expect(
			t.query(api.delivery.deliverabilityDashboard.getDeliverabilityDashboard, {})
		).rejects.toThrow(/access/i);
	});

	/**
	 * The case above proves the handler AWAITS the membership check; it cannot
	 * prove the function is gated, because the check it exercises is mocked. What
	 * makes the gate real is the WRAPPER, so that is asserted statically: the
	 * module must build on `authedQuery` and must not reach for a bare `query`,
	 * and it must take no `organizationId` argument a caller could forge.
	 */
	it('is built on the authed wrapper and takes no forgeable org argument', () => {
		const source = readFileSync(
			resolve(dirname(fileURLToPath(import.meta.url)), '../deliverabilityDashboard.ts'),
			'utf8'
		);
		expect(source).toContain('authedQuery({');
		expect(source).not.toMatch(/\bimport\b[^;]*\bquery\b[^;]*from '\.\.\/_generated\/server'/);
		expect(source).not.toMatch(/^\s*organizationId: v\./m);
	});
});

describe('getDeliverabilityDashboard — window composition', () => {
	/**
	 * The disjointness `dashboardWindow` guarantees is only worth anything if the
	 * shell actually READS the baseline span, and reads it OUTSIDE the evaluation
	 * window. Asserted end-to-end and by placement alone: the same two rows, with
	 * the same counters, land in the baseline span in the first case and inside
	 * the evaluation window in the second, and nothing else differs.
	 *
	 * The deployment is standalone on purpose. Gate 4's aggregator reports the
	 * concurrent ratio unless the slow-poison FLOOR fails, so the floor — the one
	 * comparison that consumes the baseline — is only observable at this boundary
	 * when it fires. With no reference arm the ratio can only hold, which leaves
	 * the floor free to be the verdict the screen shows.
	 */
	const DAY = 24 * 60 * 60 * 1000;
	/** Engaged, and large enough to be a denominator: 20% of a 1500-send slice. */
	const BASELINE_CALIBRATION_SENT = ENGAGEMENT_GATE_THRESHOLDS.baselineMinSample + 300;
	const BASELINE_CALIBRATION_OPENED = 300;
	/** Recent, above the recent floor, and engaging four times worse. */
	const RECENT_CALIBRATION_SENT = RAMP_GATE_SAMPLE_FLOORS.engagementRecent + 100;
	const RECENT_CALIBRATION_OPENED = 25;

	function engagementGate(dashboard: DeliverabilityDashboard) {
		const gate = gmailCell(dashboard).gates.find((entry) => entry.gate === 'engagement_ratio');
		if (gate === undefined) throw new Error('engagement gate missing from the cell');
		return gate;
	}

	/**
	 * @param baselineDayOffset days before "tomorrow" the engaged slice sits at.
	 *   20 puts it in the baseline span [-30d, -7d); 3 puts it inside the
	 *   evaluation window [-7d, +1d).
	 */
	async function dashboardWithEngagedSliceAt(baselineDayOffset: number) {
		const t = convexTest(schema, modules);
		const tomorrow = startOfDayUtc(Date.now()) + DAY;
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'transportOutcomes',
				bucket({
					periodStart: tomorrow - baselineDayOffset * DAY,
					sent: BASELINE_CALIBRATION_SENT,
					delivered: BASELINE_CALIBRATION_SENT,
					calibrationSent: BASELINE_CALIBRATION_SENT,
					calibrationOpened: BASELINE_CALIBRATION_OPENED,
				})
			);
			await ctx.db.insert(
				'transportOutcomes',
				bucket({
					periodStart: tomorrow - DAY,
					shardKey: 1,
					sent: RECENT_CALIBRATION_SENT,
					delivered: RECENT_CALIBRATION_SENT,
					calibrationSent: RECENT_CALIBRATION_SENT,
					calibrationOpened: RECENT_CALIBRATION_OPENED,
					// Fresh evidence: the recent arm is refused outright past 48h.
					lastRecordedAt: Date.now() - 60 * 60 * 1000,
				})
			);
		});
		return await t.query(api.delivery.deliverabilityDashboard.getDeliverabilityDashboard, {});
	}

	it('measures the recent window against the slice sitting in the baseline span', async () => {
		const gate = engagementGate(await dashboardWithEngagedSliceAt(20));

		// The slow-poison floor fired, which it can only do off the baseline.
		expect(gate.status).toBe('fail');
		expect(gate.reason).toBe('absolute_threshold_breached');
		// And the numbers behind it are the baseline slice's, not the window's.
		expect(gate.measurement.referenceSample).toBe(BASELINE_CALIBRATION_SENT);
		expect(gate.measurement.referenceMinSample).toBe(ENGAGEMENT_GATE_THRESHOLDS.baselineMinSample);
		expect(gate.measurement.ownSample).toBe(RECENT_CALIBRATION_SENT);
	});

	it('lets nothing inside the evaluation window act as its own baseline', async () => {
		const dashboard = await dashboardWithEngagedSliceAt(3);
		const gate = engagementGate(dashboard);

		// Same rows, moved forward: the baseline span is now empty, so the floor
		// has no denominator, holds, and the standalone ratio hold is reported.
		expect(gate.status).toBe('insufficient_data');
		expect(gate.measurement.referenceSample).toBeNull();
		// Thin evidence is never a failure (D10) — and the engaged slice being
		// inside the window cannot flatter the comparison either.
		expect(gmailCell(dashboard).verdict).not.toBe('fail');
	});
});

describe('getDeliverabilityDashboard — states are the feature', () => {
	it('renders a standalone deployment cleanly: no reference arm, no failure', async () => {
		const t = convexTest(schema, modules);
		const day = startOfDayUtc(Date.now()) - 24 * 60 * 60 * 1000;
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'transportOutcomes',
				bucket({ periodStart: day, sent: 500, delivered: 495 })
			);
		});

		const dashboard = await t.query(
			api.delivery.deliverabilityDashboard.getDeliverabilityDashboard,
			{}
		);
		expect(dashboard.referenceTransportId).toBeNull();
		expect(dashboard.cells).toHaveLength(15);
		for (const cell of dashboard.cells) {
			expect(cell.reference).toBeNull();
			expect(cell.verdict).not.toBe('fail');
			expect(cell.verdict).not.toBe('halt');
		}
		const cell = gmailCell(dashboard);
		expect(cell.confidence.level).toBe('low');
		expect(cell.confidence.improvements).toContain('connect_reference_transport');
		expect(cell.confidence.improvements).toContain('add_seed_mailboxes');
	});

	/**
	 * THE REGRESSION THIS TEST EXISTS FOR (plan D14).
	 *
	 * A standalone cell with real volume decides its DEFERRAL gate — which is
	 * genuinely high-confidence direct measurement — while the two-armed gates
	 * have nothing to compare against and hold. Folding a holding gate's grade
	 * into the cell's confidence, or running the two-armed evaluator against
	 * `reference === null`, both end at "measurement confidence: high" printed
	 * beside a column of "not enough data yet". The screen must never say that
	 * for this configuration: the plan's sentence is "low — connect a relay or
	 * add seed mailboxes to improve".
	 */
	it('never renders HIGH confidence for a cell with no reference arm', async () => {
		const t = convexTest(schema, modules);
		const day = startOfDayUtc(Date.now()) - 24 * 60 * 60 * 1000;
		await t.run(async (ctx) => {
			// Ample volume, nothing wrong with it: the deferral gate DECIDES, and it
			// decides at `high`. That is the input that used to reach the wire as a
			// high-confidence cell. The deferrals are what make it decide at all —
			// an uncounted `deferred` column holds the gate (`deferralOutcome.ts`),
			// and a holding gate contributes no confidence to fold.
			await ctx.db.insert(
				'transportOutcomes',
				bucket({ periodStart: day, sent: 50_000, delivered: 49_800, deferred: 500 })
			);
		});

		const dashboard = await t.query(
			api.delivery.deliverabilityDashboard.getDeliverabilityDashboard,
			{}
		);
		for (const cell of dashboard.cells) {
			expect(cell.confidence.level).not.toBe('high');
			expect(['none', 'low', 'medium']).toContain(cell.confidence.level);
		}

		const cell = gmailCell(dashboard);
		expect(cell.confidence.level).toBe('low');
		expect(cell.confidence.improvements).toContain('connect_reference_transport');
		// AND THE STANDALONE EVALUATOR IS THE ONE THAT RAN. Gate 3 on a deployment
		// with no complaint feedback loop is the unsubscribe PROXY, graded medium;
		// the two-armed evaluator's gate 3 is direct complaint measurement graded
		// high, so the grade on this row is the evaluator's fingerprint.
		const complaint = cell.gates.find((gate) => gate.gate === 'complaint');
		expect(complaint?.confidence).toBe('medium');
		// A gate that measured nothing contributes no grade: the deferral gate
		// decided at `high` and the cell is still not `high`.
		const deferral = cell.gates.find((gate) => gate.gate === 'deferral');
		expect(deferral?.confidence).toBe('high');
	});

	/**
	 * SEED COVERAGE IS "DOES THE ORG OWN A SEED MAILBOX", read from the ACCOUNTS.
	 *
	 * It used to be read off a whole placement roll-up whose other three fields
	 * were discarded. The boolean has to keep meaning the same thing after that
	 * shortcut: an org with a live seed account but no probes yet still HAS the
	 * instrument, so the improvement drops and the one-armed cap rises to
	 * `medium` — before a single probe has been classified. A read that needed
	 * observations to notice a mailbox would tell the operator who just connected
	 * one that nothing had changed.
	 */
	it('counts a seed MAILBOX as coverage, before any probe has been classified', async () => {
		const t = convexTest(schema, modules);
		const day = startOfDayUtc(Date.now()) - 24 * 60 * 60 * 1000;
		await t.run(async (ctx) => {
			// Deferrals counted, so gate 2 decides: this case is about SEED
			// COVERAGE, and a cell whose only decidable gate is holding would fold
			// to `low` for a reason that has nothing to do with seeds.
			await ctx.db.insert(
				'transportOutcomes',
				bucket({ periodStart: day, sent: 50_000, delivered: 49_800, deferred: 500 })
			);
			const mailboxId = await ctx.db.insert('mailboxes', {
				userId: 'user-1',
				organizationId: DASHBOARD_ORG,
				address: 'owlat.seed.0@gmail.example',
				domain: 'gmail.example',
				kind: 'external' as const,
				status: 'active' as const,
				usedBytes: 0,
				uidValidity: day,
				createdAt: day,
				updatedAt: day,
			});
			await ctx.db.insert('externalMailAccounts', {
				userId: 'user-1',
				organizationId: DASHBOARD_ORG,
				mailboxId,
				purpose: 'seed' as const,
				seedProvider: 'gmail' as const,
				imapHost: 'imap.gmail.example',
				imapPort: 993,
				isImapSecure: true,
				smtpHost: 'smtp.gmail.example',
				smtpPort: 587,
				isSmtpSecure: false,
				authMethod: 'password' as const,
				imapUsername: 'login-0',
				secretCiphertext: 'ct',
				secretIv: 'iv',
				secretAuthTag: 'tag',
				secretEnvelopeVersion: 1,
				status: 'pending' as const,
				createdAt: day,
				updatedAt: day,
			});
		});

		const cell = gmailCell(
			await t.query(api.delivery.deliverabilityDashboard.getDeliverabilityDashboard, {})
		);
		expect(cell.confidence.improvements).not.toContain('add_seed_mailboxes');
		// Still never `high`: there is no second arm, and that cap is unmoved.
		expect(cell.confidence.level).toBe('medium');
		expect(cell.confidence.improvements).toContain('connect_reference_transport');
	});

	it('holds on thin data instead of failing, and says how thin', async () => {
		const t = convexTest(schema, modules);
		const day = startOfDayUtc(Date.now()) - 24 * 60 * 60 * 1000;
		await t.run(async (ctx) => {
			await seedRelayRoute(ctx);
			await ctx.db.insert(
				'transportOutcomes',
				bucket({ periodStart: day, sent: 12, delivered: 12 })
			);
		});

		const dashboard = await t.query(
			api.delivery.deliverabilityDashboard.getDeliverabilityDashboard,
			{}
		);
		const cell = gmailCell(dashboard);
		expect(cell.verdict).toBe('insufficient_data');
		const hardBounce = cell.gates.find((gate) => gate.gate === 'hard_bounce');
		expect(hardBounce?.status).toBe('insufficient_data');
		expect(hardBounce?.measurement.ownSample).toBe(12);
		expect(hardBounce?.measurement.minSample).toBeGreaterThan(12);
	});

	/**
	 * The screen and the controller must reach gate 2 the same way, so the screen
	 * makes the same instrumentation observation the controller does — over the
	 * SAME 30-day read span, which is deliberately wider than the 7-day window the
	 * verdict is computed over. A dashboard that skipped it would render "Healthy"
	 * beside a controller verdict of "Not enough data yet".
	 */
	it('renders gate 2 as unmeasured while nothing records deferrals, and decided once something does', async () => {
		const t = convexTest(schema, modules);
		const day = startOfDayUtc(Date.now()) - 24 * 60 * 60 * 1000;
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'transportOutcomes',
				bucket({ periodStart: day, sent: 50_000, delivered: 49_800 })
			);
		});

		const quiet = gmailCell(
			await t.query(api.delivery.deliverabilityDashboard.getDeliverabilityDashboard, {})
		).gates.find((gate) => gate.gate === 'deferral');
		expect(quiet?.status).toBe('insufficient_data');
		expect(quiet?.reason).toBe('own_deferral_telemetry_absent');
		// Ample sample, rate of zero — and precisely because both are true, the
		// verdict may not be read off them.
		expect(quiet?.measurement.ownRate).toBe(0);
		expect(quiet?.measurement.ownSample).toBe(50_000);

		// One deferral three weeks ago: outside the window the verdict is computed
		// over, inside the span the instrument is observed over.
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'transportOutcomes',
				bucket({ periodStart: day - 20 * 24 * 60 * 60 * 1000, shardKey: 1, sent: 10, deferred: 1 })
			);
		});

		const instrumented = gmailCell(
			await t.query(api.delivery.deliverabilityDashboard.getDeliverabilityDashboard, {})
		).gates.find((gate) => gate.gate === 'deferral');
		expect(instrumented?.status).toBe('pass');
		expect(instrumented?.measurement.ownRate).toBe(0);
	});

	/**
	 * The hold's EXIT reaches the screen too, and over the read span rather than
	 * the window: the observation is handed the same lower bound the rows were
	 * read with, so a narrower argument here would show the operator a decided
	 * gate the controller is still holding.
	 */
	it('renders a never-deferring cell as decided once it has sent across the whole read span', async () => {
		const t = convexTest(schema, modules);
		const ONE_DAY_MS = 24 * 60 * 60 * 1000;
		const day = startOfDayUtc(Date.now());
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'transportOutcomes',
				bucket({ periodStart: day - ONE_DAY_MS, sent: 50_000, delivered: 49_800 })
			);
			// The oldest day the dashboard's 30-day read can see (its window ends at
			// tomorrow's UTC boundary), carrying traffic and still no deferral.
			await ctx.db.insert(
				'transportOutcomes',
				bucket({ periodStart: day - 29 * ONE_DAY_MS, shardKey: 1, sent: 10, delivered: 10 })
			);
		});

		const gate = gmailCell(
			await t.query(api.delivery.deliverabilityDashboard.getDeliverabilityDashboard, {})
		).gates.find((entry) => entry.gate === 'deferral');
		expect(gate?.status).toBe('pass');
	});

	it('reports a zero-volume cell as empty rather than as a problem', async () => {
		const t = convexTest(schema, modules);
		const dashboard = await t.query(
			api.delivery.deliverabilityDashboard.getDeliverabilityDashboard,
			{}
		);
		for (const cell of dashboard.cells) {
			expect(cell.own.sent).toBe(0);
			expect(cell.confidence.level).toBe('none');
			expect(cell.verdict).toBe('insufficient_data');
		}
	});

	it('resolves a LEGACY share-less route state through D1’s helper', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('deliverabilityRouteStates', {
				organizationId: DASHBOARD_ORG,
				destinationProvider: 'gmail',
				// No `stream`, no `ownShare` — exactly what the MTA snapshot writes.
				isFallbackActive: true,
				signals: [],
				snapshotGeneratedAt: 0,
				expiresAt: Date.now() + 60_000,
				updatedAt: 0,
			});
		});

		const dashboard = await t.query(
			api.delivery.deliverabilityDashboard.getDeliverabilityDashboard,
			{}
		);
		// `ownShare ?? (isFallbackActive ? 0 : 1)` — the legacy row still routes.
		expect(gmailCell(dashboard).ownShare).toBe(0);
	});
});
