/**
 * `by_org_provider_stream` is a PURE INDEX WIDENING: a per-stream row wins for
 * its own stream's SHARE, and a legacy stream-less row keeps serving every
 * stream. The cell lookup returns BOTH rows so a per-stream row can never
 * shadow the infrastructure verdict the MTA snapshot writes stream-lessly.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import {
	loadRouteStateCell,
	loadStreamlessRouteState,
	type RouteStateCellRows,
} from '../../lib/deliverabilityRouteState';
import {
	DELIVERABILITY_STREAM_KEYS,
	isRouteStateFallbackActive,
	resolveOwnShare,
	type DeliverabilitySignalSeverity,
	type DeliverabilitySignalSource,
	type DeliverabilityStream,
} from '@owlat/shared/deliverabilityRouting';

import { modules } from './testModules';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return { ...actual, getSingletonOrganizationId: vi.fn().mockResolvedValue('org-a') };
});

const NOW = 10_000_000;

/** The share resolution on top of the seam: most specific row wins. */
function cellShare(rows: RouteStateCellRows): number {
	return resolveOwnShare(rows.perStream ?? rows.streamless);
}

async function insertRow(
	t: TestConvex<typeof schema>,
	row: {
		organizationId?: string;
		destinationProvider: 'all' | 'gmail';
		stream?: DeliverabilityStream;
		isFallbackActive?: boolean;
		ownShare?: number;
		signals?: Array<{
			source: DeliverabilitySignalSource;
			severity: DeliverabilitySignalSeverity;
			observedAt: number;
		}>;
	}
) {
	await t.run(async (ctx) => {
		await ctx.db.insert('deliverabilityRouteStates', {
			organizationId: row.organizationId ?? 'org-a',
			destinationProvider: row.destinationProvider,
			stream: row.stream,
			isFallbackActive: row.isFallbackActive ?? false,
			ownShare: row.ownShare,
			signals: row.signals ?? [],
			snapshotGeneratedAt: NOW,
			expiresAt: NOW + 86_400_000,
			updatedAt: NOW,
		});
	});
}

describe('per-stream route-state lookup', () => {
	it('prefers the per-stream row for the share and falls back to the stream-less row', async () => {
		const t = convexTest(schema, modules);
		await insertRow(t, { destinationProvider: 'gmail', isFallbackActive: false });
		await insertRow(t, { destinationProvider: 'gmail', stream: 'campaign', ownShare: 0.25 });

		const campaign = await t.run((ctx) =>
			loadRouteStateCell(ctx, 'org-a', { stream: 'campaign', destinationProvider: 'gmail' })
		);
		expect(campaign.perStream?.stream).toBe('campaign');
		expect(campaign.streamless?.stream).toBeUndefined();
		expect(cellShare(campaign)).toBe(0.25);

		for (const stream of ['automation', 'transactional'] as const) {
			const rows = await t.run((ctx) =>
				loadRouteStateCell(ctx, 'org-a', { stream, destinationProvider: 'gmail' })
			);
			expect(rows.perStream).toBeNull();
			expect(rows.streamless?.stream).toBeUndefined();
			expect(cellShare(rows)).toBe(1);
		}
	});

	it('serves every stream from the legacy row when no per-stream row exists', async () => {
		const t = convexTest(schema, modules);
		await insertRow(t, { destinationProvider: 'gmail', isFallbackActive: true });
		for (const stream of DELIVERABILITY_STREAM_KEYS) {
			const rows = await t.run((ctx) =>
				loadRouteStateCell(ctx, 'org-a', { stream, destinationProvider: 'gmail' })
			);
			expect(rows.perStream).toBeNull();
			expect(rows.streamless?.stream).toBeUndefined();
			expect(cellShare(rows)).toBe(0);
		}
	});

	it('surfaces the infrastructure verdict even when a per-stream share row exists', async () => {
		// The shadowing regression: the MTA snapshot writes the DNSBL listing onto
		// the stream-less gmail row, the controller writes a share onto the
		// per-stream campaign row. Reading only the most specific row would drop
		// the hard stop for campaign traffic until the controller's next tick.
		const t = convexTest(schema, modules);
		await insertRow(t, {
			destinationProvider: 'gmail',
			isFallbackActive: true,
			signals: [{ source: 'dnsbl_listed', severity: 'critical', observedAt: NOW }],
		});
		await insertRow(t, { destinationProvider: 'gmail', stream: 'campaign', ownShare: 0.25 });

		const rows = await t.run((ctx) =>
			loadRouteStateCell(ctx, 'org-a', { stream: 'campaign', destinationProvider: 'gmail' })
		);
		expect(cellShare(rows)).toBe(0.25);
		expect(rows.streamless?.signals.map((signal) => signal.source)).toEqual(['dnsbl_listed']);
		expect(isRouteStateFallbackActive(rows.streamless)).toBe(true);
	});

	it('never returns a per-stream row to the stream-less lookup', async () => {
		const t = convexTest(schema, modules);
		await insertRow(t, { destinationProvider: 'all', stream: 'transactional', ownShare: 0.5 });
		// The global slice is read stream-lessly, so a per-stream `all` row is
		// invisible to it — it can never hide the breaker signal.
		expect(await t.run((ctx) => loadStreamlessRouteState(ctx, 'org-a', 'all'))).toBeNull();

		await insertRow(t, { destinationProvider: 'gmail', stream: 'transactional', ownShare: 0.5 });
		const rows = await t.run((ctx) =>
			loadRouteStateCell(ctx, 'org-a', { stream: 'transactional', destinationProvider: 'gmail' })
		);
		expect(rows.streamless).toBeNull();
		expect(cellShare(rows)).toBe(0.5);
	});

	it('scopes every lookup to the organization', async () => {
		const t = convexTest(schema, modules);
		await insertRow(t, {
			organizationId: 'org-b',
			destinationProvider: 'gmail',
			stream: 'campaign',
			ownShare: 0,
		});
		await insertRow(t, { organizationId: 'org-b', destinationProvider: 'gmail' });
		const rows = await t.run((ctx) =>
			loadRouteStateCell(ctx, 'org-a', { stream: 'campaign', destinationProvider: 'gmail' })
		);
		expect(rows.perStream).toBeNull();
		expect(rows.streamless).toBeNull();
		expect(await t.run((ctx) => loadStreamlessRouteState(ctx, 'org-a', 'gmail'))).toBeNull();
	});
});
