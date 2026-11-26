/**
 * Adding and removing a sending domain's optional Ed25519 key: the MTA's HTTP
 * API is the only stub; the actions, the gate query and the commit mutation are
 * the real ones.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { api } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { modules } from '../../__tests__/testModules';
import type * as SessionOrganizationModule from '../../lib/sessionOrganization';
import { withOptionalDkimRecord } from '../dkimRecords';

const session = { userId: 'user-1', role: 'owner', activeOrganizationId: 'org-a' };
const requireOrgPermission = vi.fn();

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof SessionOrganizationModule>(
		'../../lib/sessionOrganization'
	);
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session),
		requireOrgPermission: (...args: unknown[]) => requireOrgPermission(...args),
	};
});

const DOMAIN = 'mail.example.com';
const ED_KEY = { selector: 'e1', dnsRecord: 'v=DKIM1; k=ed25519; p=EDKEY' };
const RSA_RECORD = { type: 'TXT' as const, host: 's1._domainkey', value: 'v=DKIM1; k=rsa; p=KEY' };

let fetchMock: ReturnType<typeof vi.fn>;

function respondJson(body: unknown, status = 200): Response {
	return {
		ok: status < 300,
		status,
		json: async () => body,
		text: async () => JSON.stringify(body),
		headers: new Headers(),
	} as unknown as Response;
}

beforeEach(() => {
	vi.stubEnv('MTA_API_URL', 'http://mta:3100');
	vi.stubEnv('MTA_API_KEY', 'mta-key');
	requireOrgPermission.mockReset().mockResolvedValue(session);
	fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
		init?.method === 'DELETE'
			? respondJson({ success: true, domain: DOMAIN, removed: true })
			: respondJson({ success: true, domain: DOMAIN, created: true, ...ED_KEY })
	);
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

async function seedDomain(
	t: ReturnType<typeof convexTest>,
	fields: { providerType?: string; status?: 'verified' | 'registering' } = {}
): Promise<Id<'domains'>> {
	return await t.run(async (ctx) =>
		ctx.db.insert('domains', {
			domain: DOMAIN,
			status: fields.status ?? 'verified',
			providerType: fields.providerType ?? 'mta',
			dnsRecords: {
				dkim: [RSA_RECORD],
				dmarc: { type: 'TXT', host: '_dmarc', value: 'v=DMARC1; p=none' },
			},
			verificationResults: {
				dkim: [{ verified: true, lastChecked: 1 }],
				dmarc: { verified: true, lastChecked: 1 },
			},
			verifiedAt: 1,
			createdAt: 1,
			updatedAt: 1,
		})
	);
}

async function row(t: ReturnType<typeof convexTest>, id: Id<'domains'>) {
	return await t.run(async (ctx) => ctx.db.get(id));
}

describe('domains.dkimEd25519', () => {
	it('adds the optional record and keeps the domain verified and its results', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedDomain(t);

		await expect(t.action(api.domains.dkimEd25519.addKey, { domainId })).resolves.toEqual(ED_KEY);

		expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`http://mta:3100/dkim/${DOMAIN}/ed25519`);
		expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
			organizationId: 'org-a',
		});
		const domain = await row(t, domainId);
		expect(domain!.status).toBe('verified');
		expect(domain!.dnsRecords.dkim).toEqual([
			RSA_RECORD,
			{ type: 'TXT', host: 'e1._domainkey', value: ED_KEY.dnsRecord, optional: true },
		]);
		expect(domain!.verificationResults?.dkim).toEqual([{ verified: true, lastChecked: 1 }]);
		const audits = await t.run(async (ctx) => ctx.db.query('auditLogs').collect());
		expect(audits.map((a) => a.action)).toContain('sending_domain.dkim_key_added');
	});

	it('is idempotent: adding twice lists the record once', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedDomain(t);

		await t.action(api.domains.dkimEd25519.addKey, { domainId });
		await t.action(api.domains.dkimEd25519.addKey, { domainId });

		expect((await row(t, domainId))!.dnsRecords.dkim).toHaveLength(2);
	});

	it('removes the record, keeps the RSA one and the status', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedDomain(t);
		await t.action(api.domains.dkimEd25519.addKey, { domainId });

		await t.action(api.domains.dkimEd25519.removeKey, { domainId });

		expect(fetchMock.mock.calls[1]?.[1]?.method).toBe('DELETE');
		// The MTA checks the owner again before it deletes.
		expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
			organizationId: 'org-a',
		});
		const domain = await row(t, domainId);
		expect(domain!.status).toBe('verified');
		expect(domain!.dnsRecords.dkim).toEqual([RSA_RECORD]);
		expect(domain!.verificationResults?.dkim).toEqual([{ verified: true, lastChecked: 1 }]);
	});

	it('refuses a domain another provider sends for, without calling the MTA', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedDomain(t, { providerType: 'ses' });

		await expect(t.action(api.domains.dkimEd25519.addKey, { domainId })).rejects.toThrow(
			/built-in MTA/
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('refuses a domain still being registered', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedDomain(t, { status: 'registering' });

		await expect(t.action(api.domains.dkimEd25519.addKey, { domainId })).rejects.toThrow(
			/still being registered/
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('refuses a member without organization:manage', async () => {
		requireOrgPermission.mockRejectedValue(new Error('forbidden'));
		const t = convexTest(schema, modules);
		const domainId = await seedDomain(t);

		await expect(t.action(api.domains.dkimEd25519.removeKey, { domainId })).rejects.toThrow(
			/forbidden/
		);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(requireOrgPermission).toHaveBeenCalledWith(
			expect.anything(),
			'organization:manage',
			expect.any(String)
		);
	});

	it('surfaces an MTA refusal and leaves the records alone', async () => {
		fetchMock.mockResolvedValue(respondJson({ error: 'Domain has no DKIM key' }, 404));
		const t = convexTest(schema, modules);
		const domainId = await seedDomain(t);

		await expect(t.action(api.domains.dkimEd25519.addKey, { domainId })).rejects.toThrow(/404/);
		expect((await row(t, domainId))!.dnsRecords.dkim).toEqual([RSA_RECORD]);
	});
});

describe('withOptionalDkimRecord', () => {
	const ed = { type: 'TXT' as const, host: 'e1._domainkey', value: 'v', optional: true };
	const pending = { ...RSA_RECORD, host: 's2._domainkey', rotationPending: true };
	const ok = { verified: true, lastChecked: 1 };

	it('keeps a re-added record result and stops results at the first gap', () => {
		expect(withOptionalDkimRecord([RSA_RECORD, ed], [ok, { ...ok, optional: true }], ed)).toEqual({
			dkim: [RSA_RECORD, ed],
			results: [ok, { ...ok, optional: true }],
		});
		expect(withOptionalDkimRecord([RSA_RECORD, pending], [ok], ed)).toEqual({
			dkim: [RSA_RECORD, pending, ed],
			results: [ok],
		});
		expect(withOptionalDkimRecord([RSA_RECORD, ed, pending], [ok, ok, ok], null)).toEqual({
			dkim: [RSA_RECORD, pending],
			results: [ok, ok],
		});
		expect(withOptionalDkimRecord([RSA_RECORD], undefined, ed).results).toBeUndefined();
	});
});
