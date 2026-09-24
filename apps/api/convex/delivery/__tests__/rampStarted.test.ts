/**
 * `hasRampStarted` is the bit the Settings rail reads to decide whether Email
 * delivery lists "Advanced". It must stay false on a deployment that has never
 * put a cell on the ramp (every deployment, out of the box), turn true the
 * moment a cell is enrolled, stay true once the ramp has run, and never answer
 * for another organization's ramp.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { api } from '../../_generated/api';
import { modules } from '../../__tests__/testModules';
import { seedRampCell, type Harness } from './rampCronFixtures';

const ORG = 'org_ramp_started';
const OTHER_ORG = 'org_ramp_started_other';

const session = vi.hoisted(() => ({ organizationId: 'org_ramp_started' }));

vi.mock('../../lib/sessionOrganization', async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return {
		...actual,
		getSingletonOrganizationId: vi.fn(async () => session.organizationId),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'user_admin', role: 'owner' }),
		requireAdminContext: vi.fn().mockResolvedValue({ userId: 'user_admin', role: 'owner' }),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'user_admin', role: 'owner' }),
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'user_admin', role: 'owner' }),
	};
});

function harness(): Harness {
	session.organizationId = ORG;
	return convexTest(schema, modules);
}

async function hasRampStarted(t: Harness): Promise<boolean> {
	return await t.query(api.delivery.rampControlQueries.hasRampStarted, {});
}

async function seedDecision(t: Harness, organizationId: string): Promise<void> {
	const now = Date.now();
	await t.run(async (ctx) => {
		await ctx.db.insert('mixDecisions', {
			organizationId,
			cell: 'campaign:gmail',
			stream: 'campaign',
			destinationProvider: 'gmail',
			at: now,
			fromShare: 0.02,
			toShare: 0.02,
			direction: 'hold',
			verdict: 'insufficient_data',
			reason: 'window_open',
			message: 'The evaluation window is still open.',
			snapshot: '{}',
			expiresAt: now + 90 * 24 * 60 * 60 * 1000,
		});
	});
}

describe('hasRampStarted', () => {
	it('is false on a deployment with no ramp state at all', async () => {
		const t = harness();
		expect(await hasRampStarted(t)).toBe(false);
	});

	it('is false while only the MTA snapshot rows exist', async () => {
		const t = harness();
		// The stream-less provider slice and the pool row, with no controller row:
		// every cell before enrolment.
		await seedRampCell(t, { organizationId: ORG, omitManagedCell: true });
		expect(await hasRampStarted(t)).toBe(false);
	});

	it('is false for a per-stream row the controller has not given a share', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG, omitManagedCell: true });
		const now = Date.now();
		await t.run(async (ctx) => {
			await ctx.db.insert('deliverabilityRouteStates', {
				organizationId: ORG,
				destinationProvider: 'gmail',
				stream: 'campaign',
				isFallbackActive: false,
				signals: [],
				snapshotGeneratedAt: now,
				expiresAt: now + 24 * 60 * 60 * 1000,
				updatedAt: now,
			});
		});
		expect(await hasRampStarted(t)).toBe(false);
	});

	it('is true once a cell is enrolled', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG, omitManagedCell: true });
		const enrolled = await t.mutation(api.delivery.rampEnrollment.enrollCell, {
			stream: 'campaign',
			destinationProvider: 'gmail',
		});
		expect(enrolled.enrolled).toBe(true);
		expect(await hasRampStarted(t)).toBe(true);
	});

	it('is true for a managed cell with no decision recorded yet', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG, ownShare: 0.25 });
		expect(await hasRampStarted(t)).toBe(true);
	});

	it('stays true on the decision trail after the route-state lease lapsed', async () => {
		const t = harness();
		await seedDecision(t, ORG);
		expect(await hasRampStarted(t)).toBe(true);
	});

	it("does not answer for another organization's ramp", async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: OTHER_ORG, ownShare: 0.5 });
		await seedDecision(t, OTHER_ORG);
		expect(await hasRampStarted(t)).toBe(false);
	});
});
