/**
 * The Mandrill sending-domain provider (P3.1), against a mocked sender-domain
 * API and real table writes.
 *
 * The contract this file pins is not "the HTTP call works" — it is the set of
 * JUDGEMENTS the adapter makes on top of what Mandrill says, because each of
 * them decides whether a customer's From domain may be handed to a third party:
 *
 *  - WHAT COUNTS AS VERIFIED. All four of Mandrill's own signals, ownership
 *    included: a domain with perfect SPF/DKIM but no `verified_at` is one
 *    Mandrill will bounce with `reject_reason: unsigned`.
 *  - WHAT A FAILED CALL MAY OVERWRITE. A rejected credential fails the identity
 *    but leaves the DNS verdicts alone; an outage changes nothing at all — and
 *    NEITHER refreshes `lastCheckedAt`, or a long enough outage would keep a
 *    stale proof alive by being unable to re-confirm it.
 *  - WHAT LEAVES THE MODULE. Mandrill's convention puts the API key in the
 *    request BODY, so an echoing gateway hands it back on this path; nothing
 *    unstructured may reach an error message.
 *  - THE INSTRUCTIONS. The DNS the operator publishes is derived from the
 *    domain name (one shared selector), so the record set is a pure function
 *    and is pinned as one.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MANDRILL_RELAY_PROOF_MAX_AGE_MS } from '@owlat/shared';
import schema from '../../../../schema';
import { internal } from '../../../../_generated/api';
import { CURRENT_RELAY_IDENTITY_PROVIDER_DETAILS_VERSION } from '../../../../lib/constants';
import { mandrillProvider } from '../index';
import {
	MANDRILL_CHECK_INTERVAL_MS,
	MANDRILL_UNAVAILABLE_RETRY_MS,
	buildMandrillIdentity,
	deriveMandrillStatus,
	parseMandrillProviderDetails,
} from '../identity';
import {
	MANDRILL_DKIM_HOST,
	MANDRILL_DKIM_PUBLIC_KEY,
	MANDRILL_SPF_MECHANISM,
	buildMandrillDnsRecords,
	buildMandrillVerifyRecord,
} from '../records';
import { mandrillReferenceArm, mandrillRelayDomainVerified } from '../relayVerification';
import type { MandrillIdentity } from '../../types';

import { modules } from '../../../../__tests__/testModules';

vi.mock('../../../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof import('../../../../lib/sessionOrganization')>(
		'../../../../lib/sessionOrganization'
	);
	return {
		...actual,
		getSingletonOrganizationId: vi.fn().mockResolvedValue('org-a'),
		requireOrgMember: vi.fn(async () => ({ userId: 'test-user', role: 'admin' as const })),
	};
});

const ORG = 'org-a';
const DOMAIN = 'acme.com';
const NOW = 1_800_000_000_000;
const API_KEY = 'md-super-secret-key';

/** Mandrill's sender-domain object, as both endpoints answer with it. */
function mandrillState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		domain: DOMAIN,
		created_at: '2026-08-01 10:00:00',
		last_tested_at: '2026-08-04 10:00:00',
		spf: { valid: true, valid_after: '2026-08-01 10:00:00', error: null },
		dkim: { valid: true, valid_after: '2026-08-01 10:00:00', error: null },
		verified_at: '2026-08-01 10:05:00',
		valid_signing: true,
		...overrides,
	};
}

const UNPUBLISHED = mandrillState({
	spf: { valid: false, error: 'The SPF record is missing' },
	dkim: { valid: false, error: 'The DKIM record is missing' },
	verified_at: null,
	valid_signing: false,
});

let fetchMock: ReturnType<typeof vi.fn>;

function respondJson(body: unknown, status = 200): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
		text: async () => JSON.stringify(body),
		headers: new Headers(),
	} as unknown as Response;
}

function respondError(body: string, status: number): Response {
	return {
		ok: false,
		status,
		json: async () => JSON.parse(body) as unknown,
		text: async () => body,
		headers: new Headers(),
	} as unknown as Response;
}

beforeEach(() => {
	vi.stubEnv('MANDRILL_API_KEY', API_KEY);
	fetchMock = vi.fn();
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

/** The parsed body of the n-th call the adapter made. */
function requestBody(index = 0): Record<string, unknown> {
	const init = fetchMock.mock.calls[index]?.[1] as RequestInit | undefined;
	return JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
}

function requestUrl(index = 0): string {
	return String(fetchMock.mock.calls[index]?.[0]);
}

// ─── The provider API calls ────────────────────────────────────────────────

describe('registerDomain', () => {
	it('adds the domain and returns the records to publish', async () => {
		fetchMock.mockResolvedValueOnce(respondJson(UNPUBLISHED));

		const result = await mandrillProvider.registerDomain(DOMAIN);

		expect(requestUrl()).toBe('https://mandrillapp.com/api/1.0/senders/add-domain');
		// Mandrill's convention: the key travels in the BODY, never a header or a
		// URL, so it cannot reach a log line or a proxy access log.
		expect(requestBody()).toEqual({ key: API_KEY, domain: DOMAIN });

		expect(result.dnsRecords.spf?.value).toContain(MANDRILL_SPF_MECHANISM);
		expect(result.dnsRecords.dkim).toEqual([
			{ type: 'TXT', host: MANDRILL_DKIM_HOST, value: MANDRILL_DKIM_PUBLIC_KEY },
		]);
		// Monitor-only DMARC for a brand-new domain, exactly like every other
		// provider's first record set.
		expect(result.dnsRecords.dmarc?.value).toContain('p=none');
		// No custom MAIL FROM: Mandrill mints its own bounce local part (D5).
		expect(result.dnsRecords.mailFrom).toBeUndefined();

		expect(result.identity.kind).toBe('mandrill');
		expect(result.identity.status).toBe('pending_dns');
		expect(result.identity.dkimSelector).toBe('mandrill');
		expect(result.identity.spf).toEqual({ isValid: false, error: 'The SPF record is missing' });
	});

	it('reports an already-verified account state as verified', async () => {
		fetchMock.mockResolvedValueOnce(respondJson(mandrillState()));

		const { identity } = await mandrillProvider.registerDomain(DOMAIN);

		expect(identity.status).toBe('verified');
		expect(identity.isValidSigning).toBe(true);
		expect(identity.verifiedAt).toBe(Date.parse('2026-08-01T10:05:00Z'));
	});

	it('surfaces a verification TXT key when the account offers one', async () => {
		fetchMock.mockResolvedValueOnce(
			respondJson(mandrillState({ verify_txt_key: 'abc123', verified_at: null }))
		);

		const { identity } = await mandrillProvider.registerDomain(DOMAIN);

		expect(identity.verifyTxtKey).toBe('abc123');
		// Ownership has not cleared, so this is NOT a sendable domain yet.
		expect(identity.status).toBe('pending_dns');
	});

	it('throws on a rejected credential, without echoing the key', async () => {
		fetchMock.mockResolvedValueOnce(
			respondError(
				JSON.stringify({
					status: 'error',
					code: -1,
					name: 'Invalid_Key',
					message: `Invalid API key: ${API_KEY}`,
				}),
				500
			)
		);

		await expect(mandrillProvider.registerDomain(DOMAIN)).rejects.toThrow(/auth_failed/);
		await expect(
			mandrillProvider.registerDomain(DOMAIN).catch((error: Error) => error.message)
		).resolves.not.toContain(API_KEY);
	});

	it('throws when Mandrill is unavailable', async () => {
		fetchMock.mockResolvedValue(respondError('<html>502 Bad Gateway</html>', 502));

		await expect(mandrillProvider.registerDomain(DOMAIN)).rejects.toThrow(/unavailable/);
		// An unparseable body is reported by status alone — never echoed, since a
		// gateway that mirrors the request would mirror the key with it.
		await expect(
			mandrillProvider.registerDomain(DOMAIN).catch((error: Error) => error.message)
		).resolves.toContain('HTTP 502');
	});

	it('throws rather than calling out when no API key is configured', async () => {
		vi.stubEnv('MANDRILL_API_KEY', '');

		await expect(mandrillProvider.registerDomain(DOMAIN)).rejects.toThrow(
			/MANDRILL_API_KEY is not configured/
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe('runProviderCheck', () => {
	it('asks check-domain and accepts a complete state', async () => {
		fetchMock.mockResolvedValueOnce(respondJson(mandrillState()));

		expect(await mandrillProvider.runProviderCheck?.(DOMAIN)).toEqual({ verified: true });
		expect(requestUrl()).toBe('https://mandrillapp.com/api/1.0/senders/check-domain');
	});

	it('names what is outstanding when the records are not live', async () => {
		fetchMock.mockResolvedValueOnce(respondJson(UNPUBLISHED));

		const result = await mandrillProvider.runProviderCheck?.(DOMAIN);

		expect(result?.verified).toBe(false);
		expect(result?.lastError).toContain('SPF');
		expect(result?.lastError).toContain('DKIM');
		expect(result?.lastError).toContain('domain verification');
	});

	it('refuses a domain whose ownership Mandrill has not verified', async () => {
		// The dangerous near-miss: both records live, signing enabled, no
		// ownership. Mandrill rejects mail from such a domain (`unsigned`), so
		// calling it verified would hand the relay a domain it will bounce.
		fetchMock.mockResolvedValueOnce(respondJson(mandrillState({ verified_at: null })));

		expect((await mandrillProvider.runProviderCheck?.(DOMAIN))?.verified).toBe(false);
	});

	it('refuses a domain Mandrill will not sign for, however good the DNS is', async () => {
		fetchMock.mockResolvedValueOnce(respondJson(mandrillState({ valid_signing: false })));

		expect((await mandrillProvider.runProviderCheck?.(DOMAIN))?.verified).toBe(false);
	});

	it('reports an outage as unverified rather than throwing', async () => {
		fetchMock.mockRejectedValueOnce(new Error('network down'));

		const result = await mandrillProvider.runProviderCheck?.(DOMAIN);

		expect(result?.verified).toBe(false);
		expect(result?.lastError).toContain('Mandrill check error');
	});

	it('treats a 200 that is not a domain object as no answer at all', async () => {
		// A captive-portal / proxy HTML page answering 200 must never read as
		// "every record is invalid" — that would fail a working identity.
		fetchMock.mockResolvedValueOnce(respondJson('<html>hello</html>'));

		expect((await mandrillProvider.runProviderCheck?.(DOMAIN))?.lastError).toContain(
			'no sender-domain state'
		);
	});
});

// ─── The DNS instructions ──────────────────────────────────────────────────

describe('the published records', () => {
	it('are a pure function of the domain name', () => {
		expect(buildMandrillDnsRecords(DOMAIN)).toEqual(buildMandrillDnsRecords(DOMAIN));
		expect(buildMandrillDnsRecords(DOMAIN).dkim?.[0]?.host).toBe('mandrill._domainkey');
	});

	it('builds the ownership TXT record only from a key Mandrill gave us', () => {
		expect(buildMandrillVerifyRecord('abc123')).toEqual({
			type: 'TXT',
			host: '@',
			value: 'mandrill_verify.abc123',
		});
	});
});

// ─── The status derivation ─────────────────────────────────────────────────

describe('deriveMandrillStatus', () => {
	const state = (overrides: Partial<Parameters<typeof deriveMandrillStatus>[0]>) => ({
		domain: DOMAIN,
		spf: { isValid: true },
		dkim: { isValid: true },
		isValidSigning: true,
		verifiedAt: NOW,
		...overrides,
	});

	it('is verified only with all four signals', () => {
		expect(deriveMandrillStatus(state({}))).toBe('verified');
		expect(deriveMandrillStatus(state({ spf: { isValid: false } }))).toBe('pending_dns');
		expect(deriveMandrillStatus(state({ dkim: { isValid: false } }))).toBe('pending_dns');
		expect(deriveMandrillStatus(state({ isValidSigning: false }))).toBe('pending_dns');
		expect(deriveMandrillStatus(state({ verifiedAt: undefined }))).toBe('pending_dns');
	});

	it('separates "no evidence" from "records outstanding"', () => {
		// Mandrill answered but said nothing about either record: unverified, and
		// deliberately not the same word as a domain that is mid-setup.
		expect(
			deriveMandrillStatus(
				state({
					spf: { isValid: false },
					dkim: { isValid: false },
					isValidSigning: false,
					verifiedAt: undefined,
				})
			)
		).toBe('unverified');
		expect(
			deriveMandrillStatus(
				state({
					spf: { isValid: false, error: 'missing' },
					dkim: { isValid: false },
					isValidSigning: false,
					verifiedAt: undefined,
				})
			)
		).toBe('pending_dns');
	});
});

// ─── Persistence, cadence and the failure postures ─────────────────────────

function identity(overrides: Partial<MandrillIdentity> = {}): MandrillIdentity {
	return {
		kind: 'mandrill',
		dkimSelector: 'mandrill',
		status: 'verified',
		spf: { isValid: true },
		dkim: { isValid: true },
		isValidSigning: true,
		verifiedAt: NOW,
		checkedAt: NOW,
		...overrides,
	};
}

async function seedDomain(t: TestConvex<typeof schema>, domain = DOMAIN): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('domains', {
			domain,
			providerType: 'mta' as const,
			status: 'verified' as const,
			dnsRecords: {},
			createdAt: NOW,
			updatedAt: NOW,
		});
	});
}

async function seedIdentity(
	t: TestConvex<typeof schema>,
	overrides: Partial<{
		domain: string;
		status: 'unverified' | 'pending_dns' | 'verified' | 'failed';
		spf: { isValid: boolean; error?: string };
		dkim: { isValid: boolean; error?: string };
		lastCheckedAt: number;
		nextCheckDueAt: number;
		providerKind: string;
	}> = {}
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('sendingDomainRelayIdentities', {
			organizationId: ORG,
			domain: DOMAIN,
			providerKind: 'mandrill',
			status: 'verified' as const,
			spf: { isValid: true },
			dkim: { isValid: true },
			providerDetails: JSON.stringify({ kind: 'mandrill', isValidSigning: true }),
			providerDetailsVersion: CURRENT_RELAY_IDENTITY_PROVIDER_DETAILS_VERSION,
			lastCheckedAt: NOW,
			nextCheckDueAt: NOW + MANDRILL_CHECK_INTERVAL_MS.verified,
			createdAt: NOW,
			updatedAt: NOW,
			...overrides,
		});
	});
}

async function readRow(t: TestConvex<typeof schema>) {
	return await t.run(
		async (ctx) =>
			await ctx.db
				.query('sendingDomainRelayIdentities')
				.withIndex('by_domain_provider', (q) =>
					q.eq('domain', DOMAIN).eq('providerKind', 'mandrill')
				)
				.first()
	);
}

describe('writeIdentity / clearIdentity', () => {
	it('writes one org-scoped row, versioned and on the right cadence', async () => {
		const t = convexTest(schema, modules);
		await seedDomain(t, 'Acme.com');

		await t.run(async (ctx) => {
			const domain = await ctx.db.query('domains').first();
			await mandrillProvider.writeIdentity(ctx, domain!._id, identity());
		});

		const row = await readRow(t);
		expect(row?.organizationId).toBe(ORG);
		// Keyed on the LOWERCASED name, so the enqueue proof's case-insensitive
		// lookup can never miss a row written from a mixed-case domain row.
		expect(row?.domain).toBe(DOMAIN);
		expect(row?.providerKind).toBe('mandrill');
		expect(row?.status).toBe('verified');
		expect(row?.providerDetailsVersion).toBe(CURRENT_RELAY_IDENTITY_PROVIDER_DETAILS_VERSION);
		expect(parseMandrillProviderDetails(row?.providerDetails, row?.providerDetailsVersion)).toEqual(
			{ kind: 'mandrill', isValidSigning: true, verifiedAt: NOW }
		);
		// The proof is dated by the EVIDENCE, not by the write.
		expect(row?.lastCheckedAt).toBe(NOW);
		expect(row?.nextCheckDueAt).toBe(NOW + MANDRILL_CHECK_INTERVAL_MS.verified);
	});

	it('re-checks a pending identity on the short cadence', async () => {
		const t = convexTest(schema, modules);
		await seedDomain(t);

		await t.run(async (ctx) => {
			const domain = await ctx.db.query('domains').first();
			await mandrillProvider.writeIdentity(
				ctx,
				domain!._id,
				identity({ status: 'pending_dns', spf: { isValid: false, error: 'missing' } })
			);
		});

		expect((await readRow(t))?.nextCheckDueAt).toBe(NOW + MANDRILL_CHECK_INTERVAL_MS.pending_dns);
	});

	it('patches rather than duplicating on a second write', async () => {
		const t = convexTest(schema, modules);
		await seedDomain(t);

		await t.run(async (ctx) => {
			const domain = await ctx.db.query('domains').first();
			await mandrillProvider.writeIdentity(ctx, domain!._id, identity({ status: 'pending_dns' }));
			await mandrillProvider.writeIdentity(ctx, domain!._id, identity());
		});

		const rows = await t.run(
			async (ctx) => await ctx.db.query('sendingDomainRelayIdentities').collect()
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.status).toBe('verified');
	});

	it('clears the row', async () => {
		const t = convexTest(schema, modules);
		await seedDomain(t);
		await seedIdentity(t);

		await t.run(async (ctx) => {
			const domain = await ctx.db.query('domains').first();
			await mandrillProvider.clearIdentity(ctx, domain!._id);
		});

		expect(await readRow(t)).toBeNull();
	});
});

describe('a check that produced no verdict', () => {
	it('fails the identity on a rejected credential, leaving the DNS verdicts alone', async () => {
		const t = convexTest(schema, modules);
		await seedIdentity(t);

		await t.mutation(internal.domains.mandrillRelayMutations.recordCheckFailure, {
			domain: DOMAIN,
			isAuthFailure: true,
			error: 'Invalid_Key: bad key',
		});

		const row = await readRow(t);
		expect(row?.status).toBe('failed');
		// The key being wrong is not evidence that the operator's DNS changed.
		expect(row?.spf).toEqual({ isValid: true });
		expect(row?.dkim).toEqual({ isValid: true });
		// And it is not evidence that the proof is fresh, either.
		expect(row?.lastCheckedAt).toBe(NOW);
		expect(
			parseMandrillProviderDetails(row?.providerDetails, row?.providerDetailsVersion)?.lastError
		).toBe('Invalid_Key: bad key');
	});

	it('leaves an identity untouched when Mandrill is simply unreachable', async () => {
		const t = convexTest(schema, modules);
		await seedIdentity(t);
		const before = await readRow(t);

		await t.mutation(internal.domains.mandrillRelayMutations.recordCheckFailure, {
			domain: DOMAIN,
			isAuthFailure: false,
			error: 'socket hang up',
		});

		const row = await readRow(t);
		expect(row?.status).toBe(before?.status);
		expect(row?.lastCheckedAt).toBe(before?.lastCheckedAt);
		// Only the retry moves — and to the short outage cadence, not a real one.
		expect(row?.nextCheckDueAt).toBeLessThanOrEqual(Date.now() + MANDRILL_UNAVAILABLE_RETRY_MS);
		expect(row?.nextCheckDueAt).toBeGreaterThan(Date.now());
	});

	it('invents nothing for a domain that has no identity', async () => {
		const t = convexTest(schema, modules);

		await t.mutation(internal.domains.mandrillRelayMutations.recordCheckFailure, {
			domain: 'never-connected.example',
			isAuthFailure: true,
			error: 'Invalid_Key',
		});

		expect(
			await t.run(async (ctx) => await ctx.db.query('sendingDomainRelayIdentities').collect())
		).toHaveLength(0);
	});
});

describe('the re-check sweep', () => {
	it('schedules only the Mandrill identities that are due', async () => {
		const t = convexTest(schema, modules);
		// Long overdue (the sweep reads the wall clock, so a fixture timestamp in
		// the plan's future would never be due).
		await seedIdentity(t, { nextCheckDueAt: 1_000 });
		await t.run(async (ctx) => {
			// Not due yet.
			await ctx.db.insert('sendingDomainRelayIdentities', {
				organizationId: ORG,
				domain: 'fresh.example',
				providerKind: 'mandrill',
				status: 'verified' as const,
				lastCheckedAt: Date.now(),
				nextCheckDueAt: Date.now() + MANDRILL_CHECK_INTERVAL_MS.verified,
				createdAt: NOW,
				updatedAt: NOW,
			});
			// Due, but another kind's row — this sweep is not its owner.
			await ctx.db.insert('sendingDomainRelayIdentities', {
				organizationId: ORG,
				domain: 'other.example',
				providerKind: 'postmark',
				status: 'verified' as const,
				lastCheckedAt: NOW,
				nextCheckDueAt: 1_000,
				createdAt: NOW,
				updatedAt: NOW,
			});
		});

		expect(await t.mutation(internal.domains.mandrillRelayMutations.scheduleDueChecks, {})).toBe(1);
	});
});

// ─── The reads the router and the ramp make ────────────────────────────────

describe('relayDomainVerified', () => {
	it('accepts a fresh, complete proof — case-insensitively', async () => {
		const t = convexTest(schema, modules);
		await seedIdentity(t);

		await t.run(async (ctx) => {
			expect(await mandrillRelayDomainVerified(ctx, DOMAIN, NOW)).toBe(true);
			expect(await mandrillRelayDomainVerified(ctx, DOMAIN.toUpperCase(), NOW)).toBe(true);
		});
	});

	it('refuses a proof older than the max age', async () => {
		const t = convexTest(schema, modules);
		await seedIdentity(t);

		await t.run(async (ctx) => {
			expect(
				await mandrillRelayDomainVerified(ctx, DOMAIN, NOW + MANDRILL_RELAY_PROOF_MAX_AGE_MS)
			).toBe(true);
			expect(
				await mandrillRelayDomainVerified(ctx, DOMAIN, NOW + MANDRILL_RELAY_PROOF_MAX_AGE_MS + 1)
			).toBe(false);
		});
	});

	it('refuses every non-verified status', async () => {
		for (const status of ['unverified', 'pending_dns', 'failed'] as const) {
			const t = convexTest(schema, modules);
			await seedIdentity(t, { status });
			await t.run(async (ctx) => {
				expect(await mandrillRelayDomainVerified(ctx, DOMAIN, NOW)).toBe(false);
			});
		}
	});

	it('refuses a row whose record verdicts contradict its status', async () => {
		// Defence in depth: `status` is derived, and this read is what licenses
		// handing a From domain to a third party. Fail closed.
		const t = convexTest(schema, modules);
		await seedIdentity(t, { spf: { isValid: false } });

		await t.run(async (ctx) => {
			expect(await mandrillRelayDomainVerified(ctx, DOMAIN, NOW)).toBe(false);
		});
	});

	it('refuses a domain with no identity at all', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			expect(await mandrillRelayDomainVerified(ctx, DOMAIN, NOW)).toBe(false);
		});
	});
});

describe('describeReferenceArm', () => {
	it('describes the second arm for a verified domain', async () => {
		const t = convexTest(schema, modules);
		await seedDomain(t);
		await seedIdentity(t);

		const arm = await t.run(async (ctx) => {
			const domain = await ctx.db.query('domains').first();
			return await mandrillReferenceArm(ctx, domain!, NOW);
		});

		expect(arm).toEqual({
			label: 'Mandrill relay',
			fromDomain: DOMAIN,
			// Same From domain and same DKIM `d=` as the own arm, a different
			// selector — the alignment contract the ramp is measured under.
			dkimDomain: DOMAIN,
			dkimSelectors: ['mandrill'],
			spfMechanisms: [MANDRILL_SPF_MECHANISM],
			supportsCustomReturnPath: false,
		});
	});

	it('describes nothing for an unverified domain', async () => {
		const t = convexTest(schema, modules);
		await seedDomain(t);
		await seedIdentity(t, { status: 'pending_dns' });

		const arm = await t.run(async (ctx) => {
			const domain = await ctx.db.query('domains').first();
			return await mandrillReferenceArm(ctx, domain!, NOW);
		});

		// Null, not a half-filled arm: the pre-flight resolves selectors against
		// LIVE DNS, so an arm for unpublished records would be reported to the
		// operator as a misalignment they did not cause.
		expect(arm).toBeNull();
	});
});

describe('buildMandrillIdentity', () => {
	it('dates the identity by the observation, not by the row', () => {
		const built = buildMandrillIdentity(
			{
				domain: DOMAIN,
				spf: { isValid: true },
				dkim: { isValid: true },
				isValidSigning: true,
				verifiedAt: NOW - 1_000,
			},
			NOW
		);
		expect(built.checkedAt).toBe(NOW);
		expect(built.verifiedAt).toBe(NOW - 1_000);
		expect(built.status).toBe('verified');
	});
});
