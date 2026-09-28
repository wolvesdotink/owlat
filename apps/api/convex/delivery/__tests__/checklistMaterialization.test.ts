import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../_generated/api';
import schema from '../../schema';
import {
	CENTER_MATERIALIZATION_ACTIVE_ALERT_LIMIT,
	CENTER_MATERIALIZATION_DOMAIN_LIMIT,
	completeRowsOrThrow,
} from '../checklist';
import { deliverabilityTargetKey } from '../checklistEvidence';
import { DEPLOYMENT_CHECK_IDS } from '../checklistTraits';
import { CURRENT_DELIVERABILITY_OBSERVED_VALUES_VERSION } from '../../lib/constants';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	const session = {
		userId: 'admin-1',
		role: 'owner',
		activeOrganizationId: 'org-center',
	};
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue(session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn().mockResolvedValue(session),
		requireOrgPermission: vi.fn().mockResolvedValue(session),
	};
});

const rootGlob = import.meta.glob('../../**/*.*s');
const deliveryGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, module]) => [
		path.replace(/^\.\.\//, '../../delivery/'),
		module,
	])
);
const modules = { ...rootGlob, ...deliveryGlob };

const ORGANIZATION_ID = 'org-center';

function domainRow(index: number) {
	const now = Date.now();
	return {
		domain: `domain-${index}.example`,
		status: 'verified' as const,
		dnsRecords: {},
		providerType: 'mta',
		createdAt: now,
		updatedAt: now,
	};
}

function warmingRow(ips: string[]) {
	return {
		phase: 'ramp',
		totalDailyCap: 50,
		totalSentToday: 0,
		ipCount: ips.length,
		ips: ips.map((ip) => ({
			ip,
			phase: 'ramp',
			currentDay: 1,
			dailyCap: 50,
			sentToday: 0,
			bounceRate: 0,
			deferralRate: 0,
			pool: 'campaign',
			active: true,
		})),
		syncedAt: Date.now(),
	};
}

describe('Deliverability Center complete materialization', () => {
	it('explicitly refuses an over-limit collection instead of returning a partial result', () => {
		expect(() =>
			completeRowsOrThrow(
				Array.from({ length: CENTER_MATERIALIZATION_DOMAIN_LIMIT + 1 }),
				CENTER_MATERIALIZATION_DOMAIN_LIMIT,
				'sending domains'
			)
		).toThrow('no partial readiness result was returned');
	});

	it('does not retain the former 50-alert silent truncation', () => {
		expect(() =>
			completeRowsOrThrow(
				Array.from({ length: 51 }),
				CENTER_MATERIALIZATION_ACTIVE_ALERT_LIMIT,
				'active regression alerts'
			)
		).not.toThrow();
	});

	it('loads relevant verification state even after more than the former global state cap', async () => {
		const t = convexTest(schema, modules);
		for (let batch = 0; batch < 15; batch += 1) {
			await t.run(async (ctx) => {
				for (let offset = 0; offset < 100; offset += 1) {
					const index = batch * 100 + offset;
					await ctx.db.insert('deliverabilityVerificationState', {
						organizationId: ORGANIZATION_ID,
						itemId: 'deployment.ptr',
						targetKey: `0:orphan:${index.toString().padStart(4, '0')}`,
						attemptId: `orphan-${index}`,
						generation: 1,
						retryIndex: 0,
						leaseToken: `lease-${index}`,
						leaseExpiresAt: 0,
						updatedAt: 0,
					});
				}
			});
		}

		const now = Date.now();
		await t.run(async (ctx) => {
			const targetKey = deliverabilityTargetKey(ORGANIZATION_ID);
			const evidenceId = await ctx.db.insert('deliverabilityEvidence', {
				organizationId: ORGANIZATION_ID,
				itemId: 'deployment.ptr',
				scopeKind: 'deployment',
				targetKey,
				attemptId: 'current-ptr',
				validator: 'test',
				status: 'pass',
				observedValues: [],
				diagnostic: 'PTR is current.',
				observedAt: now,
				createdAt: now,
			});
			await ctx.db.insert('deliverabilityVerificationState', {
				organizationId: ORGANIZATION_ID,
				itemId: 'deployment.ptr',
				targetKey,
				attemptId: 'current-ptr',
				generation: 1,
				retryIndex: 0,
				leaseToken: 'current-lease',
				leaseExpiresAt: 0,
				currentEvidenceId: evidenceId,
				updatedAt: now,
			});
		});

		const center = await t.query(api.delivery.checklist.getCenter, {});
		const ptr = center.groups
			.flatMap((group) => group.items)
			.find((item) => item.id === 'deployment.ptr');
		expect(ptr).toMatchObject({ status: 'pass', lastCheckedAt: now });
	}, 20_000);

	it('reads legacy and current observation versions but quarantines unknown versions', async () => {
		const t = convexTest(schema, modules);
		const targetKey = deliverabilityTargetKey(ORGANIZATION_ID);
		await t.run(async (ctx) => {
			for (const [index, item] of [
				{
					itemId: 'deployment.ptr' as const,
					observedValues: ['legacy-value'],
					observedValuesVersion: undefined,
				},
				{
					itemId: 'deployment.fcrdns' as const,
					observedValues: ['current-value'],
					observedValuesVersion: CURRENT_DELIVERABILITY_OBSERVED_VALUES_VERSION,
				},
				{
					itemId: 'deployment.port25' as const,
					observedValues: ['future-value'],
					observedValuesVersion: CURRENT_DELIVERABILITY_OBSERVED_VALUES_VERSION + 1,
				},
			].entries()) {
				const evidenceId = await ctx.db.insert('deliverabilityEvidence', {
					organizationId: ORGANIZATION_ID,
					itemId: item.itemId,
					scopeKind: 'deployment',
					targetKey,
					attemptId: `attempt-${index}`,
					validator: 'test',
					status: 'pass',
					observedValues: item.observedValues,
					...(item.observedValuesVersion === undefined
						? {}
						: { observedValuesVersion: item.observedValuesVersion }),
					diagnostic: 'verified',
					observedAt: index + 1,
					createdAt: index + 1,
				});
				await ctx.db.insert('deliverabilityVerificationState', {
					organizationId: ORGANIZATION_ID,
					itemId: item.itemId,
					targetKey,
					attemptId: `attempt-${index}`,
					generation: 1,
					retryIndex: 0,
					leaseToken: `lease-${index}`,
					leaseExpiresAt: 0,
					currentEvidenceId: evidenceId,
					updatedAt: index + 1,
				});
			}
		});

		const center = await t.query(api.delivery.checklist.getCenter, {});
		const items = center.groups.flatMap((group) => group.items);
		expect(items.find((item) => item.id === 'deployment.ptr')?.observed).toEqual(['legacy-value']);
		expect(items.find((item) => item.id === 'deployment.fcrdns')?.observed).toEqual([
			'current-value',
		]);
		expect(items.find((item) => item.id === 'deployment.port25')?.observed).toEqual([]);
	});

	it('leaves the IPv6 checks out of the Center while the MTA reports no IPv6 address', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('warmingState', warmingRow(['203.0.113.25']));
		});

		const center = await t.query(api.delivery.checklist.getCenter, {});
		const ids = center.groups.flatMap((group) => group.items).map((item) => item.id);
		expect(center.ipv6).toEqual({ enabled: false, addresses: [] });
		expect(center.groups.map((group) => group.key)).toEqual([
			'blocking',
			'reputation',
			'recommended',
		]);
		expect(ids.filter((id) => id.startsWith('deployment.ipv6_'))).toEqual([]);
		expect(center.nextItem?.id.startsWith('deployment.ipv6_')).toBe(false);
	});

	it('groups the IPv6 checks together once the MTA reports an IPv6 address', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('warmingState', warmingRow(['203.0.113.25', '2a01:4f8:c0c:1::25']));
		});

		const center = await t.query(api.delivery.checklist.getCenter, {});
		expect(center.ipv6).toEqual({ enabled: true, addresses: ['2a01:4f8:c0c:1::25'] });
		const ipv6Group = center.groups.find((group) => group.key === 'ipv6');
		expect(ipv6Group?.items.map((item) => item.id)).toEqual([
			'deployment.ipv6_address',
			'deployment.ipv6_source',
			'deployment.ipv6_ptr',
			'deployment.ipv6_aaaa',
			'deployment.ipv6_spf',
			'deployment.ipv6_pool',
		]);
		const elsewhere = center.groups
			.filter((group) => group.key !== 'ipv6')
			.flatMap((group) => group.items)
			.filter((item) => item.id.startsWith('deployment.ipv6_'));
		expect(elsewhere).toEqual([]);
	});

	describe('shared NAT egress', () => {
		async function centerWith(port25: string[], sourceIp: 'pass' | 'fail') {
			const t = convexTest(schema, modules);
			const targetKey = deliverabilityTargetKey(ORGANIZATION_ID);
			const now = Date.now();
			const evidence = DEPLOYMENT_CHECK_IDS.filter(
				(id) => !id.startsWith('deployment.ipv6_') && id !== 'deployment.tls'
			).map((itemId) => ({
				itemId,
				status:
					itemId === 'deployment.port25'
						? ('warn' as const)
						: itemId === 'deployment.source_ip'
							? sourceIp
							: ('pass' as const),
				observedValues: itemId === 'deployment.port25' ? port25 : [],
			}));
			await t.run(async (ctx) => {
				for (const [index, item] of evidence.entries()) {
					const evidenceId = await ctx.db.insert('deliverabilityEvidence', {
						organizationId: ORGANIZATION_ID,
						itemId: item.itemId,
						scopeKind: 'deployment',
						targetKey,
						attemptId: `nat-${index}`,
						validator: 'test',
						status: item.status,
						observedValues: item.observedValues,
						diagnostic: 'observed',
						observedAt: now,
						createdAt: now,
					});
					await ctx.db.insert('deliverabilityVerificationState', {
						organizationId: ORGANIZATION_ID,
						itemId: item.itemId,
						targetKey,
						attemptId: `nat-${index}`,
						generation: 1,
						retryIndex: 0,
						leaseToken: `nat-lease-${index}`,
						leaseExpiresAt: 0,
						currentEvidenceId: evidenceId,
						updatedAt: now,
					});
				}
			});
			const center = await t.query(api.delivery.checklist.getCenter, {});
			return {
				center,
				port25: center.groups
					.flatMap((group) => group.items)
					.find((item) => item.id === 'deployment.port25'),
			};
		}

		it('makes the per-IP source check the next item while port 25 was not probed', async () => {
			const { center, port25 } = await centerWith(
				['203.0.113.10=not-probed', '203.0.113.11=not-probed'],
				'fail'
			);
			expect(center.nextItem?.id).toBe('deployment.source_ip');
			expect(port25?.lockedReason).toBe('Verify deployment.source_ip first.');
			expect(port25?.nextStep).toContain('Send each address from its own IP');
			expect(port25?.nextStep).not.toContain('TCP/25 access');
			// The expanded row's steps must not repeat the wrong fix either.
			expect(port25?.instructions.steps.join(' ')).not.toContain('TCP/25 access');
			expect(port25?.instructions.steps.join(' ')).toContain('host networking');
		});

		it('keeps the port-25 next step for a probe that really ran', async () => {
			const { center, port25 } = await centerWith(['203.0.113.10=failed'], 'pass');
			expect(center.nextItem?.id).toBe('deployment.port25');
			expect(port25?.lockedReason).toBeUndefined();
			expect(port25?.nextStep).toContain('TCP/25 access');
			expect(port25?.instructions.steps.join(' ')).toContain('TCP/25 access');
		});
	});

	it('refuses more domains than can be safely materialized instead of grading a prefix', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			for (let index = 0; index <= CENTER_MATERIALIZATION_DOMAIN_LIMIT; index += 1) {
				await ctx.db.insert('domains', domainRow(index));
			}
		});

		await expect(t.query(api.delivery.checklist.getCenter, {})).rejects.toThrow(
			'no partial readiness result was returned'
		);
	});

	it('refuses duplicate relay identities beyond the one-per-domain contract', async () => {
		const t = convexTest(schema, modules);
		const domainId = await t.run(async (ctx) => {
			const domainId = await ctx.db.insert('domains', domainRow(1));
			for (let index = 0; index <= 100; index += 1) {
				await ctx.db.insert('sendingDomainSesIdentities', {
					domainId,
					dkimTokens: [`token-${index}`],
					verificationToken: `verification-${index}`,
					isProviderVerified: true,
					verifiedAt: Date.now(),
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
			}
			return domainId;
		});

		await expect(
			t.query(internal.delivery.checklist.getVerificationContext, {
				organizationId: ORGANIZATION_ID,
				domainId,
				itemId: 'deployment.relay',
			})
		).rejects.toThrow('no partial readiness result was returned');
	});
});
