import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../_generated/api';
import schema from '../../schema';

// Authenticate authentically: the mocked session helpers reject anonymous
// callers (no identity) and non-admins (editor role), and return the caller's
// active organization so cross-tenant isolation is exercised with real data.
const auth = vi.hoisted(() => ({
	role: 'owner' as 'owner' | 'editor',
	organizationId: 'tenant-a',
	userId: 'user-a',
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const requireMember = async (ctx: { auth: { getUserIdentity(): Promise<unknown> } }) => {
		if (!(await ctx.auth.getUserIdentity())) throw new Error('unauthenticated');
		return { userId: auth.userId, role: auth.role, activeOrganizationId: auth.organizationId };
	};
	return {
		...(await vi.importActual('../../lib/sessionOrganization')),
		// authedMutation floor (any member) and the authedAction floor's
		// assertOrgMember both reject anonymous callers.
		requireOrgMember: vi.fn(requireMember),
		getMutationContext: vi.fn(requireMember),
		// The admin authorization gate: rejects anonymous and non-admin callers,
		// and returns the caller's active org for tenant scoping.
		requireOrgPermission: vi.fn(async (ctx: { auth: { getUserIdentity(): Promise<unknown> } }) => {
			if (!(await ctx.auth.getUserIdentity())) throw new Error('unauthenticated');
			if (auth.role === 'editor') throw new Error('forbidden');
			return { userId: auth.userId, role: auth.role, activeOrganizationId: auth.organizationId };
		}),
	};
});

vi.mock('../../plugins/plugins.generated', () => ({
	bundledPluginComposition: Object.freeze([
		Object.freeze({
			packageName: '@example/policy-pack',
			manifest: Object.freeze({
				id: 'policy-pack',
				version: '1.0.0',
				capabilities: Object.freeze([
					'mail:read',
					'send:gate',
					'plugin-storage:read',
					'plugin-storage:write',
				]),
				flag: Object.freeze({ default: false }),
			}),
		}),
	]),
}));

// Combine the whole-tree glob with the connectedApps subtree (rewritten to its
// convex-root-relative path) so convex-test can resolve the `'use node'` action
// modules in this folder — the same pattern the Sealed Mail node-action suites use.
const rootGlob = import.meta.glob('../../**/*.*s');
const localGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../connectedApps/'),
		mod,
	])
);
const modules = { ...rootGlob, ...localGlob };
const identity = {
	subject: 'user-a',
	issuer: 'https://test.issuer.example',
	tokenIdentifier: 'https://test.issuer.example|user-a',
};

const VALID_REGISTER = {
	pluginId: 'policy-pack',
	name: 'Slack approvals',
	endpointUrl: 'https://hooks.example.com/owlat',
	grantedCapabilities: ['send:gate'],
};

beforeEach(() => {
	vi.stubEnv('INSTANCE_SECRET', 'connected-app-endpoint-test-secret');
	auth.role = 'owner';
	auth.organizationId = 'tenant-a';
	auth.userId = 'user-a';
});
afterEach(() => vi.unstubAllEnvs());

function client() {
	return convexTest(schema, modules).withIdentity(identity);
}

async function register(t: ReturnType<typeof client>, overrides: Record<string, unknown> = {}) {
	return t.action(api.connectedApps.actions.register, { ...VALID_REGISTER, ...overrides });
}

describe('connected-app registration and secret exchange', () => {
	it('registers an enabled app, reveals the secret once, and seals it at rest', async () => {
		const t = client();
		const created = await register(t);
		expect(created.status).toBe('enabled');
		expect(created.pluginId).toBe('policy-pack');
		expect(created.grantedCapabilities).toEqual(['send:gate']);
		expect(typeof created.secret).toBe('string');
		expect(created.secret.startsWith('cah_')).toBe(true);
		// The public projection carries no secret material.
		expect(created).not.toHaveProperty('secretCiphertext');

		await t.run(async (ctx) => {
			const row = await ctx.db.get(created._id);
			expect(row).not.toBeNull();
			// The plaintext secret is nowhere in the stored row.
			expect(JSON.stringify(row)).not.toContain(created.secret);
			expect(row!.secretCiphertext.length).toBeGreaterThan(0);
			expect(row!.organizationId).toBe('tenant-a');
		});
	});

	it('never returns the sealed secret through any read path', async () => {
		const t = client();
		const created = await register(t);
		const fetched = await t.query(api.connectedApps.queries.get, { connectedAppId: created._id });
		expect(fetched).not.toHaveProperty('secretCiphertext');
		expect(fetched).not.toHaveProperty('secret');
		expect(JSON.stringify(fetched)).not.toContain(created.secret);
		const listed = await t.query(api.connectedApps.queries.listByTeam, {});
		expect(JSON.stringify(listed)).not.toContain(created.secret);
		expect(listed[0]).not.toHaveProperty('secretCiphertext');
	});

	it('never writes the plaintext secret to a console sink', async () => {
		const spies = [
			vi.spyOn(console, 'info').mockImplementation(() => {}),
			vi.spyOn(console, 'warn').mockImplementation(() => {}),
			vi.spyOn(console, 'error').mockImplementation(() => {}),
			vi.spyOn(console, 'log').mockImplementation(() => {}),
		];
		try {
			const t = client();
			const created = await register(t);
			const rotated = await t.action(api.connectedApps.actions.rotateSecret, {
				connectedAppId: created._id,
			});
			const logged = spies.flatMap((s) => s.mock.calls.flat().map((a) => JSON.stringify(a)));
			for (const line of logged) {
				expect(line).not.toContain(created.secret);
				expect(line).not.toContain(rotated.secret);
			}
		} finally {
			spies.forEach((s) => s.mockRestore());
		}
	});

	it.each([
		['unknown plugin', { pluginId: 'ghost-plugin' }],
		['a capability the plugin does not declare', { grantedCapabilities: ['send:force'] }],
		['a non-https endpoint', { endpointUrl: 'http://hooks.example.com/owlat' }],
		['an endpoint embedding credentials', { endpointUrl: 'https://user:pw@hooks.example.com' }],
		['a malformed endpoint', { endpointUrl: 'not a url' }],
		['an empty name', { name: '   ' }],
	])('rejects registration with %s', async (_label, overrides) => {
		const t = client();
		await expect(register(t, overrides)).rejects.toThrow();
		await t.run(async (ctx) => {
			expect(await ctx.db.query('connectedApps').collect()).toHaveLength(0);
		});
	});

	it('denies registration to a non-admin member', async () => {
		auth.role = 'editor';
		const t = client();
		await expect(register(t)).rejects.toThrow();
	});

	it('rejects an anonymous caller with no identity', async () => {
		const anon = convexTest(schema, modules);
		await expect(anon.action(api.connectedApps.actions.register, VALID_REGISTER)).rejects.toThrow();
	});
});

describe('connected-app lifecycle transitions', () => {
	it('walks disable → enable → revoke and fails closed on illegal edges', async () => {
		const t = client();
		const app = await register(t);
		const id = { connectedAppId: app._id };

		// enable on an enabled app is an illegal no-op.
		await expect(t.mutation(api.connectedApps.mutations.enable, id)).rejects.toThrow();

		await t.mutation(api.connectedApps.mutations.disable, id);
		expect((await t.query(api.connectedApps.queries.get, id)).status).toBe('disabled');
		// disable on a disabled app is illegal.
		await expect(t.mutation(api.connectedApps.mutations.disable, id)).rejects.toThrow();

		await t.mutation(api.connectedApps.mutations.enable, id);
		expect((await t.query(api.connectedApps.queries.get, id)).status).toBe('enabled');

		await t.mutation(api.connectedApps.mutations.revoke, id);
		const revoked = await t.query(api.connectedApps.queries.get, id);
		expect(revoked.status).toBe('revoked');
		expect(revoked.revokedAt).toBeGreaterThan(0);

		// revoked is terminal: no further transition is legal.
		await expect(t.mutation(api.connectedApps.mutations.enable, id)).rejects.toThrow();
		await expect(t.mutation(api.connectedApps.mutations.disable, id)).rejects.toThrow();
		await expect(t.mutation(api.connectedApps.mutations.revoke, id)).rejects.toThrow();
	});

	it('rotates the sealed secret and refuses to rotate a revoked app', async () => {
		const t = client();
		const app = await register(t);
		const before = await t.run(async (ctx) => (await ctx.db.get(app._id))!);

		const rotated = await t.action(api.connectedApps.actions.rotateSecret, {
			connectedAppId: app._id,
		});
		expect(rotated.secret).not.toBe(app.secret);

		const after = await t.run(async (ctx) => (await ctx.db.get(app._id))!);
		expect(after.secretCiphertext).not.toBe(before.secretCiphertext);
		expect(after.secretRotatedAt).toBeGreaterThanOrEqual(before.secretRotatedAt);

		await t.mutation(api.connectedApps.mutations.revoke, { connectedAppId: app._id });
		await expect(
			t.action(api.connectedApps.actions.rotateSecret, { connectedAppId: app._id })
		).rejects.toThrow();
	});

	it('deletes the record from any status', async () => {
		const t = client();
		const app = await register(t);
		await t.mutation(api.connectedApps.mutations.remove, { connectedAppId: app._id });
		await t.run(async (ctx) => {
			expect(await ctx.db.get(app._id)).toBeNull();
		});
	});

	it('denies lifecycle transitions to a non-admin member', async () => {
		const t = client();
		const app = await register(t);
		auth.role = 'editor';
		await expect(
			t.mutation(api.connectedApps.mutations.disable, { connectedAppId: app._id })
		).rejects.toThrow();
	});
});

describe('connected-app tenant isolation', () => {
	it('denies read and lifecycle access to another tenant with a not_found', async () => {
		const t = client();
		const app = await register(t);

		// Switch the caller's active organization to a different tenant.
		auth.organizationId = 'tenant-b';
		auth.userId = 'user-b';
		await expect(
			t.query(api.connectedApps.queries.get, { connectedAppId: app._id })
		).rejects.toThrow();
		await expect(
			t.mutation(api.connectedApps.mutations.revoke, { connectedAppId: app._id })
		).rejects.toThrow();
		await expect(
			t.mutation(api.connectedApps.mutations.remove, { connectedAppId: app._id })
		).rejects.toThrow();
		await expect(
			t.action(api.connectedApps.actions.rotateSecret, { connectedAppId: app._id })
		).rejects.toThrow();

		// tenant-b sees an empty list; the row is untouched under tenant-a.
		expect(await t.query(api.connectedApps.queries.listByTeam, {})).toHaveLength(0);
		auth.organizationId = 'tenant-a';
		auth.userId = 'user-a';
		expect((await t.query(api.connectedApps.queries.get, { connectedAppId: app._id })).status).toBe(
			'enabled'
		);
	});

	it('scopes listByTeam to the active organization', async () => {
		const t = client();
		await register(t, { name: 'A app' });
		auth.organizationId = 'tenant-b';
		await register(t, { name: 'B app' });

		const bList = await t.query(api.connectedApps.queries.listByTeam, {});
		expect(bList.map((a) => a.name)).toEqual(['B app']);
		auth.organizationId = 'tenant-a';
		const aList = await t.query(api.connectedApps.queries.listByTeam, {});
		expect(aList.map((a) => a.name)).toEqual(['A app']);
	});
});

describe('connected-app audit coverage', () => {
	it('audits every lifecycle event under resource connected_app without the secret', async () => {
		const t = client();
		const app = await register(t);
		const id = { connectedAppId: app._id };
		await t.action(api.connectedApps.actions.rotateSecret, id);
		await t.mutation(api.connectedApps.mutations.disable, id);
		await t.mutation(api.connectedApps.mutations.enable, id);
		await t.mutation(api.connectedApps.mutations.revoke, id);
		await t.mutation(api.connectedApps.mutations.remove, id);

		const rows = await t.run(async (ctx) =>
			ctx.db
				.query('auditLogs')
				.filter((q) => q.eq(q.field('resource'), 'connected_app'))
				.collect()
		);
		const actions = rows.map((r) => r.action).sort();
		expect(actions).toEqual(
			[
				'connected_app.registered',
				'connected_app.secret_rotated',
				'connected_app.disabled',
				'connected_app.enabled',
				'connected_app.revoked',
				'connected_app.deleted',
			].sort()
		);
		expect(rows.every((r) => r.organizationId === 'tenant-a' && r.pluginId === 'policy-pack')).toBe(
			true
		);
		expect(JSON.stringify(rows)).not.toContain(app.secret);
	});
});

describe('connected-app internal mutation self-protection', () => {
	it('re-gates the secret-bearing insert on owner/admin even when called directly', async () => {
		auth.role = 'editor';
		const t = client();
		await expect(
			t.mutation(internal.connectedApps.mutations._insertConnectedApp, {
				pluginId: 'policy-pack',
				name: 'Direct',
				endpointUrl: 'https://hooks.example.com/x',
				grantedCapabilities: ['send:gate'],
				secretCiphertext: 'x',
				secretIv: 'y',
				secretAuthTag: 'z',
				secretEnvelopeVersion: 1,
			})
		).rejects.toThrow();
	});
});
