/**
 * `by_org_provider_stream` is a PURE INDEX WIDENING: a per-stream row wins for
 * its own stream, and a legacy stream-less row keeps serving every stream.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import {
	loadRouteStateForCell,
	loadStreamlessRouteState,
} from '../../lib/deliverabilityRouteState';
import {
	DELIVERABILITY_STREAM_KEYS,
	resolveOwnShare,
	type DeliverabilityStream,
} from '@owlat/shared/deliverabilityRouting';

const rootGlob = import.meta.glob('../../**/*.*s');
const deliveryGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, module]) => [
		path.replace(/^\.\.\//, '../../delivery/'),
		module,
	])
);
const modules = { ...rootGlob, ...deliveryGlob };

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return { ...actual, getSingletonOrganizationId: vi.fn().mockResolvedValue('org-a') };
});

const NOW = 10_000_000;

async function insertRow(
	t: TestConvex<typeof schema>,
	row: {
		organizationId?: string;
		destinationProvider: 'all' | 'gmail';
		stream?: DeliverabilityStream;
		isFallbackActive?: boolean;
		ownShare?: number;
	}
) {
	await t.run(async (ctx) => {
		await ctx.db.insert('deliverabilityRouteStates', {
			organizationId: row.organizationId ?? 'org-a',
			destinationProvider: row.destinationProvider,
			stream: row.stream,
			isFallbackActive: row.isFallbackActive ?? false,
			ownShare: row.ownShare,
			signals: [],
			snapshotGeneratedAt: NOW,
			expiresAt: NOW + 86_400_000,
			updatedAt: NOW,
		});
	});
}

describe('per-stream route-state lookup', () => {
	it('prefers the per-stream row and falls back to the stream-less row', async () => {
		const t = convexTest(schema, modules);
		await insertRow(t, { destinationProvider: 'gmail', isFallbackActive: false });
		await insertRow(t, { destinationProvider: 'gmail', stream: 'campaign', ownShare: 0.25 });

		const campaign = await t.run((ctx) => loadRouteStateForCell(ctx, 'org-a', 'gmail', 'campaign'));
		expect(campaign?.stream).toBe('campaign');
		expect(resolveOwnShare(campaign)).toBe(0.25);

		for (const stream of ['automation', 'transactional'] as const) {
			const row = await t.run((ctx) => loadRouteStateForCell(ctx, 'org-a', 'gmail', stream));
			expect(row?.stream).toBeUndefined();
			expect(resolveOwnShare(row)).toBe(1);
		}
	});

	it('serves every stream from the legacy row when no per-stream row exists', async () => {
		const t = convexTest(schema, modules);
		await insertRow(t, { destinationProvider: 'gmail', isFallbackActive: true });
		for (const stream of DELIVERABILITY_STREAM_KEYS) {
			const row = await t.run((ctx) => loadRouteStateForCell(ctx, 'org-a', 'gmail', stream));
			expect(row?.stream).toBeUndefined();
			expect(resolveOwnShare(row)).toBe(0);
		}
	});

	it('never returns a per-stream row to the stream-less lookup', async () => {
		const t = convexTest(schema, modules);
		await insertRow(t, { destinationProvider: 'all', stream: 'transactional', ownShare: 0.5 });
		expect(await t.run((ctx) => loadStreamlessRouteState(ctx, 'org-a', 'all'))).toBeNull();
		const perStream = await t.run((ctx) =>
			loadRouteStateForCell(ctx, 'org-a', 'all', 'transactional')
		);
		expect(resolveOwnShare(perStream)).toBe(0.5);
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
		expect(
			await t.run((ctx) => loadRouteStateForCell(ctx, 'org-a', 'gmail', 'campaign'))
		).toBeNull();
		expect(await t.run((ctx) => loadStreamlessRouteState(ctx, 'org-a', 'gmail'))).toBeNull();
	});
});
