/**
 * The whole deliverability dashboard, byte for byte.
 *
 * The web screen reads every field of `getDeliverabilityDashboard`'s answer, so
 * the answer for a fixed deployment is pinned in a golden file recorded from
 * the query before its per-cell assembly moved into
 * `../deliverabilityDashboardCell.ts`. The deployment is chosen to reach every
 * branch the assembly takes: a relayed cell mid-ramp with seed probes and
 * classified SMTP blocks, a cell whose relay went quiet days ago (so the trend
 * keeps a reference series the verdict has none of), a standalone cell with
 * only its own arm, and every other cell empty.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SessionOrganization from '../../lib/sessionOrganization';
import schema from '../../schema';
import { api } from '../../_generated/api';
import { deliverabilityCellKey } from '@owlat/shared/deliverabilityRouting';
import { recordSmtpResponseForCell } from '../../analytics/smtpResponseCategories';
import { insertSeedProbes } from '../../analytics/__tests__/seedProbeFixtures';
import { connectRelay, seedArmOutcomes, seedGreenWindows, seedRampCell } from './rampCronFixtures';
import { modules } from '../../__tests__/testModules';

const ORG = 'org_dashboard_golden';

vi.mock('../../lib/sessionOrganization', async (importOriginal) => {
	const actual = await importOriginal<typeof SessionOrganization>();
	return {
		...actual,
		requireOrgMember: vi.fn(async () => ({
			userId: 'user-1',
			role: 'owner' as const,
			activeOrganizationId: 'org_dashboard_golden',
		})),
		getUserIdFromSession: vi.fn().mockResolvedValue('user-1'),
		getSingletonOrganizationId: vi.fn().mockResolvedValue('org_dashboard_golden'),
	};
});

// Mid-day, so no fixture row straddles a UTC boundary the query derives.
const FIXED_NOW = new Date('2026-07-15T12:00:00.000Z');

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(FIXED_NOW);
	vi.stubEnv('EMAIL_PROVIDER', 'mta');
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

describe('getDeliverabilityDashboard — the answer the screen reads', () => {
	it('is unchanged for a relayed, a relay-gone-quiet and a standalone cell', async () => {
		const t = convexTest(schema, modules);
		// gmail/campaign: mid-ramp, both arms healthy over a month.
		await seedRampCell(t, { organizationId: ORG, ownShare: 0.5, cleanStreak: 3 });
		await connectRelay(t, 'adaptive_mix', 'ses');
		await seedGreenWindows(t, { organizationId: ORG });
		await insertSeedProbes(t, { organizationId: ORG, count: 12, placement: 'inbox' });
		await insertSeedProbes(t, { organizationId: ORG, count: 3, placement: 'spam' });
		await t.run(async (ctx) => {
			const cell = deliverabilityCellKey({ stream: 'campaign', destinationProvider: 'gmail' });
			for (const category of ['gmail_ip_identity', 'policy_rejected', 'greylisted'] as const) {
				await recordSmtpResponseForCell(ctx, { organizationId: ORG, cell, arm: 'own', category });
			}
		});
		// microsoft/campaign: the relay carried traffic four days ago and nothing since.
		for (const [arm, dayOffset, sent] of [
			['own', 0, 900],
			['own', 4, 700],
			['reference', 4, 600],
		] as const) {
			await seedArmOutcomes(t, {
				organizationId: ORG,
				arm,
				sent,
				dayOffset,
				destinationProvider: 'microsoft',
				counters: { hardBounced: 4, opened: 120, clicked: 9, deferred: 6 },
			});
		}
		// yahoo/transactional: only the own arm ever sent.
		await seedArmOutcomes(t, {
			organizationId: ORG,
			arm: 'own',
			sent: 300,
			stream: 'transactional',
			destinationProvider: 'yahoo',
			counters: { softBounced: 2, complained: 1 },
		});

		const dashboard = await t.query(
			api.delivery.deliverabilityDashboard.getDeliverabilityDashboard,
			{}
		);
		await expect(JSON.stringify(dashboard, null, 2)).toMatchFileSnapshot(
			'./__golden__/deliverabilityDashboard.golden'
		);
	});
});
