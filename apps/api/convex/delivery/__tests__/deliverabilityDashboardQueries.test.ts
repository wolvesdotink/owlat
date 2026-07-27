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
import { afterEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { api } from '../../_generated/api';
import type { Doc } from '../../_generated/dataModel';
import type { DatabaseWriter } from '../../_generated/server';
import { deliverabilityCellKey } from '@owlat/shared/deliverabilityRouting';
import { summarizeTransportOutcomeBuckets } from '../../analytics/transportOutcomeSummary';
import { startOfDayUtc } from '../../lib/clock';
import type { DeliverabilityDashboard } from '../deliverabilityDashboard';
import { modules } from './testModules';

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

afterEach(() => {
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

	it('holds on thin data instead of failing, and says how thin', async () => {
		const t = convexTest(schema, modules);
		const day = startOfDayUtc(Date.now()) - 24 * 60 * 60 * 1000;
		await t.run(async (ctx) => {
			await seedRelayRoute(ctx);
			await ctx.db.insert('transportOutcomes', bucket({ periodStart: day, sent: 12, delivered: 12 }));
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
