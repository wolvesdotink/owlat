/**
 * One dashboard card from plain rows: the spans every number is over, which arm
 * the evaluator is given, and what the trend keeps. The query that loads the
 * rows is pinned whole by `deliverabilityDashboardGolden.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import {
	deliverabilityCellKey,
	type DeliverabilityCell,
} from '@owlat/shared/deliverabilityRouting';
import type { Doc } from '../../_generated/dataModel';
import { utcDayStart } from '../../lib/clock';
import { ZERO_TRANSPORT_OUTCOME_TOTALS } from '../../analytics/transportOutcomeSummary';
import type { TransportOutcomeBucket } from '../../analytics/transportOutcomeSummary';
import { RAMP_AIMD } from '../ramp/controllerConfig';
import {
	assembleDashboardCell,
	dashboardSpans,
	type DashboardCellRows,
	type DashboardGridFacts,
} from '../deliverabilityDashboardCell';

const NOW = Date.parse('2026-07-15T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const TODAY = utcDayStart(NOW);
const CELL: DeliverabilityCell = { stream: 'campaign', destinationProvider: 'gmail' };
const CELL_KEY = deliverabilityCellKey(CELL);

function bucket(
	arm: 'own' | 'reference',
	dayOffset: number,
	sent: number,
	shardKey = 0
): TransportOutcomeBucket {
	const periodStart = TODAY - dayOffset * DAY;
	return {
		_id: `bucket_${arm}_${dayOffset}_${shardKey}` as TransportOutcomeBucket['_id'],
		_creationTime: periodStart,
		...ZERO_TRANSPORT_OUTCOME_TOTALS,
		organizationId: 'org_cell',
		cell: CELL_KEY,
		arm,
		periodStart,
		shardKey,
		sent,
		delivered: sent,
		lastRecordedAt: Math.min(NOW, periodStart + DAY - 1),
	};
}

function grid(overrides: Partial<DashboardGridFacts> = {}): DashboardGridFacts {
	return {
		now: NOW,
		spans: dashboardSpans(NOW),
		isRelayConfigured: true,
		routeStates: new Map(),
		deploymentPresence: {
			google_postmaster: false,
			microsoft_snds: false,
			complaint_feedback_loop: false,
			seed_mailboxes: false,
			commercial_placement_api: false,
		},
		hasSeedCoverage: false,
		seedSweeps: new Map(),
		...overrides,
	};
}

function rows(
	own: TransportOutcomeBucket[],
	reference: TransportOutcomeBucket[]
): DashboardCellRows {
	return {
		cell: CELL,
		cellKey: CELL_KEY,
		ownBuckets: own,
		referenceBuckets: reference,
		ownCategoryBuckets: [],
	};
}

describe('dashboardSpans', () => {
	it('reports seven UTC days and decides over the controller window', () => {
		const spans = dashboardSpans(NOW);
		expect(spans.reportedWindow).toEqual({ since: TODAY + DAY - 7 * DAY, until: TODAY + DAY });
		expect(spans.decisionWindow).toEqual({ since: NOW - RAMP_AIMD.evaluationWindowMs });
		expect(spans.readWindow.until).toBe(TODAY + DAY);
		expect(spans.readWindow.since).toBeLessThanOrEqual(spans.window.readSinceDay);
	});
});

describe('assembleDashboardCell', () => {
	it('reports the week on the card and grades only the deciding span', () => {
		const view = assembleDashboardCell(
			grid(),
			rows([bucket('own', 0, 500), bucket('own', 4, 700, 1)], [bucket('reference', 0, 400)])
		);
		expect(view.own.sent).toBe(1200);
		expect(view.reference?.sent).toBe(400);
		const hardBounce = view.gates.find((gate) => gate.gate === 'hard_bounce');
		expect(hardBounce?.measurement.ownSample).toBe(500);
	});

	it('drops the reference column once the relay went quiet, but keeps its trend', () => {
		const view = assembleDashboardCell(
			grid(),
			rows([bucket('own', 0, 500)], [bucket('reference', 4, 400)])
		);
		expect(view.reference).toBeNull();
		expect(view.trend.some((point) => point.reference !== null)).toBe(true);
	});

	it('draws no reference series for a relay that never carried the cell', () => {
		const view = assembleDashboardCell(grid(), rows([bucket('own', 0, 500)], []));
		expect(view.reference).toBeNull();
		expect(view.trend.every((point) => point.reference === null)).toBe(true);
	});

	it('takes the share and the streak from the cell’s own route state', () => {
		const routeState = {
			organizationId: 'org_cell',
			destinationProvider: 'gmail',
			stream: 'campaign',
			isFallbackActive: false,
			ownShare: 0.25,
			phaseCeiling: 0.5,
			cleanStreak: 2,
			signals: [],
			snapshotGeneratedAt: NOW,
			expiresAt: NOW + DAY,
			updatedAt: NOW,
		} as unknown as Doc<'deliverabilityRouteStates'>;
		const view = assembleDashboardCell(
			grid({ routeStates: new Map([['gmail', [routeState]]]) }),
			rows([bucket('own', 0, 500)], [])
		);
		expect(view.ownShare).toBe(0.25);
		expect(view.phaseCeiling).toBe(0.5);
	});

	it('gives the same card for the same rows and leaves them alone', () => {
		const facts = grid();
		const input = rows([bucket('own', 0, 500)], [bucket('reference', 0, 400)]);
		const snapshot = structuredClone(input);
		expect(assembleDashboardCell(facts, input)).toEqual(assembleDashboardCell(facts, input));
		expect(input).toEqual(snapshot);
	});
});
