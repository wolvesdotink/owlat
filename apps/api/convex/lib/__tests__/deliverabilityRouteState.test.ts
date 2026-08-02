/**
 * THE SCANNING LOADERS' TIE-BREAK.
 *
 * `loadRouteStateCell` point-reads a cell and takes `.first()`; the two
 * whole-organization scans see every row of a provider slice at once and so have
 * to break a tie the point read never sees. Nothing writes a duplicate
 * `(destinationProvider, stream)` row today — every writer patches the row it
 * looked up — but "unreachable" is not "harmless": while the scan kept the LAST
 * row it saw, a duplicate would have made the warming-cap gate and the dispatch
 * path resolve the SAME cell to different shares, and the two would have blamed
 * each other. The rule is one rule, and it is the point read's.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../../schema';
import {
	loadRouteStateCell,
	loadRouteStatesByCell,
	loadStreamRouteStateCells,
} from '../deliverabilityRouteState';
import { deliverabilityCellKey } from '@owlat/shared/deliverabilityRouting';

const modules = import.meta.glob('../../**/*.*s');

const ORG = 'org_route_state';
const NOW = Date.UTC(2026, 6, 27, 12, 0, 0);

type Harness = ReturnType<typeof convexTest>;

/** One route-state row. `stream` absent writes the MTA snapshot's row. */
async function seedRow(
	t: Harness,
	row: { stream?: 'campaign'; ownShare: number }
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('deliverabilityRouteStates', {
			organizationId: ORG,
			destinationProvider: 'gmail',
			...(row.stream === undefined ? {} : { stream: row.stream }),
			ownShare: row.ownShare,
			isFallbackActive: row.ownShare < 1,
			signals: [],
			snapshotGeneratedAt: NOW,
			expiresAt: NOW + 86_400_000,
			updatedAt: NOW,
		});
	});
}

describe('loadStreamRouteStateCells — duplicate rows resolve as the point read does', () => {
	it('keeps the FIRST per-stream row, the one loadRouteStateCell returns', async () => {
		const t = convexTest(schema, modules);
		await seedRow(t, { stream: 'campaign', ownShare: 0.25 });
		await seedRow(t, { stream: 'campaign', ownShare: 0.9 });

		const [scanned, pointRead] = await t.run(async (ctx) => {
			const cells = await loadStreamRouteStateCells(ctx, ORG, 'campaign');
			const cell = await loadRouteStateCell(ctx, ORG, {
				stream: 'campaign',
				destinationProvider: 'gmail',
			});
			return [cells.get('gmail')?.perStream?.ownShare, cell.perStream?.ownShare];
		});

		expect(scanned).toBe(0.25);
		expect(scanned).toBe(pointRead);
	});

	it('keeps the FIRST stream-less row too', async () => {
		const t = convexTest(schema, modules);
		await seedRow(t, { ownShare: 0.25 });
		await seedRow(t, { ownShare: 0.9 });

		const [scanned, pointRead] = await t.run(async (ctx) => {
			const cells = await loadStreamRouteStateCells(ctx, ORG, 'campaign');
			const cell = await loadRouteStateCell(ctx, ORG, {
				stream: 'campaign',
				destinationProvider: 'gmail',
			});
			return [cells.get('gmail')?.streamless?.ownShare, cell.streamless?.ownShare];
		});

		expect(scanned).toBe(0.25);
		expect(scanned).toBe(pointRead);
	});
});

describe('loadRouteStatesByCell — the same tie-break, so the grid agrees with the gate', () => {
	it('keeps the FIRST row for a cell key', async () => {
		const t = convexTest(schema, modules);
		await seedRow(t, { stream: 'campaign', ownShare: 0.25 });
		await seedRow(t, { stream: 'campaign', ownShare: 0.9 });

		const share = await t.run(async (ctx) => {
			const byCell = await loadRouteStatesByCell(ctx, ORG);
			return byCell.get(
				deliverabilityCellKey({ stream: 'campaign', destinationProvider: 'gmail' })
			)?.ownShare;
		});

		expect(share).toBe(0.25);
	});
});
