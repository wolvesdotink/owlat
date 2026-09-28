/**
 * Blocklist lookups — the Convex relay between the admin card and the MTA.
 *
 * Pins the security half of the contract: only admins reach it, a malformed key
 * never leaves Convex, the key is relayed but never stored or returned, and a
 * saved change leaves an audit row that says THAT the key changed, not what it is.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { api } from '../../_generated/api';

const sessionMocks = vi.hoisted(() => ({
	session: null as { userId: string; role: 'owner' | 'admin' | 'editor' } | null,
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockImplementation(async () => {
			if (!sessionMocks.session) throw new Error('Not authenticated');
			return { userId: sessionMocks.session.userId, role: sessionMocks.session.role };
		}),
		requireOrgPermission: vi.fn().mockImplementation(async () => {
			const s = sessionMocks.session;
			if (!s) throw new Error('Not authenticated');
			if (s.role !== 'owner' && s.role !== 'admin') throw new Error('forbidden');
			return { userId: s.userId, role: s.role, activeOrganizationId: 'org-1' };
		}),
	};
});

// Vite resolves a `../../` glob from inside `delivery/` to `../` for this
// folder's own files, so they are re-keyed from the convex root.
const modules = {
	...import.meta.glob('../../**/*.*s'),
	...Object.fromEntries(
		Object.entries(import.meta.glob('../**/*.*s')).map(([path, module]) => [
			path.replace(/^\.\.\//, '../../delivery/'),
			module,
		])
	),
};

const KEY = 'abcdefghijklmnopqrstuvwxyz';
const ACCESS = {
	resolver: { configured: 'bundled' },
	spamhaus: { access: 'dqs', keyHint: 'wxyz', status: 'pending' },
};

const fetchMock = vi.fn();

function setup() {
	return convexTest(schema, modules).withIdentity({
		subject: 'test-admin',
		issuer: 'https://test.issuer.com',
		tokenIdentifier: 'https://test.issuer.com|test-admin',
	});
}

function reply(status: number, body: unknown) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

beforeEach(() => {
	sessionMocks.session = { userId: 'test-admin', role: 'owner' };
	vi.stubEnv('MTA_INTERNAL_URL', 'http://mta:3100/');
	vi.stubEnv('MTA_API_KEY', 'mta-master-key');
	fetchMock.mockReset();
	vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe('delivery.dnsblAccess.get', () => {
	it('reads the MTA state with the master key', async () => {
		fetchMock.mockResolvedValue(reply(200, ACCESS));
		const result = await setup().action(api.delivery.dnsblAccess.get, {});

		expect(result).toEqual({ status: 'ready', access: ACCESS });
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe('http://mta:3100/dnsbl-access');
		expect(init.headers.Authorization).toBe('Bearer mta-master-key');
	});

	it('reads an MTA that predates the endpoint, or none at all, as unavailable', async () => {
		fetchMock.mockResolvedValue(reply(404, { error: 'Not found' }));
		expect(await setup().action(api.delivery.dnsblAccess.get, {})).toEqual({
			status: 'unavailable',
		});

		vi.stubEnv('MTA_INTERNAL_URL', '');
		vi.stubEnv('MTA_API_URL', '');
		expect(await setup().action(api.delivery.dnsblAccess.get, {})).toEqual({
			status: 'unavailable',
		});
	});

	it('is closed to members who are not admins', async () => {
		sessionMocks.session = { userId: 'test-editor', role: 'editor' };
		await expect(setup().action(api.delivery.dnsblAccess.get, {})).rejects.toThrow();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe('delivery.dnsblAccess.setSpamhausKey', () => {
	it('relays the key, stores nothing of it, and audits the change', async () => {
		fetchMock.mockResolvedValue(reply(200, { ok: true, access: ACCESS }));
		const t = setup();
		const result = await t.action(api.delivery.dnsblAccess.setSpamhausKey, { key: ` ${KEY} ` });

		expect(result).toEqual({ ok: true, access: ACCESS });
		const [, init] = fetchMock.mock.calls[0]!;
		expect(init.method).toBe('PUT');
		expect(JSON.parse(init.body)).toEqual({ spamhausDqsKey: KEY });

		const audit = await t.run((ctx) => ctx.db.query('auditLogs').collect());
		expect(audit).toHaveLength(1);
		expect(audit[0]).toMatchObject({ action: 'settings.updated', resource: 'settings' });
		expect(JSON.parse(audit[0]!.detailsBlob!)).toEqual({ changes: { spamhausDqsKey: 'set' } });
		expect(JSON.stringify(audit)).not.toContain(KEY);
	});

	it('never sends a malformed key to the MTA', async () => {
		const result = await setup().action(api.delivery.dnsblAccess.setSpamhausKey, {
			key: 'abc.evil.example',
		});
		expect(result).toEqual({ ok: false, reason: 'invalid_key' });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('passes the MTA verdict through and writes no audit row when the key is refused', async () => {
		fetchMock.mockResolvedValue(reply(422, { ok: false, reason: 'key_rejected' }));
		const t = setup();
		const result = await t.action(api.delivery.dnsblAccess.setSpamhausKey, { key: KEY });

		expect(result).toEqual({ ok: false, reason: 'key_rejected' });
		expect(await t.run((ctx) => ctx.db.query('auditLogs').collect())).toHaveLength(0);
	});

	it('removes the key with null and records the removal', async () => {
		fetchMock.mockResolvedValue(
			reply(200, {
				ok: true,
				access: { ...ACCESS, spamhaus: { access: 'public', status: 'pending' } },
			})
		);
		const t = setup();
		await t.action(api.delivery.dnsblAccess.setSpamhausKey, { key: null });

		expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ spamhausDqsKey: null });
		const [audit] = await t.run((ctx) => ctx.db.query('auditLogs').collect());
		expect(JSON.parse(audit!.detailsBlob!)).toEqual({ changes: { spamhausDqsKey: 'removed' } });
	});

	it('says the MTA is unavailable when it cannot be reached', async () => {
		fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED'));
		expect(await setup().action(api.delivery.dnsblAccess.setSpamhausKey, { key: KEY })).toEqual({
			ok: false,
			reason: 'mta_unavailable',
		});
	});
});
