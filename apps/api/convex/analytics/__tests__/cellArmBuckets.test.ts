/**
 * cellArmBuckets — the plumbing `transportOutcomes` and `smtpResponseCategories`
 * share.
 *
 * The deliverability gate reads the two tables side by side, so the window
 * range and the send → (cell, arm) join must behave identically for both. The
 * range is pinned as a pure function; the join is driven through BOTH writers
 * over the same seeded sends, so a module that grew its own join again would
 * disagree with the shared resolver here.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../../_generated/api';
import { newHarness } from '../../__tests__/testModules';
import { startOfDayUtc } from '../../lib/clock';
import { getSingletonOrganizationId } from '../../lib/sessionOrganization';
import type * as SessionOrganization from '../../lib/sessionOrganization';
import { cellArmPeriodRange, resolveCellArmForSend } from '../cellArmBuckets';
import { recordTransportOutcomeForSend } from '../transportOutcomes';
import {
	GMAIL_CAMPAIGN_CELL,
	OTHER_ORG,
	OUTCOME_ORG,
	seedAssignedSend,
	type SeedSendOptions,
} from './transportOutcomesFixtures';

vi.mock('../../lib/sessionOrganization', async (importOriginal) => {
	const actual = await importOriginal<typeof SessionOrganization>();
	return { ...actual, getSingletonOrganizationId: vi.fn().mockResolvedValue('org_outcomes') };
});

afterEach(() => {
	vi.mocked(getSingletonOrganizationId).mockResolvedValue(OUTCOME_ORG);
});

const NOW = Date.UTC(2026, 6, 15, 12, 0, 0);

describe('cellArmPeriodRange', () => {
	it('uses sentinels for an absent window', () => {
		expect(cellArmPeriodRange(undefined)).toEqual({ lower: 0, upper: Number.MAX_SAFE_INTEGER });
		expect(cellArmPeriodRange({})).toEqual({ lower: 0, upper: Number.MAX_SAFE_INTEGER });
	});

	it('floors the lower bound to its UTC day and keeps the upper bound exact', () => {
		expect(cellArmPeriodRange({ since: NOW, until: NOW + 1 })).toEqual({
			lower: startOfDayUtc(NOW),
			upper: NOW + 1,
		});
	});

	it('treats a non-finite bound as absent rather than as an empty window', () => {
		expect(cellArmPeriodRange({ since: Number.NaN, until: Number.POSITIVE_INFINITY })).toEqual({
			lower: 0,
			upper: Number.MAX_SAFE_INTEGER,
		});
		expect(cellArmPeriodRange({ since: Number.NEGATIVE_INFINITY, until: NOW })).toEqual({
			lower: 0,
			upper: NOW,
		});
	});
});

describe('resolveCellArmForSend, through both metric writers', () => {
	/**
	 * Seed one send, then ask the shared resolver, the transport-outcome writer
	 * and the SMTP-category writer about it. All three must give the same answer,
	 * and a refused send must leave both tables empty.
	 */
	async function resolveThreeWays(seed: SeedSendOptions) {
		const t = newHarness();
		const providerMessageId = 'mta-msg-parity';
		const { sendId } = await t.run(
			async (ctx) => await seedAssignedSend(ctx, { ...seed, providerMessageId })
		);
		const resolved = await t.run(async (ctx) => await resolveCellArmForSend(ctx, sendId));
		const outcome = await t.run(
			async (ctx) =>
				await recordTransportOutcomeForSend(ctx, { sendId, event: 'delivered', now: NOW })
		);
		const { result: smtp } = await t.mutation(
			internal.analytics.smtpResponseCategories.recordClassifiedResponse,
			{ providerMessageId, category: 'greylisted', observedAt: NOW }
		);
		const rows = await t.run(async (ctx) => ({
			outcomes: await ctx.db.query('transportOutcomes').collect(),
			smtp: await ctx.db.query('smtpResponseCategories').collect(),
		}));
		return { resolved, outcome, smtp, rows };
	}

	it.each([
		{ name: 'a send with no assignment row', seed: {}, reason: 'no_assignment' },
		{
			name: "a send assigned under another tenant's id",
			seed: { assignment: { organizationId: OTHER_ORG } },
			reason: 'no_assignment',
		},
		{
			name: 'a send whose assignment carries a malformed cell',
			seed: { assignment: { cell: 'not-a-cell-key' } },
			reason: 'invalid_cell',
		},
	] as const)('refuses $name with $reason in both modules', async ({ seed, reason }) => {
		const { resolved, outcome, smtp, rows } = await resolveThreeWays(seed);
		expect(resolved).toEqual({ ok: false, reason });
		expect(outcome).toBe(reason);
		expect(smtp).toBe(reason);
		expect(rows).toEqual({ outcomes: [], smtp: [] });
	});

	it('refuses with no_organization in both modules when the org cannot be named', async () => {
		vi.mocked(getSingletonOrganizationId).mockRejectedValue(new Error('no org'));
		const { resolved, outcome, smtp, rows } = await resolveThreeWays({
			assignment: { cell: GMAIL_CAMPAIGN_CELL },
		});
		expect(resolved).toEqual({ ok: false, reason: 'no_organization' });
		expect(outcome).toBe('no_organization');
		expect(smtp).toBe('no_organization');
		expect(rows).toEqual({ outcomes: [], smtp: [] });
	});

	it('hands both writers the same canonical cell and arm for an assigned send', async () => {
		const { resolved, outcome, smtp, rows } = await resolveThreeWays({
			assignment: { cell: GMAIL_CAMPAIGN_CELL, arm: 'reference', isCalibration: true },
		});
		expect(resolved).toEqual({
			ok: true,
			organizationId: OUTCOME_ORG,
			cell: GMAIL_CAMPAIGN_CELL,
			arm: 'reference',
			isCalibration: true,
		});
		expect(outcome).toBe('recorded');
		expect(smtp).toBe('recorded');
		const keyOf = (row: { organizationId: string; cell: string; arm: string }) => ({
			organizationId: row.organizationId,
			cell: row.cell,
			arm: row.arm,
		});
		const expected = { organizationId: OUTCOME_ORG, cell: GMAIL_CAMPAIGN_CELL, arm: 'reference' };
		expect(rows.outcomes.map(keyOf)).toEqual([expected]);
		expect(rows.smtp.map(keyOf)).toEqual([expected]);
	});
});
