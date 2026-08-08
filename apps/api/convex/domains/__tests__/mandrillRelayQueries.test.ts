/**
 * The Mandrill identity READ the domain screens consume.
 *
 * Three things are worth pinning, and only one of them is "the query returns
 * rows":
 *
 *  - ORG SCOPE AND KIND SCOPE. The generic relay-identity table is shared by
 *    every future provider and (under the singleton-org invariant) keyed by
 *    organization, so a read that forgot either would show one deployment's
 *    domains — or another provider's rows — on the Mandrill panel.
 *  - THE DERIVED DNS. The records are a pure function of the domain name, and
 *    the whole reason the query derives them is so the screen cannot show DNS
 *    we never registered. Asserted against the same helpers the adapter uses.
 *  - THE PROVIDER-DETAILS BLOB. Ownership, the verify token and the last error
 *    all live in the versioned blob; a row written by a FUTURE version must
 *    read as "nothing known" rather than be reinterpreted.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import { MANDRILL_RELAY_PROOF_MAX_AGE_MS } from '@owlat/shared';
import schema from '../../schema';
import { api } from '../../_generated/api';
import { CURRENT_RELAY_IDENTITY_PROVIDER_DETAILS_VERSION } from '../../lib/constants';
import {
	MANDRILL_DKIM_HOST,
	MANDRILL_DKIM_PUBLIC_KEY,
	MANDRILL_SPF_MECHANISM,
} from '../providers/mandrill/records';
import { modules } from '../../__tests__/testModules';

const ORG = 'org-a';
const OTHER_ORG = 'org-b';
const NOW = 1_800_000_000_000;

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof import('../../lib/sessionOrganization')>(
		'../../lib/sessionOrganization'
	);
	return {
		...actual,
		getSingletonOrganizationId: vi.fn().mockResolvedValue('org-a'),
		requireOrgMember: vi.fn(async () => ({ userId: 'test-user', role: 'admin' as const })),
		requireOrgPermission: vi.fn(async () => ({ userId: 'test-user', role: 'admin' as const })),
	};
});

const identity = {
	subject: 'test-user',
	issuer: 'https://test.issuer.com',
	tokenIdentifier: 'https://test.issuer.com|test-user',
};

interface RowOverrides {
	organizationId?: string;
	domain?: string;
	providerKind?: string;
	status?: 'unverified' | 'pending_dns' | 'verified' | 'failed';
	spf?: { isValid: boolean; error?: string };
	dkim?: { isValid: boolean; error?: string };
	providerDetails?: string;
	providerDetailsVersion?: number;
	lastCheckedAt?: number;
	nextCheckDueAt?: number;
}

function row(over: RowOverrides = {}) {
	return {
		organizationId: ORG,
		domain: 'acme.com',
		providerKind: 'mandrill',
		status: 'verified' as const,
		spf: { isValid: true },
		dkim: { isValid: true },
		providerDetails: JSON.stringify({
			kind: 'mandrill',
			isValidSigning: true,
			verifiedAt: NOW - 1000,
		}),
		providerDetailsVersion: CURRENT_RELAY_IDENTITY_PROVIDER_DETAILS_VERSION,
		lastCheckedAt: NOW - 1000,
		nextCheckDueAt: NOW + 86_400_000,
		createdAt: NOW - 2000,
		updatedAt: NOW - 1000,
		...over,
	};
}

async function seed(t: ReturnType<typeof convexTest>, rows: ReturnType<typeof row>[]) {
	await t.run(async (ctx) => {
		for (const r of rows) await ctx.db.insert('sendingDomainRelayIdentities', r);
	});
}

function list(t: ReturnType<typeof convexTest>) {
	return t.withIdentity(identity).query(api.domains.mandrillRelayQueries.listIdentities, {});
}

describe('domains.mandrillRelayQueries.listIdentities scope', () => {
	it('returns only this organization’s rows', async () => {
		const t = convexTest(schema, modules);
		await seed(t, [row(), row({ organizationId: OTHER_ORG, domain: 'other-tenant.com' })]);

		const result = await list(t);
		expect(result.map((r) => r.domain)).toEqual(['acme.com']);
	});

	it('returns only Mandrill rows from the shared relay-identity table', async () => {
		const t = convexTest(schema, modules);
		await seed(t, [row(), row({ domain: 'future-kind.com', providerKind: 'postmark' })]);

		const result = await list(t);
		expect(result.map((r) => r.domain)).toEqual(['acme.com']);
	});

	it('is empty — not an error — when Mandrill was never connected', async () => {
		const t = convexTest(schema, modules);
		expect(await list(t)).toEqual([]);
	});
});

describe('domains.mandrillRelayQueries.listIdentities shape', () => {
	it('derives the SPF and DKIM records from the domain name', async () => {
		const t = convexTest(schema, modules);
		await seed(t, [row()]);

		const [entry] = await list(t);
		expect(entry?.records.spf).toEqual({
			type: 'TXT',
			host: '@',
			value: `v=spf1 ${MANDRILL_SPF_MECHANISM} -all`,
		});
		expect(entry?.records.dkim).toEqual([
			{ type: 'TXT', host: MANDRILL_DKIM_HOST, value: MANDRILL_DKIM_PUBLIC_KEY },
		]);
	});

	it('returns the ownership record only when Mandrill issued a token', async () => {
		const t = convexTest(schema, modules);
		await seed(t, [
			row({
				domain: 'with-token.com',
				providerDetails: JSON.stringify({
					kind: 'mandrill',
					isValidSigning: false,
					verifyTxtKey: 'abc123',
				}),
			}),
			row({ domain: 'no-token.com' }),
		]);

		const byDomain = new Map((await list(t)).map((r) => [r.domain, r]));
		expect(byDomain.get('with-token.com')?.records.ownership).toEqual({
			type: 'TXT',
			host: '@',
			value: 'mandrill_verify.abc123',
		});
		expect(byDomain.get('no-token.com')?.records.ownership).toBeNull();
	});

	it('carries Mandrill’s own error text through unedited', async () => {
		const t = convexTest(schema, modules);
		await seed(t, [
			row({
				status: 'pending_dns',
				spf: { isValid: false, error: 'no valid SPF record found' },
				dkim: { isValid: false, error: 'no TXT record at mandrill._domainkey' },
				providerDetails: JSON.stringify({
					kind: 'mandrill',
					isValidSigning: false,
					lastError: 'Invalid API key',
				}),
			}),
		]);

		const [entry] = await list(t);
		expect(entry?.spf).toEqual({ isValid: false, error: 'no valid SPF record found' });
		expect(entry?.dkim?.error).toBe('no TXT record at mandrill._domainkey');
		expect(entry?.lastError).toBe('Invalid API key');
		expect(entry?.verifiedAt).toBeNull();
	});

	it('hands the screen the freshness FACTS, not a verdict', async () => {
		// The screen and routing apply the same bound; returning the numbers is
		// what keeps them from drifting into two different answers.
		const t = convexTest(schema, modules);
		await seed(t, [row()]);

		const [entry] = await list(t);
		expect(entry?.lastCheckedAt).toBe(NOW - 1000);
		expect(entry?.nextCheckDueAt).toBe(NOW + 86_400_000);
		expect(entry?.proofMaxAgeMs).toBe(MANDRILL_RELAY_PROOF_MAX_AGE_MS);
	});

	it('reports a blob written by a future version as nothing known', async () => {
		const t = convexTest(schema, modules);
		await seed(t, [
			row({
				providerDetailsVersion: CURRENT_RELAY_IDENTITY_PROVIDER_DETAILS_VERSION + 1,
				providerDetails: JSON.stringify({ kind: 'mandrill', isValidSigning: true }),
			}),
		]);

		const [entry] = await list(t);
		expect(entry?.isValidSigning).toBe(false);
		expect(entry?.verifiedAt).toBeNull();
		expect(entry?.records.ownership).toBeNull();
	});
});
