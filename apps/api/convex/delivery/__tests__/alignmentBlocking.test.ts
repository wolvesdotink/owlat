/**
 * The BLOCK and the LIFT (P3-5).
 *
 * A cell whose sending domain has ANY failing alignment check cannot be moved
 * above s=0 — the gate the controller reads returns a hold, and applying it to
 * a proposed share pins the share at 0. The block LIFTS as soon as the daily
 * re-check records a passing verdict; nothing else has to happen.
 *
 * Also the D2 half at the persistence layer: a domain with no relay identity
 * yields a target whose reference arm is null, records `single_arm`, and opens
 * the gate.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import {
	ALIGNMENT_CHECK_IDS,
	ALIGNMENT_RECHECK_INTERVAL_MS,
	ALIGNMENT_UNKNOWN_RETRY_MS,
	alignmentGate,
	applyAlignmentGateToShare,
	evaluateAlignmentPreflight,
	type AlignmentCheckResult,
} from '@owlat/shared/deliverabilityAlignment';
import { alignmentCheckIdValidator, alignmentVerdictValidator } from '../deliverabilityValidators';

import { modules } from './testModules';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return { ...actual, getSingletonOrganizationId: vi.fn().mockResolvedValue('org-a') };
});

const NOW = 1_800_000_000_000;
const DOMAIN = 'acme.com';

const BLOCKING_CHECKS: AlignmentCheckResult[] = [
	{ id: 'from_domain', status: 'pass', detail: 'Both arms send from acme.com.', remedy: '' },
	{
		id: 'spf',
		status: 'fail',
		detail: 'The merged SPF record needs 11 DNS lookups; RFC 7208 allows 10.',
		remedy: 'Flatten include:i.example',
	},
	{ id: 'dkim', status: 'pass', detail: 'distinct selectors', remedy: '' },
	{ id: 'dmarc', status: 'pass', detail: 'aligned', remedy: '' },
];

const PASSING_CHECKS: AlignmentCheckResult[] = ALIGNMENT_CHECK_IDS.map((id) => ({
	id,
	status: 'pass' as const,
	detail: 'ok',
	remedy: '',
}));

async function seedDomain(
	t: TestConvex<typeof schema>,
	options: { withRelay: boolean }
): Promise<void> {
	await t.run(async (ctx) => {
		const domainId = await ctx.db.insert('domains', {
			domain: DOMAIN,
			status: 'verified',
			dnsRecords: { spf: { value: 'v=spf1 ip4:203.0.113.10 include:amazonses.com ~all' } },
			createdAt: NOW,
			updatedAt: NOW,
		});
		await ctx.db.insert('sendingDomainMtaIdentities', {
			domainId,
			dkimSelector: 'owlat',
			createdAt: NOW,
			updatedAt: NOW,
		});
		if (options.withRelay) {
			await ctx.db.insert('sendingDomainSesIdentities', {
				domainId,
				dkimTokens: ['ses-token-1'],
				verificationToken: 'token',
				dnsRecords: { spf: { value: 'v=spf1 include:amazonses.com ~all' } },
				createdAt: NOW,
				updatedAt: NOW,
			});
		}
	});
}

async function record(
	t: TestConvex<typeof schema>,
	options: {
		verdict: 'aligned' | 'blocked' | 'unknown' | 'single_arm';
		checks: AlignmentCheckResult[];
		checkedAt: number;
		nextCheckDueAt: number;
	}
): Promise<void> {
	await t.mutation(internal.delivery.alignmentPreflight.recordAlignmentResult, {
		domain: DOMAIN,
		verdict: options.verdict,
		checks: options.checks,
		degradedMeasurement: false,
		checkedAt: options.checkedAt,
		nextCheckDueAt: options.nextCheckDueAt,
	});
}

describe('a failing check blocks the cell from any share above 0', () => {
	it('holds the gate and pins a proposed share at 0, then lifts on the re-check', async () => {
		const t = convexTest(schema, modules);
		await seedDomain(t, { withRelay: true });
		await record(t, {
			verdict: 'blocked',
			checks: BLOCKING_CHECKS,
			checkedAt: NOW,
			nextCheckDueAt: NOW + ALIGNMENT_RECHECK_INTERVAL_MS,
		});

		const blocked = await t.query(internal.delivery.alignmentPreflight.getAlignmentGateState, {
			domain: DOMAIN,
		});
		expect(blocked.hasReferenceArm).toBe(true);
		const blockedGate = alignmentGate({ ...blocked, now: NOW });
		expect(blockedGate.allowsShareAboveZero).toBe(false);
		expect(blockedGate.reason).toBe('blocked');
		expect(applyAlignmentGateToShare(0.25, blockedGate)).toBe(0);

		// The daily re-check finds the record fixed.
		await record(t, {
			verdict: 'aligned',
			checks: PASSING_CHECKS,
			checkedAt: NOW + ALIGNMENT_RECHECK_INTERVAL_MS,
			nextCheckDueAt: NOW + 2 * ALIGNMENT_RECHECK_INTERVAL_MS,
		});
		const lifted = await t.query(internal.delivery.alignmentPreflight.getAlignmentGateState, {
			domain: DOMAIN,
		});
		const liftedGate = alignmentGate({
			...lifted,
			now: NOW + ALIGNMENT_RECHECK_INTERVAL_MS,
		});
		expect(liftedGate.allowsShareAboveZero).toBe(true);
		expect(applyAlignmentGateToShare(0.25, liftedGate)).toBe(0.25);
	});

	it('holds an UNKNOWN verdict without reporting a fault', async () => {
		const t = convexTest(schema, modules);
		await seedDomain(t, { withRelay: true });
		await record(t, {
			verdict: 'unknown',
			checks: ALIGNMENT_CHECK_IDS.map((id) => ({
				id,
				status: 'unknown' as const,
				detail: 'servfail',
				remedy: 'DNS could not be resolved.',
			})),
			checkedAt: NOW,
			nextCheckDueAt: NOW + ALIGNMENT_UNKNOWN_RETRY_MS,
		});
		const state = await t.query(internal.delivery.alignmentPreflight.getAlignmentGateState, {
			domain: DOMAIN,
		});
		const gate = alignmentGate({ ...state, now: NOW });
		expect(gate.reason).toBe('unknown_hold');
		expect(gate.allowsShareAboveZero).toBe(false);
	});

	it('never lets a stale sweep overwrite a fresher verdict', async () => {
		const t = convexTest(schema, modules);
		await seedDomain(t, { withRelay: true });
		await record(t, {
			verdict: 'aligned',
			checks: PASSING_CHECKS,
			checkedAt: NOW,
			nextCheckDueAt: NOW + ALIGNMENT_RECHECK_INTERVAL_MS,
		});
		await record(t, {
			verdict: 'blocked',
			checks: BLOCKING_CHECKS,
			checkedAt: NOW - 60_000,
			nextCheckDueAt: NOW,
		});
		const state = await t.query(internal.delivery.alignmentPreflight.getAlignmentGateState, {
			domain: DOMAIN,
		});
		expect(state.state?.verdict).toBe('aligned');
	});
});

describe('the sweep target assembly', () => {
	it('is due when no verdict exists and not due before nextCheckDueAt', async () => {
		const t = convexTest(schema, modules);
		await seedDomain(t, { withRelay: true });
		const due = await t.query(internal.delivery.alignmentPreflight.listDueAlignmentTargets, {
			now: NOW,
		});
		expect(due).toHaveLength(1);
		expect(due[0]?.domain).toBe(DOMAIN);
		expect(due[0]?.ownArm.dkimSelectors).toEqual(['owlat']);
		expect(due[0]?.referenceArm?.dkimSelectors).toEqual(['ses-token-1']);
		expect(due[0]?.ownArm.spfMechanisms).toContain('ip4:203.0.113.10');

		await record(t, {
			verdict: 'aligned',
			checks: PASSING_CHECKS,
			checkedAt: NOW,
			nextCheckDueAt: NOW + ALIGNMENT_RECHECK_INTERVAL_MS,
		});
		expect(
			await t.query(internal.delivery.alignmentPreflight.listDueAlignmentTargets, { now: NOW })
		).toHaveLength(0);
		expect(
			await t.query(internal.delivery.alignmentPreflight.listDueAlignmentTargets, {
				now: NOW + ALIGNMENT_RECHECK_INTERVAL_MS,
			})
		).toHaveLength(1);
	});

	it('yields a null reference arm and a single_arm verdict with no relay identity (D2)', async () => {
		const t = convexTest(schema, modules);
		await seedDomain(t, { withRelay: false });
		const due = await t.query(internal.delivery.alignmentPreflight.listDueAlignmentTargets, {
			now: NOW,
		});
		expect(due[0]?.referenceArm).toBeNull();

		const target = due[0];
		if (!target) throw new Error('expected a due target');
		const result = evaluateAlignmentPreflight({
			ownArm: target.ownArm,
			referenceArm: target.referenceArm,
			dns: { fromDomainTxt: { state: 'absent' }, dmarcTxt: { state: 'absent' }, dkimTxt: {} },
			checkedAt: NOW,
		});
		expect(result.verdict).toBe('single_arm');

		await record(t, {
			verdict: result.verdict,
			checks: result.checks,
			checkedAt: result.checkedAt,
			nextCheckDueAt: result.nextCheckDueAt,
		});
		const state = await t.query(internal.delivery.alignmentPreflight.getAlignmentGateState, {
			domain: DOMAIN,
		});
		expect(state.hasReferenceArm).toBe(false);
		expect(alignmentGate({ ...state, now: NOW }).allowsShareAboveZero).toBe(true);
	});
});

describe('the stored vocabulary matches the shared union', () => {
	it('keeps the check-id and verdict validators in parity with the shared types', () => {
		const validatorIds = alignmentCheckIdValidator.members.map((member) => String(member.value));
		expect(validatorIds.sort()).toEqual([...ALIGNMENT_CHECK_IDS].sort());
		const verdicts = alignmentVerdictValidator.members.map((member) => String(member.value));
		expect(verdicts.sort()).toEqual(['aligned', 'blocked', 'single_arm', 'unknown']);
	});
});
