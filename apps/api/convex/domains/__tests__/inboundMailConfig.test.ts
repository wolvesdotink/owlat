/**
 * `domains.domains.getInboundMailConfig` — the admin-gated read that feeds the
 * Settings → Domains "Receiving" panel.
 *
 * Locks in two things:
 *   1. Authorization: it is admin-gated (`organization:manage`). A non-admin
 *      member (`editor`) is rejected with `forbidden`; an admin succeeds. The
 *      session helpers are mocked with a mutable role mirroring production
 *      semantics — the same pattern the operator-read-authz suite uses.
 *   2. Derivation: it returns the deployment mail host (EHLO_HOSTNAME) as the MX
 *      target plus the inbound SMTP port, and `mailHost: null` when EHLO is
 *      unset (a send-only install with no inbound MTA).
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import schema from '../../schema';
import { api } from '../../_generated/api';
import type { OrganizationRole } from '../../lib/sessionOrganization';

// Mutable role each test selects.
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
		'../../lib/sessionOrganization',
	);
	const ctx = () => ({ userId: 'test-user', role: mockRole });
	return {
		...actual,
		// authedQuery floor — always a member here; the role distinction is what
		// the in-handler requireOrgPermission decides.
		requireOrgMember: vi.fn(async () => ctx()),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		// Role-aware gate: owner/admin pass `organization:manage`, editor does not.
		requireOrgPermission: vi.fn(async (_c: unknown, permission: string) => {
			if (permission === 'organization:manage' && mockRole === 'editor') {
				throwForbidden();
			}
			return ctx();
		}),
	};
});

// Vite's `import.meta.glob` excludes the directory chain it climbed up through
// to reach the glob base, so `'../../**'` from this `domains/__tests__` file
// omits the sibling `domains/*` modules (including `domains/domains.ts`, the
// module under test). Merge a second glob rooted at `domains/` and re-prefix its
// keys to the same `../../`-relative form so convex-test resolves every entry.
const rootGlob = import.meta.glob('../../**/*.*s');
const domainsGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../domains/'),
		mod,
	]),
);
const modules = { ...rootGlob, ...domainsGlob };

const identity = {
	subject: 'test-user',
	issuer: 'https://test.issuer.com',
	tokenIdentifier: 'https://test.issuer.com|test-user',
};

beforeEach(() => {
	mockRole = 'admin';
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('domains.getInboundMailConfig', () => {
	it('rejects a non-admin member (editor) with forbidden', async () => {
		const t = convexTest(schema, modules);
		mockRole = 'editor';
		const category = await t
			.withIdentity(identity)
			.query(api.domains.domains.getInboundMailConfig, {})
			.then(() => undefined)
			.catch((e: { data?: { category?: string } }) => e?.data?.category);
		expect(category).toBe('forbidden');
	});

	it('returns the EHLO hostname as the MX target + inbound port for an admin', async () => {
		vi.stubEnv('EHLO_HOSTNAME', 'mail.example.com');
		const t = convexTest(schema, modules);
		mockRole = 'admin';
		const config = await t
			.withIdentity(identity)
			.query(api.domains.domains.getInboundMailConfig, {});
		expect(config).toEqual({ mailHost: 'mail.example.com', inboundPort: 25 });
	});

	it('returns mailHost: null when EHLO_HOSTNAME is unset (send-only install)', async () => {
		vi.stubEnv('EHLO_HOSTNAME', '');
		const t = convexTest(schema, modules);
		mockRole = 'owner';
		const config = await t
			.withIdentity(identity)
			.query(api.domains.domains.getInboundMailConfig, {});
		expect(config).toEqual({ mailHost: null, inboundPort: 25 });
	});
});
