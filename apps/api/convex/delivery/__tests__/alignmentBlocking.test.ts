/**
 * The BLOCK and the LIFT (P3-5), against real table writes.
 *
 * A cell whose sending domain has ANY failing alignment check cannot be moved
 * above s=0 — the gate the controller reads returns a hold, and applying it to a
 * proposed share pins the share at 0. The block LIFTS as soon as the re-check
 * records a passing verdict; nothing else has to happen.
 *
 * Also covered here, because these are the questions the STATE layer answers and
 * the pure core cannot:
 *  - which transports count as a second arm (providerRoutes / EMAIL_PROVIDER,
 *    not the SES identity table alone) — a Resend/SMTP/plugin relay must never
 *    be reported as `single_arm`;
 *  - a relay-only domain (no own-MTA identity) must not produce a permanent,
 *    unactionable `blocked`;
 *  - the sweep must not starve past its first page;
 *  - every read is scoped to one organization.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import {
	ALIGNMENT_CHECK_IDS,
	ALIGNMENT_RECHECK_INTERVAL_MS,
	ALIGNMENT_UNKNOWN_RETRY_MS,
	evaluateAlignmentPreflight,
	type AlignmentCheckResult,
} from '@owlat/shared/deliverabilityAlignment';
import {
	alignmentGate,
	applyAlignmentGateToShare,
} from '@owlat/shared/deliverabilityAlignmentGate';
import { alignmentCheckIdValidator, alignmentVerdictValidator } from '../deliverabilityValidators';

import { modules } from './testModules';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof import('../../lib/sessionOrganization')>(
		'../../lib/sessionOrganization'
	);
	return {
		...actual,
		getSingletonOrganizationId: vi.fn().mockResolvedValue('org-a'),
		requireOrgMember: vi.fn(async () => ({ userId: 'test-user', role: 'admin' as const })),
	};
});

const NOW = 1_800_000_000_000;
const DOMAIN = 'acme.com';
const POOL_IP = '203.0.113.10';

function stubTransportEnv(options: { pools?: string } = {}): void {
	vi.stubEnv('MTA_IP_POOLS', options.pools ?? POOL_IP);
	// The single-transport env must not be mistaken for a relay in these fixtures;
	// the relay is expressed through providerRoutes.
	vi.stubEnv('EMAIL_PROVIDER', 'mta');
}

afterEach(() => {
	vi.unstubAllEnvs();
});

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

/** An enabled route entry for `kind`, i.e. "a relay is really configured". */
async function seedRelayRoute(t: TestConvex<typeof schema>, kind: string): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('providerRoutes', {
			messageType: 'campaign',
			strategy: 'priority_failover',
			providers: [
				{ providerType: 'mta', isEnabled: true },
				{ providerType: kind, isEnabled: true },
			],
			createdAt: NOW,
			updatedAt: NOW,
		});
	});
}

async function seedDomain(
	t: TestConvex<typeof schema>,
	options: { relay?: 'ses' | 'resend' | 'smtp' | null; ownIdentity?: boolean; domain?: string } = {}
): Promise<void> {
	const domainName = options.domain ?? DOMAIN;
	const relay = options.relay ?? null;
	await t.run(async (ctx) => {
		const domainId = await ctx.db.insert('domains', {
			domain: domainName,
			status: 'verified',
			dnsRecords: { spf: { value: `v=spf1 ip4:${POOL_IP} include:amazonses.com ~all` } },
			createdAt: NOW,
			updatedAt: NOW,
		});
		if (options.ownIdentity !== false) {
			await ctx.db.insert('sendingDomainMtaIdentities', {
				domainId,
				dkimSelector: 'owlat',
				createdAt: NOW,
				updatedAt: NOW,
			});
		}
		if (relay === 'ses') {
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
	if (relay !== null) await seedRelayRoute(t, relay);
}

async function record(
	t: TestConvex<typeof schema>,
	options: {
		verdict: 'aligned' | 'blocked' | 'unknown' | 'single_arm';
		checks: AlignmentCheckResult[];
		checkedAt: number;
		nextCheckDueAt: number;
		domain?: string;
	}
): Promise<void> {
	await t.mutation(internal.delivery.alignmentPreflight.recordAlignmentResult, {
		domain: options.domain ?? DOMAIN,
		verdict: options.verdict,
		checks: options.checks,
		degradedMeasurement: false,
		checkedAt: options.checkedAt,
		nextCheckDueAt: options.nextCheckDueAt,
	});
}

function firstPage(now: number) {
	return { now, paginationOpts: { cursor: null, numItems: 5 } };
}

describe('a failing check blocks the cell from any share above 0', () => {
	it('holds the gate and pins a proposed share at 0, then lifts on the re-check', async () => {
		stubTransportEnv();
		const t = convexTest(schema, modules);
		await seedDomain(t, { relay: 'ses' });
		await record(t, {
			verdict: 'blocked',
			checks: BLOCKING_CHECKS,
			checkedAt: NOW,
			nextCheckDueAt: NOW + ALIGNMENT_RECHECK_INTERVAL_MS,
		});

		const blocked = await t.query(internal.delivery.alignmentPreflight.getAlignmentGateState, {
			domain: DOMAIN,
		});
		expect(blocked.referenceArm).toBe('configured');
		const blockedGate = alignmentGate({ ...blocked, now: NOW });
		expect(blockedGate.allowsShareAboveZero).toBe(false);
		expect(blockedGate.reason).toBe('blocked');
		expect(applyAlignmentGateToShare(0.25, blockedGate)).toBe(0);

		// The re-check finds the record fixed.
		await record(t, {
			verdict: 'aligned',
			checks: PASSING_CHECKS,
			checkedAt: NOW + ALIGNMENT_RECHECK_INTERVAL_MS,
			nextCheckDueAt: NOW + 2 * ALIGNMENT_RECHECK_INTERVAL_MS,
		});
		const lifted = await t.query(internal.delivery.alignmentPreflight.getAlignmentGateState, {
			domain: DOMAIN,
		});
		const liftedGate = alignmentGate({ ...lifted, now: NOW + ALIGNMENT_RECHECK_INTERVAL_MS });
		expect(liftedGate.allowsShareAboveZero).toBe(true);
		expect(applyAlignmentGateToShare(0.25, liftedGate)).toBe(0.25);
	});

	it('holds an UNKNOWN verdict without reporting a fault', async () => {
		stubTransportEnv();
		const t = convexTest(schema, modules);
		await seedDomain(t, { relay: 'ses' });
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
		stubTransportEnv();
		const t = convexTest(schema, modules);
		await seedDomain(t, { relay: 'ses' });
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

describe('what counts as a second arm comes from the transport surface', () => {
	it('builds the reference arm for an SES relay', async () => {
		stubTransportEnv();
		const t = convexTest(schema, modules);
		await seedDomain(t, { relay: 'ses' });
		const page = await t.query(
			internal.delivery.alignmentPreflight.listDueAlignmentTargets,
			firstPage(NOW)
		);
		const target = page.targets[0];
		expect(target?.reference.kind).toBe('arm');
		if (target?.reference.kind !== 'arm') throw new Error('expected a reference arm');
		expect(target.reference.arm.dkimSelectors).toEqual(['ses-token-1']);
		expect(target.ownArm.spfMechanisms).toEqual([`ip4:${POOL_IP}`]);
	});

	for (const kind of ['resend', 'smtp', 'plugin.acme.relay'] as const) {
		it(`records a ${kind} relay as UNKNOWN — never single_arm`, async () => {
			stubTransportEnv();
			const t = convexTest(schema, modules);
			// A non-SES relay is enabled on the route, and there is no signing
			// identity we can describe for it.
			await seedDomain(t, { relay: null });
			await seedRelayRoute(t, kind);
			const page = await t.query(
				internal.delivery.alignmentPreflight.listDueAlignmentTargets,
				firstPage(NOW)
			);
			const target = page.targets[0];
			expect(target?.reference.kind).toBe('unknown');

			const gateState = await t.query(internal.delivery.alignmentPreflight.getAlignmentGateState, {
				domain: DOMAIN,
			});
			expect(gateState.referenceArm).toBe('unknown');
			const gate = alignmentGate({ ...gateState, now: NOW });
			expect(gate.allowsShareAboveZero).toBe(false);
			expect(gate.reason).toBe('reference_arm_unknown');
		});
	}

	it('treats EMAIL_PROVIDER on its own as a configured relay', async () => {
		stubTransportEnv();
		vi.stubEnv('EMAIL_PROVIDER', 'resend');
		const t = convexTest(schema, modules);
		await seedDomain(t, { relay: null });
		const gateState = await t.query(internal.delivery.alignmentPreflight.getAlignmentGateState, {
			domain: DOMAIN,
		});
		expect(gateState.referenceArm).toBe('unknown');
	});

	it('is single_arm with no relay anywhere, and opens the gate (D2)', async () => {
		stubTransportEnv();
		const t = convexTest(schema, modules);
		await seedDomain(t, { relay: null });
		const page = await t.query(
			internal.delivery.alignmentPreflight.listDueAlignmentTargets,
			firstPage(NOW)
		);
		const target = page.targets[0];
		if (!target) throw new Error('expected a due target');
		expect(target.reference.kind).toBe('none');

		const result = evaluateAlignmentPreflight({
			ownArm: target.ownArm,
			reference: target.reference,
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
		expect(state.referenceArm).toBe('none');
		expect(alignmentGate({ ...state, now: NOW }).allowsShareAboveZero).toBe(true);
	});

	it('holds when MTA_IP_POOLS is unset, rather than passing SPF on a relay-only record', async () => {
		vi.stubEnv('MTA_IP_POOLS', '');
		vi.stubEnv('EMAIL_PROVIDER', 'mta');
		const t = convexTest(schema, modules);
		await seedDomain(t, { relay: 'ses' });
		const page = await t.query(
			internal.delivery.alignmentPreflight.listDueAlignmentTargets,
			firstPage(NOW)
		);
		const target = page.targets[0];
		if (!target) throw new Error('expected a due target');
		expect(target.ownArm.spfMechanisms).toEqual([]);

		const result = evaluateAlignmentPreflight({
			ownArm: target.ownArm,
			reference: target.reference,
			dns: {
				// The stored value for an SES-registered domain IS the relay include —
				// which must not be enough to pass the own arm's half of the check.
				fromDomainTxt: { state: 'found', records: ['v=spf1 include:amazonses.com ~all'] },
				dmarcTxt: { state: 'found', records: ['v=DMARC1; p=none'] },
				dkimTxt: {},
			},
			checkedAt: NOW,
		});
		const spf = result.checks.find((check) => check.id === 'spf');
		expect(spf?.status).toBe('unknown');
		expect(spf?.remedy).toContain('MTA_IP_POOLS');
		expect(result.allowsShareAboveZero).toBe(false);
	});
});

describe('a relay-only domain is skipped, not permanently blocked', () => {
	it('produces no target and therefore no unactionable verdict', async () => {
		stubTransportEnv();
		const t = convexTest(schema, modules);
		await seedDomain(t, { relay: 'ses', ownIdentity: false });
		const page = await t.query(
			internal.delivery.alignmentPreflight.listDueAlignmentTargets,
			firstPage(NOW)
		);
		expect(page.targets).toEqual([]);
		const readiness = await t.query(api.delivery.alignmentPreflight.getAlignmentReadiness, {});
		expect(readiness).toEqual([]);
	});
});

describe('the sweep is due-driven and does not starve past the first page', () => {
	it('walks every verified domain across pages', async () => {
		stubTransportEnv();
		const t = convexTest(schema, modules);
		const domains = Array.from({ length: 12 }, (_, index) => `d${index}.example`);
		for (const domain of domains) {
			await seedDomain(t, { relay: null, domain });
		}

		const seen: string[] = [];
		let cursor: string | null = null;
		for (let page = 0; page < 10; page += 1) {
			const slice: { targets: { domain: string }[]; continueCursor: string; isDone: boolean } =
				await t.query(internal.delivery.alignmentPreflight.listDueAlignmentTargets, {
					now: NOW,
					paginationOpts: { cursor, numItems: 5 },
				});
			seen.push(...slice.targets.map((target) => target.domain));
			cursor = slice.continueCursor;
			if (slice.isDone) break;
		}
		expect(seen.sort()).toEqual([...domains].sort());
	});

	it('skips a domain that is not due yet and returns it once it is', async () => {
		stubTransportEnv();
		const t = convexTest(schema, modules);
		await seedDomain(t, { relay: 'ses' });
		expect(
			(await t.query(internal.delivery.alignmentPreflight.listDueAlignmentTargets, firstPage(NOW)))
				.targets
		).toHaveLength(1);

		await record(t, {
			verdict: 'aligned',
			checks: PASSING_CHECKS,
			checkedAt: NOW,
			nextCheckDueAt: NOW + ALIGNMENT_RECHECK_INTERVAL_MS,
		});
		expect(
			(await t.query(internal.delivery.alignmentPreflight.listDueAlignmentTargets, firstPage(NOW)))
				.targets
		).toHaveLength(0);
		expect(
			(
				await t.query(
					internal.delivery.alignmentPreflight.listDueAlignmentTargets,
					firstPage(NOW + ALIGNMENT_RECHECK_INTERVAL_MS)
				)
			).targets
		).toHaveLength(1);
	});
});

describe('the readiness read', () => {
	it('returns the stored verdict with the reason mapped to null when absent', async () => {
		stubTransportEnv();
		const t = convexTest(schema, modules);
		await seedDomain(t, { relay: 'ses' });
		await record(t, {
			verdict: 'blocked',
			checks: BLOCKING_CHECKS,
			checkedAt: NOW,
			nextCheckDueAt: NOW + ALIGNMENT_RECHECK_INTERVAL_MS,
		});
		const rows = await t.query(api.delivery.alignmentPreflight.getAlignmentReadiness, {});
		expect(rows).toHaveLength(1);
		expect(rows[0]?.domain).toBe(DOMAIN);
		expect(rows[0]?.verdict).toBe('blocked');
		expect(rows[0]?.degradedMeasurementReason).toBeNull();
		expect(rows[0]?.checks.find((check) => check.id === 'spf')?.remedy).toContain('Flatten');
	});

	it('surfaces the degraded-measurement reason when one was recorded', async () => {
		stubTransportEnv();
		const t = convexTest(schema, modules);
		await seedDomain(t, { relay: 'ses' });
		await t.mutation(internal.delivery.alignmentPreflight.recordAlignmentResult, {
			domain: DOMAIN,
			verdict: 'aligned',
			checks: PASSING_CHECKS,
			degradedMeasurement: true,
			degradedMeasurementReason: 'SES relay cannot carry our custom return path.',
			checkedAt: NOW,
			nextCheckDueAt: NOW + ALIGNMENT_RECHECK_INTERVAL_MS,
		});
		const rows = await t.query(api.delivery.alignmentPreflight.getAlignmentReadiness, {});
		expect(rows[0]?.degradedMeasurement).toBe(true);
		expect(rows[0]?.degradedMeasurementReason).toContain('custom return path');
	});

	it('reports single_arm as a plain verdict with no remedy copy (D2)', async () => {
		stubTransportEnv();
		const t = convexTest(schema, modules);
		await seedDomain(t, { relay: null });
		await record(t, {
			verdict: 'single_arm',
			checks: ALIGNMENT_CHECK_IDS.map((id) => ({
				id,
				status: 'pass' as const,
				detail: 'Single arm — no reference transport is configured.',
				remedy: '',
			})),
			checkedAt: NOW,
			nextCheckDueAt: NOW + ALIGNMENT_RECHECK_INTERVAL_MS,
		});
		const rows = await t.query(api.delivery.alignmentPreflight.getAlignmentReadiness, {});
		expect(rows[0]?.verdict).toBe('single_arm');
		for (const check of rows[0]?.checks ?? []) {
			expect(check.status).toBe('pass');
			expect(check.remedy).toBe('');
		}
	});

	it('filters to one domain when asked', async () => {
		stubTransportEnv();
		const t = convexTest(schema, modules);
		await seedDomain(t, { relay: null });
		await seedDomain(t, { relay: null, domain: 'other.example' });
		await record(t, {
			verdict: 'aligned',
			checks: PASSING_CHECKS,
			checkedAt: NOW,
			nextCheckDueAt: NOW + ALIGNMENT_RECHECK_INTERVAL_MS,
		});
		await record(t, {
			verdict: 'blocked',
			checks: BLOCKING_CHECKS,
			checkedAt: NOW,
			nextCheckDueAt: NOW + ALIGNMENT_RECHECK_INTERVAL_MS,
			domain: 'other.example',
		});
		const rows = await t.query(api.delivery.alignmentPreflight.getAlignmentReadiness, {
			domain: 'other.example',
		});
		expect(rows.map((row) => row.domain)).toEqual(['other.example']);
	});
});

describe('every read is scoped to one organization', () => {
	it('never returns another organization’s alignment row', async () => {
		stubTransportEnv();
		const t = convexTest(schema, modules);
		await seedDomain(t, { relay: 'ses' });
		// A second tenant's row for the SAME domain name: dropping the org filter
		// on either read would surface it.
		await t.run(async (ctx) => {
			await ctx.db.insert('deliverabilityAlignmentStates', {
				organizationId: 'org-b',
				domain: DOMAIN,
				verdict: 'aligned',
				checks: PASSING_CHECKS,
				degradedMeasurement: false,
				checkedAt: NOW,
				nextCheckDueAt: NOW + ALIGNMENT_RECHECK_INTERVAL_MS,
				updatedAt: NOW,
			});
			await ctx.db.insert('deliverabilityAlignmentStates', {
				organizationId: 'org-b',
				domain: 'foreign.example',
				verdict: 'blocked',
				checks: BLOCKING_CHECKS,
				degradedMeasurement: false,
				checkedAt: NOW,
				nextCheckDueAt: NOW + ALIGNMENT_RECHECK_INTERVAL_MS,
				updatedAt: NOW,
			});
		});

		// org-a has no verdict of its own yet, so the gate must read `null` rather
		// than org-b's `aligned`.
		const state = await t.query(internal.delivery.alignmentPreflight.getAlignmentGateState, {
			domain: DOMAIN,
		});
		expect(state.state).toBeNull();
		expect(alignmentGate({ ...state, now: NOW }).reason).toBe('not_yet_checked');
		expect(await t.query(api.delivery.alignmentPreflight.getAlignmentReadiness, {})).toEqual([]);

		// And writing org-a's own row leaves org-b's untouched.
		await record(t, {
			verdict: 'blocked',
			checks: BLOCKING_CHECKS,
			checkedAt: NOW,
			nextCheckDueAt: NOW + ALIGNMENT_RECHECK_INTERVAL_MS,
		});
		const rows = await t.query(api.delivery.alignmentPreflight.getAlignmentReadiness, {});
		expect(rows).toHaveLength(1);
		expect(rows[0]?.verdict).toBe('blocked');
		const foreign = await t.run(async (ctx) =>
			ctx.db
				.query('deliverabilityAlignmentStates')
				.withIndex('by_org_domain', (q) => q.eq('organizationId', 'org-b').eq('domain', DOMAIN))
				.unique()
		);
		expect(foreign?.verdict).toBe('aligned');
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
