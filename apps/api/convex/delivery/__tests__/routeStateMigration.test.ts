/**
 * Migration guard for the boolean -> share widening (D1).
 *
 * Rows written in the OLD shape (no `stream`, no `ownShare`) must read
 * correctly through every shipped consumer, and the shipped hysteresis must be
 * unchanged. Nothing in this piece writes `ownShare`, so "unchanged" is the
 * whole acceptance criterion.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import {
	loadRouteStateForCell,
	loadStreamlessRouteState,
} from '../../lib/deliverabilityRouteState';
import {
	DELIVERABILITY_SIGNAL_SOURCES,
	DELIVERABILITY_STREAM_KEYS,
	isRouteStateFallbackActive,
	resolveOwnShare,
} from '@owlat/shared/deliverabilityRouting';
import {
	deliverabilitySignalSourceValidator,
	deliverabilityStreamValidator,
} from '../deliverabilityValidators';

import { modules } from './testModules';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return { ...actual, getSingletonOrganizationId: vi.fn().mockResolvedValue('org-a') };
});

const NOW = 10_000_000;

async function legacyRow(
	t: TestConvex<typeof schema>,
	options: { destinationProvider: 'all' | 'gmail'; isFallbackActive: boolean }
) {
	await t.run(async (ctx) => {
		await ctx.db.insert('deliverabilityRouteStates', {
			organizationId: 'org-a',
			destinationProvider: options.destinationProvider,
			isFallbackActive: options.isFallbackActive,
			signals: options.isFallbackActive
				? [{ source: 'dnsbl_listed' as const, severity: 'critical' as const, observedAt: NOW }]
				: [],
			fallbackActiveSince: options.isFallbackActive ? NOW : undefined,
			snapshotGeneratedAt: NOW,
			expiresAt: NOW + 86_400_000,
			updatedAt: NOW,
		});
	});
}

describe('legacy route-state rows', () => {
	it('reads a stream-less row through the cell lookup for every stream', async () => {
		const t = convexTest(schema, modules);
		await legacyRow(t, { destinationProvider: 'gmail', isFallbackActive: true });
		for (const stream of DELIVERABILITY_STREAM_KEYS) {
			const row = await t.run((ctx) => loadRouteStateForCell(ctx, 'org-a', 'gmail', stream));
			expect(row).not.toBeNull();
			expect(row?.stream).toBeUndefined();
			expect(row?.ownShare).toBeUndefined();
			expect(resolveOwnShare(row)).toBe(0);
			expect(isRouteStateFallbackActive(row)).toBe(true);
		}
	});

	it('resolves a healthy legacy row to a fully own-MTA share', async () => {
		const t = convexTest(schema, modules);
		await legacyRow(t, { destinationProvider: 'all', isFallbackActive: false });
		const row = await t.run((ctx) => loadStreamlessRouteState(ctx, 'org-a', 'all'));
		expect(resolveOwnShare(row)).toBe(1);
		expect(isRouteStateFallbackActive(row)).toBe(false);
	});

	it('returns null — a fully own-MTA cell — when no row exists at all', async () => {
		const t = convexTest(schema, modules);
		const row = await t.run((ctx) => loadRouteStateForCell(ctx, 'org-a', 'yahoo', 'campaign'));
		expect(row).toBeNull();
		expect(resolveOwnShare(row)).toBe(1);
		expect(isRouteStateFallbackActive(row)).toBe(false);
	});
});

describe('shipped hysteresis after the widening', () => {
	it('activates immediately and fails back only after healthy period plus cooldown', async () => {
		const t = convexTest(schema, modules);
		const apply = (generatedAt: number, appliedAt: number, degraded: boolean) =>
			t.mutation(internal.delivery.deliverabilityRouting.applySnapshot, {
				organizationId: 'org-a',
				generatedAt,
				appliedAt,
				signals: degraded
					? [
							{
								provider: 'gmail' as const,
								source: 'breaker_open' as const,
								severity: 'critical' as const,
								observedAt: appliedAt,
							},
						]
					: [],
			});
		const gmail = () => t.run((ctx) => loadStreamlessRouteState(ctx, 'org-a', 'gmail'));

		await apply(1, 1, true);
		expect(await gmail()).toMatchObject({
			isFallbackActive: true,
			signals: [{ source: 'breaker_open' }],
		});
		// The migration adds no fields to a row the snapshot writes.
		expect((await gmail())?.ownShare).toBeUndefined();
		expect((await gmail())?.stream).toBeUndefined();

		await apply(2, 16 * 60 * 1000, false);
		expect(await gmail()).toMatchObject({ isFallbackActive: true });

		await apply(3, 32 * 60 * 1000, false);
		expect(await gmail()).toMatchObject({ isFallbackActive: false, signals: [] });
	});

	it('never flips the shipped boolean for an outcome-derived signal', async () => {
		const t = convexTest(schema, modules);
		await t.mutation(internal.delivery.deliverabilityRouting.applySnapshot, {
			organizationId: 'org-a',
			generatedAt: 1,
			appliedAt: 1,
			signals: [
				{ provider: 'gmail', source: 'bounce_rate', severity: 'critical', observedAt: 1 },
				{ provider: 'gmail', source: 'complaint_rate', severity: 'critical', observedAt: 1 },
				{ provider: 'gmail', source: 'engagement_ratio', severity: 'warning', observedAt: 1 },
				{ provider: 'gmail', source: 'seed_placement', severity: 'critical', observedAt: 1 },
			],
		});
		const row = await t.run((ctx) => loadStreamlessRouteState(ctx, 'org-a', 'gmail'));
		// Persisted for measurement, never a routing verdict on its own.
		expect(row?.isFallbackActive).toBe(false);
		expect(row?.signals.map((signal) => signal.source)).toEqual([
			'bounce_rate',
			'complaint_rate',
			'engagement_ratio',
			'seed_placement',
		]);
		expect(resolveOwnShare(row)).toBe(1);
	});
});

describe('validator / shared-union parity', () => {
	it('mirrors the shared signal-source union into the Convex validator', () => {
		const validatorSources = deliverabilitySignalSourceValidator.members.map((member) =>
			String(member.value)
		);
		expect(validatorSources.sort()).toEqual([...DELIVERABILITY_SIGNAL_SOURCES].sort());
	});

	it('mirrors the shared stream keys into the Convex validator', () => {
		const validatorStreams = deliverabilityStreamValidator.members.map((member) =>
			String(member.value)
		);
		expect(validatorStreams.sort()).toEqual([...DELIVERABILITY_STREAM_KEYS].sort());
	});
});
