/**
 * The wizard's ARM READ (P2-4), against real table writes.
 *
 * `delivery.alignmentPreflight.getAlignmentArms` is what step 3 of the transport
 * connection wizard resolves its two arms from. It replaced a client-side
 * derivation that could never produce arms on the real page, so every branch it
 * can return is covered here rather than left to be re-discovered in production:
 *
 *  - an explicitly named domain, normalized on the way in (hit), and one that
 *    does not exist (miss → null);
 *  - the NO-ARGUMENT call the page actually makes, which scans verified domains
 *    and must SKIP the ones with no own-MTA signing identity — a relay-only
 *    domain has no first arm to compare anything against — in favour of a later
 *    one that has;
 *  - the same scan's page bound, so the read cannot grow without one;
 *  - a standalone deployment, whose reference is `{ kind: 'none' }` (D2) and
 *    which the evaluator turns into a `single_arm` PASS rather than an error.
 *
 * Plus the PARITY assertion that justifies the shared `buildArms` extraction:
 * the arms this read returns are byte-identical to the ones the sweep's target
 * builder produces for the same domain, so the wizard's verdict and the
 * controller's gate can never be computed from two different pictures.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';

import { modules } from '../../__tests__/testModules';

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
const POOL_IP = '203.0.113.10';

/** The page bound `getAlignmentArms` applies to its no-argument scan. */
const ALIGNMENT_READINESS_LIMIT = 50;

function stubTransportEnv(): void {
	vi.stubEnv('MTA_IP_POOLS', POOL_IP);
	// The relay, when a fixture wants one, is expressed through providerRoutes —
	// the single-transport env must not be mistaken for a second arm.
	vi.stubEnv('EMAIL_PROVIDER', 'mta');
}

afterEach(() => {
	vi.unstubAllEnvs();
});

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
	options: { domain: string; ownIdentity?: boolean; sesIdentity?: boolean }
): Promise<void> {
	await t.run(async (ctx) => {
		const domainId = await ctx.db.insert('domains', {
			domain: options.domain,
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
		if (options.sesIdentity === true) {
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

function arms(t: TestConvex<typeof schema>, domain?: string) {
	return t.query(
		api.delivery.alignmentPreflight.getAlignmentArms,
		domain === undefined ? {} : { domain }
	);
}

describe('getAlignmentArms with an explicitly named domain', () => {
	it('returns both arms for a domain that has an own-MTA identity and a relay', async () => {
		stubTransportEnv();
		const t = convexTest(schema, modules);
		await seedDomain(t, { domain: 'acme.com', sesIdentity: true });
		await seedRelayRoute(t, 'ses');

		const result = await arms(t, 'acme.com');
		expect(result).not.toBeNull();
		expect(result?.domain).toBe('acme.com');
		expect(result?.ownArm).toEqual({
			label: 'own MTA',
			fromDomain: 'acme.com',
			dkimDomain: 'acme.com',
			dkimSelectors: ['owlat'],
			spfMechanisms: [`ip4:${POOL_IP}`],
		});
		expect(result?.reference.kind).toBe('arm');
		if (result?.reference.kind === 'arm') {
			expect(result.reference.arm.dkimSelectors).toEqual(['ses-token-1']);
			// The arms MUST be indistinguishable to the receiver apart from the
			// selector: same From domain, same d= (D11).
			expect(result.reference.arm.fromDomain).toBe(result.ownArm.fromDomain);
			expect(result.reference.arm.dkimDomain).toBe(result.ownArm.dkimDomain);
			expect(result.reference.arm.dkimSelectors).not.toEqual(result.ownArm.dkimSelectors);
		}
	});

	it('normalizes the argument, so a mixed-case trailing-dot spelling still hits', async () => {
		stubTransportEnv();
		const t = convexTest(schema, modules);
		await seedDomain(t, { domain: 'acme.com' });

		expect((await arms(t, 'Acme.com.'))?.domain).toBe('acme.com');
	});

	it('returns null for a domain this deployment has no row for', async () => {
		stubTransportEnv();
		const t = convexTest(schema, modules);
		await seedDomain(t, { domain: 'acme.com' });

		expect(await arms(t, 'nope.example')).toBeNull();
	});

	it('returns null for a relay-only domain with no own-MTA signing identity', async () => {
		stubTransportEnv();
		const t = convexTest(schema, modules);
		await seedDomain(t, { domain: 'relayonly.com', ownIdentity: false, sesIdentity: true });
		await seedRelayRoute(t, 'ses');

		// Not an error state: there is simply no first arm to compare against.
		expect(await arms(t, 'relayonly.com')).toBeNull();
	});
});

describe('getAlignmentArms with no argument — the call the page makes', () => {
	it('skips verified domains without an own-MTA identity in favour of one that has it', async () => {
		stubTransportEnv();
		const t = convexTest(schema, modules);
		await seedDomain(t, { domain: 'first-relay-only.com', ownIdentity: false });
		await seedDomain(t, { domain: 'second-relay-only.com', ownIdentity: false });
		await seedDomain(t, { domain: 'signs.com' });

		const result = await arms(t);
		expect(result?.domain).toBe('signs.com');
		expect(result?.ownArm.dkimSelectors).toEqual(['owlat']);
	});

	it('returns null when no verified domain has an own-MTA identity', async () => {
		stubTransportEnv();
		const t = convexTest(schema, modules);
		await seedDomain(t, { domain: 'relayonly.com', ownIdentity: false });

		expect(await arms(t)).toBeNull();
	});

	it('is bounded: a domain past the scan limit is not reached', async () => {
		stubTransportEnv();
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			for (let index = 0; index < ALIGNMENT_READINESS_LIMIT; index += 1) {
				await ctx.db.insert('domains', {
					domain: `filler-${index}.com`,
					status: 'verified',
					dnsRecords: {},
					createdAt: NOW,
					updatedAt: NOW,
				});
			}
		});
		await seedDomain(t, { domain: 'past-the-bound.com' });

		// Bounded reads are a design constraint, not an accident — the operator
		// names the domain explicitly instead, which still resolves.
		expect(await arms(t)).toBeNull();
		expect((await arms(t, 'past-the-bound.com'))?.domain).toBe('past-the-bound.com');
	});

	it('ignores domains that are not verified', async () => {
		stubTransportEnv();
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const domainId = await ctx.db.insert('domains', {
				domain: 'pending.com',
				status: 'pending',
				dnsRecords: {},
				createdAt: NOW,
				updatedAt: NOW,
			});
			await ctx.db.insert('sendingDomainMtaIdentities', {
				domainId,
				dkimSelector: 'owlat',
				createdAt: NOW,
				updatedAt: NOW,
			});
		});

		expect(await arms(t)).toBeNull();
	});
});

describe('getAlignmentArms on a standalone deployment (D2)', () => {
	it('answers with a reference of kind none rather than an error', async () => {
		stubTransportEnv();
		const t = convexTest(schema, modules);
		await seedDomain(t, { domain: 'solo.com' });

		const result = await arms(t);
		expect(result?.domain).toBe('solo.com');
		expect(result?.reference).toEqual({ kind: 'none' });
	});

	it('reports a relay it cannot describe as unknown, never as none', async () => {
		stubTransportEnv();
		const t = convexTest(schema, modules);
		await seedDomain(t, { domain: 'acme.com' });
		await seedRelayRoute(t, 'resend');

		const result = await arms(t);
		expect(result?.reference.kind).toBe('unknown');
	});

	/**
	 * THE MIGRATION'S ARM READ (P1.3, plan D8) — pinned as it stands, not as it
	 * will stand. A SOLE Mandrill relay is a describable configuration to
	 * `relayConfiguration` (exactly one second arm; see
	 * `relayConfiguration.test.ts`) but not yet to the ALIGNMENT read, which can
	 * only build a reference arm from a verified signing identity and today has
	 * one source for that: the SES identity table. The plan's P3.1 registers
	 * Mandrill's domain provider and its identity row; until then the honest
	 * answer is `unknown`, which HOLDS the gate rather than opening it — the
	 * conservative direction, and the reason this is worth pinning rather than
	 * leaving to be rediscovered as a regression later.
	 */
	it('holds on a sole Mandrill relay it has no verified signing identity for', async () => {
		stubTransportEnv();
		const t = convexTest(schema, modules);
		await seedDomain(t, { domain: 'acme.com' });
		await seedRelayRoute(t, 'mandrill');

		const result = await arms(t);
		expect(result?.reference.kind).toBe('unknown');
		if (result?.reference.kind === 'unknown') {
			// The SINGLE-relay wording: this deployment has one second arm, it just
			// cannot be described for this domain yet.
			expect(result.reference.detail).toContain('A relay is configured (mandrill)');
			expect(result.reference.detail).not.toContain('More than one relay');
		}
	});

	it('names the multi-relay case distinctly — D8’s "keep Mandrill the only relay"', async () => {
		// The configuration the plan warns migrating operators away from: two
		// reference relays, so there is no single second arm for the measurement to
		// be against, and alignment confidence degrades.
		stubTransportEnv();
		const t = convexTest(schema, modules);
		await seedDomain(t, { domain: 'acme.com', sesIdentity: true });
		await t.run(async (ctx) => {
			await ctx.db.insert('providerRoutes', {
				messageType: 'campaign',
				strategy: 'adaptive_mix',
				providers: [
					{ providerType: 'mta', isEnabled: true },
					{ providerType: 'ses', isEnabled: true },
					{ providerType: 'mandrill', isEnabled: true },
				],
				createdAt: NOW,
				updatedAt: NOW,
			});
		});

		const result = await arms(t);
		expect(result?.reference.kind).toBe('unknown');
		if (result?.reference.kind === 'unknown') {
			expect(result.reference.detail).toContain('More than one relay is enabled');
			expect(result.reference.detail).toContain('mandrill');
			expect(result.reference.detail).toContain('ses');
		}
	});
});

describe('the wizard read and the sweep build the SAME arms', () => {
	it('matches the target the sweep produces for the same domain', async () => {
		stubTransportEnv();
		const t = convexTest(schema, modules);
		await seedDomain(t, { domain: 'acme.com', sesIdentity: true });
		await seedRelayRoute(t, 'ses');

		const wizard = await arms(t, 'acme.com');
		const swept = await t.query(internal.delivery.alignmentPreflight.listDueAlignmentTargets, {
			now: NOW,
			paginationOpts: { cursor: null, numItems: 5 },
		});
		const target = swept.targets.find((entry) => entry.domain === 'acme.com');
		expect(target).toBeDefined();
		expect(wizard).toEqual(target);
	});
});
