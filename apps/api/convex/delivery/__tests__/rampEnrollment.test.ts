/**
 * ENROLMENT — the one door onto the ramp (plan D1, D3, D14).
 *
 * Before this mutation exists nothing in production ever writes an `ownShare`:
 * the MTA snapshot writes stream-less rows, the controller skips a cell without
 * a stored share, and every control refuses an unmanaged cell rather than
 * creating one. So the properties worth pinning here are the ones that decide
 * whether the ramp can be USED at all, and whether using it is safe:
 *
 *   - the opening share is the SETUP FORK's answer, not a constant: the stream's
 *     `initialShareFraction` with a relay to ramp against, and full share with
 *     none (there is no second sender to hold traffic back for);
 *   - the rung and its DWELL ANCHOR are stamped together, because dwell is one of
 *     the four conditions on the only promotion route a yahoo/apple/other cell
 *     has;
 *   - it writes the D12 audit pair, so the first entry in a cell's timeline says
 *     who put it on the ramp and at what share;
 *   - an already-managed cell is refused rather than reset, and an enrolment that
 *     would RAISE today's effective share meets the same hard stops a
 *     force-advance does. A cut toward the relay never does.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { api } from '../../_generated/api';
import { modules } from '../../__tests__/testModules';
import { RAMP_STREAM_CONFIGS } from '../ramp/gateConfig';
import { RAMP_INITIAL_PHASE_CEILING, RAMP_TOP_PHASE_CEILING } from '../ramp/controllerConfig';
import { readManagedCell, seedRampCell, type Harness } from './rampCronFixtures';

const ORG = 'org_ramp_enrollment';
const OTHER_ORG = 'org_ramp_enrollment_other';

const session = vi.hoisted(() => ({ organizationId: 'org_ramp_enrollment', isAdmin: true }));

// Same shape the sibling controls suite uses: the mutation resolves its tenant
// through the shared singleton-org helper (which talks to the auth component the
// harness does not have), and the ADMIN FLOOR is real rather than stubbed away —
// flipping `session.isAdmin` exercises the gate the card's claim rests on.
vi.mock('../../lib/sessionOrganization', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../lib/sessionOrganization')>();
	return {
		...actual,
		getSingletonOrganizationId: vi.fn(async () => session.organizationId),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'user_admin', role: 'owner' }),
		requireAdminContext: vi.fn(async () => {
			if (!session.isAdmin) throw new Error('Admin access required');
			return { userId: 'user_admin', role: 'owner' };
		}),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'user_admin', role: 'owner' }),
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'user_admin', role: 'owner' }),
	};
});

const CELL = { stream: 'campaign', destinationProvider: 'gmail' } as const;

function harness(): Harness {
	session.organizationId = ORG;
	session.isAdmin = true;
	return convexTest(schema, modules);
}

/** A configured relay: the ESP path's precondition, read from `providerRoutes`. */
async function connectRelay(t: Harness): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('providerRoutes', {
			messageType: 'campaign' as const,
			strategy: 'priority_failover' as const,
			providers: [
				{ providerType: 'mta', isEnabled: true },
				{ providerType: 'ses', isEnabled: true },
			],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
	});
}

/**
 * Put the PROVIDER SLICE in relay fallback. Today's effective share for an
 * unmanaged cell is `resolveOwnShare` over that row, so this is what makes an
 * enrolment an INCREASE (0 -> the opening share) rather than a cut.
 */
async function holdProviderSliceInFallback(t: Harness): Promise<void> {
	await t.run(async (ctx) => {
		const rows = await ctx.db.query('deliverabilityRouteStates').collect();
		const streamless = rows.find(
			(row) => row.stream === undefined && row.destinationProvider === 'gmail'
		);
		if (streamless !== undefined) await ctx.db.patch(streamless._id, { isFallbackActive: true });
	});
}

async function auditActions(t: Harness): Promise<string[]> {
	const rows = await t.run(async (ctx) => await ctx.db.query('auditLogs').collect());
	return rows.map((row) => row.action);
}

async function decisions(t: Harness) {
	return await t.run(async (ctx) => await ctx.db.query('mixDecisions').collect());
}

async function routeStates(t: Harness) {
	return await t.run(async (ctx) => await ctx.db.query('deliverabilityRouteStates').collect());
}

describe('the ESP path', () => {
	it('opens the cell at its stream’s initial share and stamps the first rung', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG, omitManagedCell: true });
		await connectRelay(t);

		const result = await t.mutation(api.delivery.rampEnrollment.enrollCell, CELL);
		expect(result).toMatchObject({
			enrolled: true,
			path: 'esp_relay',
			share: RAMP_STREAM_CONFIGS.campaign.initialShareFraction,
		});

		const row = await readManagedCell(t);
		expect(row?.ownShare).toBe(RAMP_STREAM_CONFIGS.campaign.initialShareFraction);
		// The derived boolean view stays consistent with the share (plan D1): at 2%
		// the relay carries the rest, so the fallback IS active.
		expect(row?.isFallbackActive).toBe(true);
		expect(row?.phaseCeiling).toBe(RAMP_INITIAL_PHASE_CEILING);
		// THE DWELL ANCHOR ARRIVES WITH THE RUNG. Without it the standalone
		// promotion route reports `unknown` for ever on a provider with no external
		// route, and the cell could never be promoted by anyone.
		expect(row?.phaseCeilingSince).toBeGreaterThan(0);
		expect(row?.cleanStreak).toBe(0);
		// Enrolment IS a mix generation: the cell's recipients are assigned to two
		// arms for the first time (plan D7).
		expect(row?.mixVersion).toBe(1);
		expect(row?.graduatedAt).toBeUndefined();
	});

	it('opens transactional at zero — the stream that ramps last', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG, omitManagedCell: true });
		await connectRelay(t);

		const result = await t.mutation(api.delivery.rampEnrollment.enrollCell, {
			stream: 'transactional' as const,
			destinationProvider: 'gmail' as const,
		});
		expect(result.share).toBe(0);
		const rows = await routeStates(t);
		expect(rows.find((row) => row.stream === 'transactional')?.ownShare).toBe(0);
	});
});

describe('the own-server path', () => {
	it('opens at full share on the ladder’s top rung when there is no relay', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG, omitManagedCell: true });

		const result = await t.mutation(api.delivery.rampEnrollment.enrollCell, CELL);
		expect(result).toMatchObject({ enrolled: true, path: 'own_server', share: 1 });

		const row = await readManagedCell(t);
		expect(row?.ownShare).toBe(1);
		expect(row?.isFallbackActive).toBe(false);
		// THE RUNG IS THE TOP ONE ON PURPOSE. The phase ladder bounds the SHARE
		// dial; on the first rung the controller would pull three quarters of this
		// cell back toward a relay the deployment does not have.
		expect(row?.phaseCeiling).toBe(RAMP_TOP_PHASE_CEILING);
	});
});

describe('the audit pair (plan D12)', () => {
	it('records who enrolled the cell, and the move it made', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG, omitManagedCell: true });
		await connectRelay(t);

		await t.mutation(api.delivery.rampEnrollment.enrollCell, CELL);

		expect(await auditActions(t)).toContain('deliverability_ramp.cell_enrolled');
		const recorded = await decisions(t);
		expect(recorded).toHaveLength(1);
		expect(recorded[0]?.reason).toBe('operator_enrollment');
		expect(recorded[0]?.cell).toBe('campaign:gmail');
		// A healthy provider slice means the cell was already sending everything
		// from the own MTA, so enrolling on the ESP path is a CUT toward the relay.
		expect(recorded[0]?.fromShare).toBe(1);
		expect(recorded[0]?.toShare).toBe(RAMP_STREAM_CONFIGS.campaign.initialShareFraction);
		expect(recorded[0]?.direction).toBe('decrease');
		expect(recorded[0]?.message).toContain('operator');
		expect(recorded[0]?.snapshot).toContain('esp_relay');
	});
});

describe('a cell that is already managed', () => {
	it('is refused, and nothing about its state is reset', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG, ownShare: 0.4, cleanStreak: 3, mixVersion: 2 });

		const result = await t.mutation(api.delivery.rampEnrollment.enrollCell, CELL);
		expect(result).toEqual({ enrolled: false, refusal: 'cell_already_ramp_managed' });

		const row = await readManagedCell(t);
		expect(row?.ownShare).toBe(0.4);
		expect(row?.cleanStreak).toBe(3);
		expect(row?.mixVersion).toBe(2);
		expect(await decisions(t)).toHaveLength(0);
		expect(await auditActions(t)).toHaveLength(0);
	});
});

describe('a per-stream row with no stored share', () => {
	it('is patched rather than duplicated', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG, omitManagedCell: true });
		const now = Date.now();
		await t.run(async (ctx) => {
			await ctx.db.insert('deliverabilityRouteStates', {
				organizationId: ORG,
				destinationProvider: 'gmail' as const,
				stream: 'campaign' as const,
				isFallbackActive: false,
				signals: [],
				mixVersion: 4,
				snapshotGeneratedAt: now,
				expiresAt: now + 60_000,
				updatedAt: now,
			});
		});

		await t.mutation(api.delivery.rampEnrollment.enrollCell, CELL);

		const perStream = (await routeStates(t)).filter((row) => row.stream === 'campaign');
		expect(perStream).toHaveLength(1);
		expect(perStream[0]?.ownShare).toBe(1);
		// The generation advances from the one the row already carried, so a cell
		// re-enrolled after a spell off the ramp cannot reuse an old assignment.
		expect(perStream[0]?.mixVersion).toBe(5);
	});
});

/**
 * A HAND ON THE CONTROL IS STILL A HAND INSIDE THE HARD STOPS — and enrolment
 * can be an increase: a cell whose provider slice is in relay fallback resolves
 * to 0 today, so putting it on the ramp at full share moves every recipient onto
 * the own MTA in one step. That is exactly the move the hard stops exist for.
 */
describe('hard stops bound an enrolment that RAISES the share', () => {
	it('refuses while the global kill switch is engaged, and creates no row', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG, omitManagedCell: true, isPaused: true });
		await holdProviderSliceInFallback(t);

		const result = await t.mutation(api.delivery.rampEnrollment.enrollCell, CELL);
		expect(result).toEqual({ enrolled: false, refusal: 'controller_paused' });
		expect((await routeStates(t)).some((row) => row.stream === 'campaign')).toBe(false);
		expect(await decisions(t)).toHaveLength(0);
	});

	it('refuses while sending is abuse-suspended', async () => {
		const t = harness();
		await seedRampCell(t, {
			organizationId: ORG,
			omitManagedCell: true,
			abuseStatus: 'suspended',
		});
		await holdProviderSliceInFallback(t);

		const result = await t.mutation(api.delivery.rampEnrollment.enrollCell, CELL);
		expect(result).toEqual({ enrolled: false, refusal: 'hard_stop_active' });
	});

	it('refuses while a critical pool blocklist listing stands', async () => {
		const t = harness();
		await seedRampCell(t, {
			organizationId: ORG,
			omitManagedCell: true,
			poolSignals: [{ source: 'dnsbl_listed', severity: 'critical', observedAt: Date.now() }],
		});
		await holdProviderSliceInFallback(t);

		const result = await t.mutation(api.delivery.rampEnrollment.enrollCell, CELL);
		expect(result).toEqual({ enrolled: false, refusal: 'hard_stop_active' });
	});

	it('still enrols a CUT toward the relay while the kill switch is engaged', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG, omitManagedCell: true, isPaused: true });
		await connectRelay(t);

		// The slice is healthy, so the cell sends everything from the own MTA today
		// and enrolling at 2% moves traffic TO the relay. A retreat is never blocked.
		const result = await t.mutation(api.delivery.rampEnrollment.enrollCell, CELL);
		expect(result.enrolled).toBe(true);
		expect((await readManagedCell(t))?.ownShare).toBe(
			RAMP_STREAM_CONFIGS.campaign.initialShareFraction
		);
	});
});

describe('the admin floor', () => {
	it('refuses a non-admin caller and writes nothing', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG, omitManagedCell: true });
		session.isAdmin = false;
		try {
			await expect(t.mutation(api.delivery.rampEnrollment.enrollCell, CELL)).rejects.toThrow();
		} finally {
			session.isAdmin = true;
		}
		expect((await routeStates(t)).some((row) => row.stream === 'campaign')).toBe(false);
		expect(await auditActions(t)).toHaveLength(0);
	});
});

describe('cross-tenant', () => {
	it('files the enrolment against the caller’s own organization only', async () => {
		const t = harness();
		await seedRampCell(t, { organizationId: ORG, omitManagedCell: true });

		// The cell arguments are unchanged; only the SESSION's tenant moved.
		session.organizationId = OTHER_ORG;
		await t.mutation(api.delivery.rampEnrollment.enrollCell, CELL);

		const perStream = (await routeStates(t)).filter((row) => row.stream === 'campaign');
		expect(perStream).toHaveLength(1);
		expect(perStream[0]?.organizationId).toBe(OTHER_ORG);
	});
});
