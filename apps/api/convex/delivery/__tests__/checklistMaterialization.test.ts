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
