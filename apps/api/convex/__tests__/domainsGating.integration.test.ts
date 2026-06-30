/**
 * Auth gates + pure DNS-matching logic on the `domains/` module family.
 *
 * Complements the existing `domains.integration.test.ts` (public CRUD queries)
 * and `sendingDomainLifecycle.integration.test.ts` (the reducer) by covering
 * the surfaces those don't:
 *
 *   - `dnsVerification.verifyDomain` (authedAction):
 *       · member-floor rejection (assertOrgMember throws)
 *       · not-found domain → not_found
 *       · 'registering' status → invalid_state (the pre-DNS guard)
 *       · happy path with `node:dns/promises` mocked — exercises the pure
 *         TXT/CNAME/MX record matching + normalization (trailing-dot,
 *         case-insensitive CNAME, MX priority, SPF/DMARC partial-match) and
 *         the lands-`verified`/`failed`/`pending` reducer wiring, with NO real
 *         DNS call and an `mta` provider (no SES `runProviderCheck`).
 *   - `providers.registerAction.run` / `deleteDomainAction` (internalAction):
 *       · `run` with a missing domain → early-return no-op (no provider call)
 *       · `deleteDomainAction` runs through the provider seam (mocked) and is
 *         best-effort (swallows provider errors)
 *   - `trackingDomains`:
 *       · `addTrackingDomain` / `verifyTrackingDomain` / `removeTrackingDomain`
 *         admin gate (non-admin rejected)
 *       · duplicate / not-found handling
 *       · `markVerifiedInternal` patches isVerified/verifiedAt (and no-ops on a
 *         missing row)
 *       · `getActiveTrackingDomain` returns the first verified row
 *
 * The session mock is mutable (vi.hoisted) so individual cases can flip the
 * member/admin floor to the rejecting path.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import { createTestDomain } from './factories';
import type { Id } from '../_generated/dataModel';

// ─── Mutable session floor ──────────────────────────────────────────────────
//
// `member: false` makes the org-member floor (requireOrgMember, used by both
// authedAction's assertOrgMember query and authedMutation) throw. `admin: false`
// makes requireAdminContext throw while still passing the member floor.
const sessionMock = vi.hoisted(() => ({ member: true, admin: true }));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockImplementation(async () => {
			if (!sessionMock.member) throw new Error('forbidden: not an org member');
			return { userId: 'test-user', role: 'owner' };
		}),
		isActiveOrgMember: vi.fn().mockImplementation(async () => sessionMock.member),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockImplementation(async () => {
			if (!sessionMock.member) throw new Error('forbidden: not an org member');
			return { userId: 'test-user', role: 'owner' };
		}),
		requireOrgPermission: vi.fn().mockImplementation(async () => {
			if (!sessionMock.member) throw new Error('forbidden: not an org member');
			return { userId: 'test-user', role: 'owner' };
		}),
		requireAdminContext: vi.fn().mockImplementation(async () => {
			if (!sessionMock.member) throw new Error('forbidden: not an org member');
			if (!sessionMock.admin) throw new Error('forbidden: admins only');
			return { userId: 'test-user', role: 'owner' };
		}),
		requireAuthenticatedIdentity: vi
			.fn()
			.mockResolvedValue({ subject: 'test-user', issuer: 'test', tokenIdentifier: 'test|test-user' }),
	};
});

// ─── DNS-over-Node mock (for dnsVerification.verifyDomain) ──────────────────
//
// `dnsVerification.ts` is a `'use node'` module that imports
// `node:dns/promises`. Mock it so the verifier exercises its pure matching
// logic against fixtures instead of hitting the network. Default resolvers
// reject ENOTFOUND; individual cases override per record type.
const dnsMock = vi.hoisted(() => ({
	resolveTxt: vi.fn(),
	resolveCname: vi.fn(),
	resolveMx: vi.fn(),
}));

vi.mock('node:dns/promises', () => ({
	default: {
		resolveTxt: (...args: unknown[]) => dnsMock.resolveTxt(...args),
		resolveCname: (...args: unknown[]) => dnsMock.resolveCname(...args),
		resolveMx: (...args: unknown[]) => dnsMock.resolveMx(...args),
	},
	resolveTxt: (...args: unknown[]) => dnsMock.resolveTxt(...args),
	resolveCname: (...args: unknown[]) => dnsMock.resolveCname(...args),
	resolveMx: (...args: unknown[]) => dnsMock.resolveMx(...args),
}));

// ─── Provider-manager seam mocks (for registerAction) ──────────────────────
//
// `deleteDomainAction` / `run` resolve the provider adapter, which calls the
// identity-manager factories. Stub them so the actions run through the seam
// without AWS/MTA credentials.
const mtaManager = vi.hoisted(() => ({
	deleteDomain: vi.fn().mockResolvedValue(undefined),
	registerDomain: vi.fn(),
}));
vi.mock('../lib/emailProviders/mtaIdentity', () => ({
	createMtaIdentityManager: () => mtaManager,
}));

const modules = import.meta.glob('../**/*.*s');
const verifyModules = Object.fromEntries(
	Object.entries(modules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('agentSecurity') &&
			!path.includes('agentContext') &&
			!path.includes('agentClassifier') &&
			!path.includes('agentDrafter') &&
			!path.includes('agentRouter') &&
			!path.includes('agent/walker') &&
			!path.includes('agent/steps/index') &&
			!path.includes('agent/steps/shared') &&
			!path.includes('agent/steps/classify') &&
			!path.includes('agent/steps/draft') &&
			!path.includes('knowledgeExtraction') &&
			!path.includes('semanticFileProcessing') &&
			!path.includes('visualizationAgent') &&
			!path.includes('llmProvider'),
	),
);

beforeEach(() => {
	sessionMock.member = true;
	sessionMock.admin = true;
	dnsMock.resolveTxt.mockReset();
	dnsMock.resolveCname.mockReset();
	dnsMock.resolveMx.mockReset();
	mtaManager.deleteDomain.mockReset();
	mtaManager.deleteDomain.mockResolvedValue(undefined);
	// Default: every lookup fails as ENOTFOUND unless a case overrides it.
	const enotfound = () => Promise.reject(new Error('queryTxt ENOTFOUND'));
	dnsMock.resolveTxt.mockImplementation(enotfound);
	dnsMock.resolveCname.mockImplementation(enotfound);
	dnsMock.resolveMx.mockImplementation(enotfound);
});

// A minimal MTA-provider dnsRecords fixture: DKIM (TXT) + DMARC (TXT). MTA has
// no `runProviderCheck`, so verification is purely DNS-driven (treated as
// providerCheck = { verified: true }).
function mtaDnsRecords() {
	return {
		dkim: [{ type: 'TXT' as const, host: 's1._domainkey', value: 'v=DKIM1; k=rsa; p=ABC' }],
		dmarc: { type: 'TXT' as const, host: '_dmarc', value: 'v=DMARC1; p=none' },
	};
}

// ============================================================================
// dnsVerification.verifyDomain — auth + input gates
// ============================================================================

describe('dnsVerification.verifyDomain — gates', () => {
	it('rejects a non-member (authedAction org-member floor)', async () => {
		const t = convexTest(schema, verifyModules);
		let domainId: Id<'domains'>;
		await t.run(async (ctx) => {
			domainId = await ctx.db.insert('domains', createTestDomain({ status: 'pending', providerType: 'mta' }));
		});

		sessionMock.member = false;

		await expect(
			t.action(api.domains.dnsVerification.verifyDomain, { domainId: domainId! }),
		).rejects.toThrow(/forbidden|member/i);
	});

	it('throws not_found for a missing domain (after passing the floor)', async () => {
		const t = convexTest(schema, verifyModules);
		let domainId: Id<'domains'>;
		await t.run(async (ctx) => {
			domainId = await ctx.db.insert('domains', createTestDomain());
			await ctx.db.delete(domainId);
		});

		await expect(
			t.action(api.domains.dnsVerification.verifyDomain, { domainId: domainId! }),
		).rejects.toThrow(/Domain not found/);

		// No DNS lookup should have happened — the guard runs before runDnsLookups.
		expect(dnsMock.resolveTxt).not.toHaveBeenCalled();
	});

	it("refuses while the domain is still 'registering' (invalid_state, pre-DNS)", async () => {
		const t = convexTest(schema, verifyModules);
		let domainId: Id<'domains'>;
		await t.run(async (ctx) => {
			domainId = await ctx.db.insert(
				'domains',
				createTestDomain({ status: 'registering', providerType: 'mta' }),
			);
		});

		await expect(
			t.action(api.domains.dnsVerification.verifyDomain, { domainId: domainId! }),
		).rejects.toThrow(/still being registered/i);

		expect(dnsMock.resolveTxt).not.toHaveBeenCalled();
	});
});

// ============================================================================
// dnsVerification.verifyDomain — pure DNS matching via mocked node:dns
// ============================================================================

describe('dnsVerification.verifyDomain — DNS matching (mocked resolvers)', () => {
	it('lands verified when DKIM + DMARC TXT records match exactly', async () => {
		const t = convexTest(schema, verifyModules);
		let domainId: Id<'domains'>;
		await t.run(async (ctx) => {
			domainId = await ctx.db.insert(
				'domains',
				createTestDomain({
					domain: 'verify-ok.com',
					status: 'pending',
					providerType: 'mta',
					dnsRecords: mtaDnsRecords(),
				}),
			);
		});

		// resolveTxt returns string[][] (each record is an array of chunks).
		dnsMock.resolveTxt.mockImplementation(async (hostname: string) => {
			if (hostname === 's1._domainkey.verify-ok.com') return [['v=DKIM1; k=rsa; p=ABC']];
			if (hostname === '_dmarc.verify-ok.com') return [['v=DMARC1; p=none']];
			throw new Error('queryTxt ENOTFOUND');
		});

		const result = await t.action(api.domains.dnsVerification.verifyDomain, {
			domainId: domainId!,
		});

		expect(result.success).toBe(true);
		expect(result.allVerified).toBe(true);
		expect(result.results.dkim?.[0]?.verified).toBe(true);
		expect(result.results.dmarc?.verified).toBe(true);

		await t.run(async (ctx) => {
			const domain = await ctx.db.get(domainId!);
			expect(domain!.status).toBe('verified');
			expect(domain!.verifiedAt).toBeTypeOf('number');
		});
	});

	it('matches a whitespace-normalised DKIM record + multi-mechanism SPF (tag/mechanism-aware)', async () => {
		// PR-67: verification is tag/mechanism-aware (RFC 6376 §3.6.1, RFC 7208
		// §3.2), NOT a raw substring/exact compare. A registrar that strips the
		// spaces around the DKIM tag separators, or a domain that publishes an
		// SPF record carrying an extra include: alongside ours, must still verify.
		const t = convexTest(schema, verifyModules);
		let domainId: Id<'domains'>;
		await t.run(async (ctx) => {
			domainId = await ctx.db.insert(
				'domains',
				createTestDomain({
					domain: 'verify-norm.com',
					status: 'pending',
					providerType: 'mta',
					dnsRecords: {
						...mtaDnsRecords(),
						spf: { type: 'TXT' as const, host: '@', value: 'v=spf1 include:owlat.mx ~all' },
					},
				}),
			);
		});

		dnsMock.resolveTxt.mockImplementation(async (hostname: string) => {
			// DKIM published with NO spaces around the ';' separators.
			if (hostname === 's1._domainkey.verify-norm.com') return [['v=DKIM1;k=rsa;p=ABC']];
			if (hostname === '_dmarc.verify-norm.com') return [['v=DMARC1; p=none']];
			// SPF published with an extra include: mechanism the domain also sends through.
			if (hostname === 'verify-norm.com')
				return [['v=spf1 include:_spf.google.com include:owlat.mx ~all']];
			throw new Error('queryTxt ENOTFOUND');
		});

		const result = await t.action(api.domains.dnsVerification.verifyDomain, {
			domainId: domainId!,
		});

		expect(result.allVerified).toBe(true);
		expect(result.results.dkim?.[0]?.verified).toBe(true);
		expect(result.results.spf?.verified).toBe(true);
	});

	it('does NOT verify a DKIM value buried in arbitrary surrounding text', async () => {
		// Regression guard for PR-67: the old matcher used includes(), so a value
		// embedded in junk ('prefix … suffix') falsely passed. The tag-aware
		// matcher rejects it because the segments don't parse to the expected tags.
		const t = convexTest(schema, verifyModules);
		let domainId: Id<'domains'>;
		await t.run(async (ctx) => {
			domainId = await ctx.db.insert(
				'domains',
				createTestDomain({
					domain: 'verify-sub.com',
					status: 'pending',
					providerType: 'mta',
					dnsRecords: mtaDnsRecords(),
				}),
			);
		});

		dnsMock.resolveTxt.mockImplementation(async (hostname: string) => {
			if (hostname === 's1._domainkey.verify-sub.com')
				return [['prefix v=DKIM1; k=rsa; p=ABC suffix']];
			if (hostname === '_dmarc.verify-sub.com') return [['v=DMARC1; p=none']];
			throw new Error('queryTxt ENOTFOUND');
		});

		const result = await t.action(api.domains.dnsVerification.verifyDomain, {
			domainId: domainId!,
		});

		expect(result.allVerified).toBe(false);
		expect(result.results.dkim?.[0]?.verified).toBe(false);
	});

	it('lands failed when a DKIM record is present but the value mismatches', async () => {
		const t = convexTest(schema, verifyModules);
		let domainId: Id<'domains'>;
		await t.run(async (ctx) => {
			domainId = await ctx.db.insert(
				'domains',
				createTestDomain({
					domain: 'verify-bad.com',
					status: 'pending',
					providerType: 'mta',
					dnsRecords: mtaDnsRecords(),
				}),
			);
		});

		dnsMock.resolveTxt.mockImplementation(async (hostname: string) => {
			if (hostname === 's1._domainkey.verify-bad.com') return [['v=DKIM1; k=rsa; p=WRONG']];
			if (hostname === '_dmarc.verify-bad.com') return [['v=DMARC1; p=none']];
			throw new Error('queryTxt ENOTFOUND');
		});

		const result = await t.action(api.domains.dnsVerification.verifyDomain, {
			domainId: domainId!,
		});

		expect(result.allVerified).toBe(false);
		expect(result.results.dkim?.[0]?.verified).toBe(false);

		await t.run(async (ctx) => {
			const domain = await ctx.db.get(domainId!);
			expect(domain!.status).toBe('failed');
		});
	});

	it('a missing required record (ENODATA) reports verified:false → lands failed', async () => {
		const t = convexTest(schema, verifyModules);
		let domainId: Id<'domains'>;
		await t.run(async (ctx) => {
			domainId = await ctx.db.insert(
				'domains',
				createTestDomain({
					domain: 'verify-missing.com',
					status: 'pending',
					providerType: 'mta',
					dnsRecords: { dmarc: { type: 'TXT' as const, host: '_dmarc', value: 'v=DMARC1; p=none' } },
				}),
			);
		});

		// DMARC lookup yields ENODATA — classifyDnsError maps it to a
		// `verified:false` "not found" result (no foundValue, no hard error).
		dnsMock.resolveTxt.mockImplementation(async () => {
			throw new Error('queryTxt ENODATA');
		});

		const result = await t.action(api.domains.dnsVerification.verifyDomain, {
			domainId: domainId!,
		});

		expect(result.allVerified).toBe(false);
		expect(result.results.dmarc?.verified).toBe(false);
		expect(result.results.dmarc?.error).toMatch(/No DNS record found/);

		await t.run(async (ctx) => {
			const domain = await ctx.db.get(domainId!);
			// recordVerification's reducer treats any `verified === false` record as
			// `dnsAnyFailed`, so a not-yet-published record lands `failed` (not
			// `pending`). The `pending` branch only triggers when a record is
			// entirely absent from the configured DNS set — not when its lookup
			// returns verified:false.
			expect(domain!.status).toBe('failed');
		});
	});

	it('CNAME match is case-insensitive and ignores a trailing dot', async () => {
		const t = convexTest(schema, verifyModules);
		let domainId: Id<'domains'>;
		await t.run(async (ctx) => {
			domainId = await ctx.db.insert(
				'domains',
				createTestDomain({
					domain: 'verify-cname.com',
					status: 'pending',
					providerType: 'mta',
					dnsRecords: {
						dkim: [
							{ type: 'CNAME' as const, host: 'tok._domainkey', value: 'tok.dkim.amazonses.com' },
						],
						dmarc: { type: 'TXT' as const, host: '_dmarc', value: 'v=DMARC1; p=none' },
					},
				}),
			);
		});

		// Published with different case + trailing dot — normalization must match.
		dnsMock.resolveCname.mockImplementation(async (hostname: string) => {
			if (hostname === 'tok._domainkey.verify-cname.com') return ['TOK.DKIM.AmazonSES.com.'];
			throw new Error('queryCname ENOTFOUND');
		});
		dnsMock.resolveTxt.mockImplementation(async (hostname: string) => {
			if (hostname === '_dmarc.verify-cname.com') return [['v=DMARC1; p=none']];
			throw new Error('queryTxt ENOTFOUND');
		});

		const result = await t.action(api.domains.dnsVerification.verifyDomain, {
			domainId: domainId!,
		});

		expect(result.results.dkim?.[0]?.verified).toBe(true);
		expect(result.allVerified).toBe(true);
	});

	it('MX match honors host + priority and a trailing dot on the exchange', async () => {
		const t = convexTest(schema, verifyModules);
		let domainId: Id<'domains'>;
		await t.run(async (ctx) => {
			domainId = await ctx.db.insert(
				'domains',
				createTestDomain({
					domain: 'verify-mx.com',
					status: 'pending',
					providerType: 'mta',
					dnsRecords: {
						dkim: [{ type: 'TXT' as const, host: 's1._domainkey', value: 'v=DKIM1; p=ABC' }],
						dmarc: { type: 'TXT' as const, host: '_dmarc', value: 'v=DMARC1; p=none' },
						mailFrom: [
							{
								type: 'MX' as const,
								host: 'mail',
								value: 'feedback-smtp.us-east-1.amazonses.com',
								priority: 10,
							},
						],
					},
				}),
			);
		});

		dnsMock.resolveTxt.mockImplementation(async (hostname: string) => {
			if (hostname === 's1._domainkey.verify-mx.com') return [['v=DKIM1; p=ABC']];
			if (hostname === '_dmarc.verify-mx.com') return [['v=DMARC1; p=none']];
			throw new Error('queryTxt ENOTFOUND');
		});
		dnsMock.resolveMx.mockImplementation(async (hostname: string) => {
			if (hostname === 'mail.verify-mx.com')
				return [{ priority: 10, exchange: 'feedback-smtp.us-east-1.amazonses.com.' }];
			throw new Error('queryMx ENOTFOUND');
		});

		const result = await t.action(api.domains.dnsVerification.verifyDomain, {
			domainId: domainId!,
		});

		expect(result.results.mailFrom?.[0]?.verified).toBe(true);
		expect(result.allVerified).toBe(true);
	});

	it('MX with a non-matching priority is not verified', async () => {
		const t = convexTest(schema, verifyModules);
		let domainId: Id<'domains'>;
		await t.run(async (ctx) => {
			domainId = await ctx.db.insert(
				'domains',
				createTestDomain({
					domain: 'verify-mxprio.com',
					status: 'pending',
					providerType: 'mta',
					dnsRecords: {
						dkim: [{ type: 'TXT' as const, host: 's1._domainkey', value: 'v=DKIM1; p=ABC' }],
						dmarc: { type: 'TXT' as const, host: '_dmarc', value: 'v=DMARC1; p=none' },
						mailFrom: [
							{
								type: 'MX' as const,
								host: 'mail',
								value: 'feedback-smtp.us-east-1.amazonses.com',
								priority: 10,
							},
						],
					},
				}),
			);
		});

		dnsMock.resolveTxt.mockImplementation(async (hostname: string) => {
			if (hostname === 's1._domainkey.verify-mxprio.com') return [['v=DKIM1; p=ABC']];
			if (hostname === '_dmarc.verify-mxprio.com') return [['v=DMARC1; p=none']];
			throw new Error('queryTxt ENOTFOUND');
		});
		// Right exchange, wrong priority (20 vs expected 10).
		dnsMock.resolveMx.mockImplementation(async (hostname: string) => {
			if (hostname === 'mail.verify-mxprio.com')
				return [{ priority: 20, exchange: 'feedback-smtp.us-east-1.amazonses.com' }];
			throw new Error('queryMx ENOTFOUND');
		});

		const result = await t.action(api.domains.dnsVerification.verifyDomain, {
			domainId: domainId!,
		});

		expect(result.results.mailFrom?.[0]?.verified).toBe(false);
		expect(result.allVerified).toBe(false);
	});
});

// ============================================================================
// providers.registerAction — internalAction behavior up to the provider seam
// ============================================================================

describe('providers.registerAction.run', () => {
	it('no-ops (early return) when the domain row is missing', async () => {
		const t = convexTest(schema, verifyModules);
		let domainId: Id<'domains'>;
		await t.run(async (ctx) => {
			domainId = await ctx.db.insert('domains', createTestDomain({ providerType: 'mta' }));
			await ctx.db.delete(domainId);
		});

		// Resolves without throwing; no provider register call attempted.
		await expect(
			t.action(internal.domains.providers.registerAction.run, {
				providerType: 'mta',
				domainId: domainId!,
			}),
		).resolves.toBeNull();
		expect(mtaManager.registerDomain).not.toHaveBeenCalled();
	});
});

describe('providers.registerAction.deleteDomainAction', () => {
	it('runs through the provider seam and resolves on success', async () => {
		const t = convexTest(schema, verifyModules);

		await expect(
			t.action(internal.domains.providers.registerAction.deleteDomainAction, {
				providerType: 'mta',
				domain: 'gone.example.com',
			}),
		).resolves.toBeNull();
		expect(mtaManager.deleteDomain).toHaveBeenCalledWith('gone.example.com');
	});

	it('is best-effort: swallows a provider error and still resolves', async () => {
		const t = convexTest(schema, verifyModules);
		mtaManager.deleteDomain.mockRejectedValueOnce(new Error('provider exploded'));

		await expect(
			t.action(internal.domains.providers.registerAction.deleteDomainAction, {
				providerType: 'mta',
				domain: 'boom.example.com',
			}),
		).resolves.toBeNull();
	});
});

// ============================================================================
// trackingDomains — admin gate + internal mutation
// ============================================================================

describe('trackingDomains.addTrackingDomain', () => {
	it('inserts an unverified row whose CNAME target is THIS deployment\'s own tracking host (admin)', async () => {
		const t = convexTest(schema, verifyModules);

		// The CNAME target must point at the deployment that actually serves the
		// /t/o and /t/c handlers (its own Convex site, CONVEX_SITE_URL) — NOT the
		// old SaaS host track.owlat.com, which a self-hoster doesn't run.
		const prev = process.env['CONVEX_SITE_URL'];
		process.env['CONVEX_SITE_URL'] = 'https://my-deployment.convex.site';
		try {
			const id = await t.mutation(api.domains.trackingDomains.addTrackingDomain, {
				domain: 'Track.Example.COM',
			});

			await t.run(async (ctx) => {
				const td = await ctx.db.get(id);
				expect(td).toBeDefined();
				expect(td!.domain).toBe('track.example.com'); // lowercased
				expect(td!.isVerified).toBe(false);
				expect(td!.cnameTarget).toBe('my-deployment.convex.site');
				expect(td!.cnameTarget).not.toBe('track.owlat.com');
				expect(td!.verifiedAt).toBeUndefined();
			});
		} finally {
			if (prev === undefined) delete process.env['CONVEX_SITE_URL'];
			else process.env['CONVEX_SITE_URL'] = prev;
		}
	});

	it('rejects a non-admin', async () => {
		const t = convexTest(schema, verifyModules);
		sessionMock.admin = false;

		await expect(
			t.mutation(api.domains.trackingDomains.addTrackingDomain, { domain: 'nope.example.com' }),
		).rejects.toThrow(/admins only/i);
	});

	it('rejects a duplicate domain', async () => {
		const t = convexTest(schema, verifyModules);

		await t.mutation(api.domains.trackingDomains.addTrackingDomain, { domain: 'dup.example.com' });
		await expect(
			t.mutation(api.domains.trackingDomains.addTrackingDomain, { domain: 'dup.example.com' }),
		).rejects.toThrow(/already registered/i);
	});
});

describe('trackingDomains.verifyTrackingDomain', () => {
	it('rejects a non-admin', async () => {
		const t = convexTest(schema, verifyModules);
		let tdId: Id<'trackingDomains'>;
		await t.run(async (ctx) => {
			tdId = await ctx.db.insert('trackingDomains', {
				domain: 'verify.example.com',
				cnameTarget: 'track.owlat.com',
				isVerified: false,
				createdAt: Date.now(),
			});
		});

		sessionMock.admin = false;

		await expect(
			t.mutation(api.domains.trackingDomains.verifyTrackingDomain, { trackingDomainId: tdId! }),
		).rejects.toThrow(/admins only/i);
	});

	it('throws not_found for a missing tracking domain', async () => {
		const t = convexTest(schema, verifyModules);
		let tdId: Id<'trackingDomains'>;
		await t.run(async (ctx) => {
			tdId = await ctx.db.insert('trackingDomains', {
				domain: 'tmp.example.com',
				cnameTarget: 'track.owlat.com',
				isVerified: false,
				createdAt: Date.now(),
			});
			await ctx.db.delete(tdId);
		});

		await expect(
			t.mutation(api.domains.trackingDomains.verifyTrackingDomain, { trackingDomainId: tdId! }),
		).rejects.toThrow(/Tracking domain not found/);
	});
});

describe('trackingDomains.removeTrackingDomain', () => {
	it('deletes the row (admin)', async () => {
		const t = convexTest(schema, verifyModules);
		let tdId: Id<'trackingDomains'>;
		await t.run(async (ctx) => {
			tdId = await ctx.db.insert('trackingDomains', {
				domain: 'remove.example.com',
				cnameTarget: 'track.owlat.com',
				isVerified: true,
				verifiedAt: Date.now(),
				createdAt: Date.now(),
			});
		});

		await t.mutation(api.domains.trackingDomains.removeTrackingDomain, {
			trackingDomainId: tdId!,
		});

		await t.run(async (ctx) => {
			expect(await ctx.db.get(tdId!)).toBeNull();
		});
	});

	it('rejects a non-admin', async () => {
		const t = convexTest(schema, verifyModules);
		let tdId: Id<'trackingDomains'>;
		await t.run(async (ctx) => {
			tdId = await ctx.db.insert('trackingDomains', {
				domain: 'noremove.example.com',
				cnameTarget: 'track.owlat.com',
				isVerified: false,
				createdAt: Date.now(),
			});
		});

		sessionMock.admin = false;

		await expect(
			t.mutation(api.domains.trackingDomains.removeTrackingDomain, { trackingDomainId: tdId! }),
		).rejects.toThrow(/admins only/i);
	});

	it('throws not_found for a missing tracking domain', async () => {
		const t = convexTest(schema, verifyModules);
		let tdId: Id<'trackingDomains'>;
		await t.run(async (ctx) => {
			tdId = await ctx.db.insert('trackingDomains', {
				domain: 'ghost.example.com',
				cnameTarget: 'track.owlat.com',
				isVerified: false,
				createdAt: Date.now(),
			});
			await ctx.db.delete(tdId);
		});

		await expect(
			t.mutation(api.domains.trackingDomains.removeTrackingDomain, { trackingDomainId: tdId! }),
		).rejects.toThrow(/Tracking domain not found/);
	});
});

describe('trackingDomains.markVerifiedInternal', () => {
	it('patches isVerified + verifiedAt on an existing row', async () => {
		const t = convexTest(schema, verifyModules);
		let tdId: Id<'trackingDomains'>;
		await t.run(async (ctx) => {
			tdId = await ctx.db.insert('trackingDomains', {
				domain: 'mark.example.com',
				cnameTarget: 'track.owlat.com',
				isVerified: false,
				createdAt: Date.now(),
			});
		});

		await t.mutation(internal.domains.trackingDomains.markVerifiedInternal, {
			trackingDomainId: tdId!,
		});

		await t.run(async (ctx) => {
			const td = await ctx.db.get(tdId!);
			expect(td!.isVerified).toBe(true);
			expect(td!.verifiedAt).toBeTypeOf('number');
		});
	});

	it('no-ops (does not throw) when the row is missing', async () => {
		const t = convexTest(schema, verifyModules);
		let tdId: Id<'trackingDomains'>;
		await t.run(async (ctx) => {
			tdId = await ctx.db.insert('trackingDomains', {
				domain: 'missing.example.com',
				cnameTarget: 'track.owlat.com',
				isVerified: false,
				createdAt: Date.now(),
			});
			await ctx.db.delete(tdId);
		});

		await expect(
			t.mutation(internal.domains.trackingDomains.markVerifiedInternal, {
				trackingDomainId: tdId!,
			}),
		).resolves.toBeNull();
	});
});

describe('trackingDomains.getActiveTrackingDomain', () => {
	it('returns the first verified tracking domain', async () => {
		const t = convexTest(schema, verifyModules);
		await t.run(async (ctx) => {
			await ctx.db.insert('trackingDomains', {
				domain: 'unverified.example.com',
				cnameTarget: 'track.owlat.com',
				isVerified: false,
				createdAt: Date.now(),
			});
			await ctx.db.insert('trackingDomains', {
				domain: 'active.example.com',
				cnameTarget: 'track.owlat.com',
				isVerified: true,
				verifiedAt: Date.now(),
				createdAt: Date.now(),
			});
		});

		const active = await t.query(internal.domains.trackingDomains.getActiveTrackingDomain, {});
		expect(active).not.toBeNull();
		expect(active!.domain).toBe('active.example.com');
		expect(active!.isVerified).toBe(true);
	});

	it('returns null when no tracking domain is verified', async () => {
		const t = convexTest(schema, verifyModules);
		await t.run(async (ctx) => {
			await ctx.db.insert('trackingDomains', {
				domain: 'pending.example.com',
				cnameTarget: 'track.owlat.com',
				isVerified: false,
				createdAt: Date.now(),
			});
		});

		const active = await t.query(internal.domains.trackingDomains.getActiveTrackingDomain, {});
		expect(active).toBeNull();
	});
});
