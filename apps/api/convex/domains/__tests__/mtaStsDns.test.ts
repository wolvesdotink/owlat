/**
 * MTA-STS publishing (RFC 8461) backend surface:
 *
 *  - `getMtaStsPolicy` (public) — the UNAUTHENTICATED policy content the Nuxt
 *    `/.well-known/mta-sts.txt` route serves. Returns null when nothing should
 *    be published (`mode` unset/`none`, or no `EHLO_HOSTNAME`), and the exact
 *    RFC 8461 body + policy id otherwise.
 *  - `getMtaStsGuidance` (admin) — the DNS-record guidance the Settings →
 *    Domains "Receiving" panel gathers: admin-gated, returns the `_mta-sts` TXT
 *    value the operator must publish, null when nothing is published.
 *  - `verifyMtaStsPublication` (pure) — the id-match verdict the live verify
 *    action delegates to (verify the served policy against the TXT id).
 *
 * The env is stubbed with `vi.stubEnv('EHLO_HOSTNAME', …)` and the singleton
 * `instanceSettings` row is seeded via a direct `ctx.db` write inside the
 * convex-test harness, so the gather is exercised end-to-end without a network.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import schema from '../../schema';
import { api } from '../../_generated/api';
import { verifyMtaStsPublication, buildMtaStsTxtValue } from '@owlat/shared/mtaStsPolicy';
import type { OrganizationRole } from '../../lib/sessionOrganization';

let mockRole: OrganizationRole = 'admin';

function throwForbidden(): never {
	const err = new Error("You don't have permission to perform this action") as Error & {
		data?: { category: string };
	};
	err.data = { category: 'forbidden' };
	throw err;
}

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof import('../../lib/sessionOrganization')>(
		'../../lib/sessionOrganization'
	);
	const ctx = () => ({ userId: 'test-user', role: mockRole });
	return {
		...actual,
		requireOrgMember: vi.fn(async () => ctx()),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		requireOrgPermission: vi.fn(async (_c: unknown, permission: string) => {
			if (permission === 'organization:manage' && mockRole === 'editor') {
				throwForbidden();
			}
			return ctx();
		}),
	};
});

// Same glob-merge trick as inboundMailConfig.test.ts so convex-test resolves the
// sibling `domains/*` modules (including `domains/domains.ts`).
const rootGlob = import.meta.glob('../../**/*.*s');
const domainsGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../domains/'),
		mod,
	])
);
const modules = { ...rootGlob, ...domainsGlob };

const identity = {
	subject: 'test-user',
	issuer: 'https://test.issuer.com',
	tokenIdentifier: 'https://test.issuer.com|test-user',
};

async function seedMode(
	t: ReturnType<typeof convexTest>,
	mode: 'none' | 'testing' | 'enforce'
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('instanceSettings', { mtaStsMode: mode, createdAt: Date.now() });
	});
}

beforeEach(() => {
	mockRole = 'admin';
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('getMtaStsPolicy (public policy content)', () => {
	it('returns null when no policy mode is set (nothing published)', async () => {
		vi.stubEnv('EHLO_HOSTNAME', 'mail.example.com');
		const t = convexTest(schema, modules);
		expect(await t.query(api.domains.domains.getMtaStsPolicy, {})).toBeNull();
	});

	it('returns null when mode is enforce but no mail host is configured', async () => {
		vi.stubEnv('EHLO_HOSTNAME', '');
		const t = convexTest(schema, modules);
		await seedMode(t, 'enforce');
		expect(await t.query(api.domains.domains.getMtaStsPolicy, {})).toBeNull();
	});

	it('serves the exact RFC 8461 body + id for enforce with a mail host', async () => {
		vi.stubEnv('EHLO_HOSTNAME', 'mail.example.com');
		const t = convexTest(schema, modules);
		await seedMode(t, 'enforce');
		const policy = await t.query(api.domains.domains.getMtaStsPolicy, {});
		expect(policy).not.toBeNull();
		expect(policy?.mode).toBe('enforce');
		expect(policy?.body).toBe(
			'version: STSv1\r\nmode: enforce\r\nmx: mail.example.com\r\nmax_age: 604800\r\n'
		);
		expect(policy?.policyId).toMatch(/^[0-9a-f]{16}$/);
	});

	it('changes the served body + id for testing mode', async () => {
		vi.stubEnv('EHLO_HOSTNAME', 'mail.example.com');
		const t = convexTest(schema, modules);
		await seedMode(t, 'testing');
		const policy = await t.query(api.domains.domains.getMtaStsPolicy, {});
		expect(policy?.body).toContain('mode: testing');
	});
});

describe('getMtaStsGuidance (admin DNS records)', () => {
	it('rejects a non-admin member (editor) with forbidden', async () => {
		const t = convexTest(schema, modules);
		mockRole = 'editor';
		const category = await t
			.withIdentity(identity)
			.query(api.domains.domains.getMtaStsGuidance, {})
			.then(() => undefined)
			.catch((e: { data?: { category?: string } }) => e?.data?.category);
		expect(category).toBe('forbidden');
	});

	it('returns null records when nothing is published', async () => {
		vi.stubEnv('EHLO_HOSTNAME', 'mail.example.com');
		const t = convexTest(schema, modules);
		const guidance = await t
			.withIdentity(identity)
			.query(api.domains.domains.getMtaStsGuidance, {});
		expect(guidance).toEqual({
			mode: 'none',
			mailHost: 'mail.example.com',
			policyId: null,
			txtValue: null,
		});
	});

	it('returns the _mta-sts TXT record value the operator must publish', async () => {
		vi.stubEnv('EHLO_HOSTNAME', 'mail.example.com');
		const t = convexTest(schema, modules);
		await seedMode(t, 'enforce');
		const guidance = await t
			.withIdentity(identity)
			.query(api.domains.domains.getMtaStsGuidance, {});
		expect(guidance.mode).toBe('enforce');
		expect(guidance.policyId).toMatch(/^[0-9a-f]{16}$/);
		expect(guidance.txtValue).toBe(buildMtaStsTxtValue(guidance.policyId!));
	});
});

describe('verifyMtaStsPublication (served-policy id match)', () => {
	const expected = {
		policyId: 'abcd1234abcd1234',
		body: 'version: STSv1\r\nmode: enforce\r\nmx: mail.example.com\r\nmax_age: 604800\r\n',
	};

	it('verifies when the TXT id matches AND the served body matches', () => {
		const result = verifyMtaStsPublication(expected, {
			txtValue: buildMtaStsTxtValue(expected.policyId),
			servedBody: expected.body,
		});
		expect(result.verified).toBe(true);
		expect(result.txtRecordValid).toBe(true);
		expect(result.policyServedValid).toBe(true);
	});

	it('fails when the TXT record announces a stale id', () => {
		const result = verifyMtaStsPublication(expected, {
			txtValue: 'v=STSv1; id=staleid0000',
			servedBody: expected.body,
		});
		expect(result.verified).toBe(false);
		expect(result.txtRecordValid).toBe(false);
		expect(result.observedId).toBe('staleid0000');
	});

	it('fails when the TXT record is missing entirely', () => {
		const result = verifyMtaStsPublication(expected, {
			txtValue: null,
			servedBody: expected.body,
		});
		expect(result.verified).toBe(false);
		expect(result.observedId).toBeNull();
	});

	it('fails when the served body does not match the generated policy', () => {
		const result = verifyMtaStsPublication(expected, {
			txtValue: buildMtaStsTxtValue(expected.policyId),
			servedBody: 'version: STSv1\r\nmode: testing\r\nmx: mail.example.com\r\nmax_age: 604800\r\n',
		});
		expect(result.verified).toBe(false);
		expect(result.policyServedValid).toBe(false);
	});
});
