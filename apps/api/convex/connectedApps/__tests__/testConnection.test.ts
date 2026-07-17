/**
 * Connected-app connection test (Tier 2). The probe must:
 *   - route every request through the SSRF-guarded fetch (never a raw fetch);
 *   - map 2xx → ok, non-2xx → reachable-but-error, and any throw/timeout →
 *     a fail-closed `unreachable` (the action never propagates the throw);
 *   - refuse a revoked app before making ANY network request;
 *   - stay owner/admin-gated and tenant-scoped (delegated to the internal query).
 *
 * `fetchGuarded` is mocked so outcomes are deterministic without real network or
 * DNS; the SSRF guard itself is covered by lib/__tests__/ssrfGuard tests. That
 * the probe calls `fetchGuarded` (not bare `fetch`) with an https-only protocol
 * list is asserted here, pinning that the guard is on the path.
 */
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../_generated/api';
import schema from '../../schema';

const auth = vi.hoisted(() => ({
	role: 'owner' as 'owner' | 'editor',
	organizationId: 'tenant-a',
	userId: 'user-a',
}));

// The connection-test probe's fetch behavior, swapped per test.
const probe = vi.hoisted(() => ({
	fetchGuarded: vi.fn(),
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const requireMember = async (ctx: { auth: { getUserIdentity(): Promise<unknown> } }) => {
		if (!(await ctx.auth.getUserIdentity())) throw new Error('unauthenticated');
		return { userId: auth.userId, role: auth.role, activeOrganizationId: auth.organizationId };
	};
	return {
		...(await vi.importActual('../../lib/sessionOrganization')),
		requireOrgMember: vi.fn(requireMember),
		getMutationContext: vi.fn(requireMember),
		requireOrgPermission: vi.fn(async (ctx: { auth: { getUserIdentity(): Promise<unknown> } }) => {
			if (!(await ctx.auth.getUserIdentity())) throw new Error('unauthenticated');
			if (auth.role === 'editor') throw new Error('forbidden');
			return { userId: auth.userId, role: auth.role, activeOrganizationId: auth.organizationId };
		}),
	};
});

// Keep readCappedBytes / CappedReadOverflow real (they cope with a null body);
// only fetchGuarded is stubbed so the probe never touches the network.
vi.mock('../../lib/ssrfGuard', async () => ({
	...(await vi.importActual('../../lib/ssrfGuard')),
	fetchGuarded: probe.fetchGuarded,
}));

vi.mock('../../plugins/plugins.generated', () => ({
	bundledPluginComposition: Object.freeze([
		Object.freeze({
			packageName: '@example/policy-pack',
			manifest: Object.freeze({
				id: 'policy-pack',
				version: '1.0.0',
				capabilities: Object.freeze(['send:gate']),
				flag: Object.freeze({ default: false }),
			}),
		}),
	]),
}));

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

function fakeResponse(status: number): Response {
	return { status, body: null, headers: new Headers() } as unknown as Response;
}

beforeEach(() => {
	vi.stubEnv('INSTANCE_SECRET', 'connected-app-connection-test-secret');
	auth.role = 'owner';
	auth.organizationId = 'tenant-a';
	auth.userId = 'user-a';
	probe.fetchGuarded.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

function client() {
	return convexTest(schema, modules).withIdentity(identity);
}

async function register(t: ReturnType<typeof client>, overrides: Record<string, unknown> = {}) {
	return t.action(api.connectedApps.actions.register, { ...VALID_REGISTER, ...overrides });
}

describe('connected-app connection test', () => {
	it('reports ok on a 2xx response and routes through the SSRF guard', async () => {
		probe.fetchGuarded.mockResolvedValue(fakeResponse(204));
		const t = client();
		const app = await register(t);
		const result = await t.action(api.connectedApps.actions.testConnection, {
			connectedAppId: app._id,
		});
		expect(result.outcome).toBe('ok');
		expect(result.status).toBe(204);

		// The probe went through fetchGuarded (SSRF-guarded), targeting the app's
		// endpoint with an https-only protocol allowlist and a self-identifying,
		// non-hook test header.
		expect(probe.fetchGuarded).toHaveBeenCalledTimes(1);
		const [url, init] = probe.fetchGuarded.mock.calls[0]!;
		expect(url).toBe('https://hooks.example.com/owlat');
		expect(init.protocols).toEqual(['https:']);
		expect(init.method).toBe('POST');
		expect((init.headers as Record<string, string>)['x-owlat-connection-test']).toBe('1');
	});

	it('reports error_status when the endpoint answers non-2xx', async () => {
		probe.fetchGuarded.mockResolvedValue(fakeResponse(503));
		const t = client();
		const app = await register(t);
		const result = await t.action(api.connectedApps.actions.testConnection, {
			connectedAppId: app._id,
		});
		expect(result.outcome).toBe('error_status');
		expect(result.status).toBe(503);
	});

	it('fails closed to unreachable when the fetch throws', async () => {
		probe.fetchGuarded.mockRejectedValue(new Error('network down'));
		const t = client();
		const app = await register(t);
		const result = await t.action(api.connectedApps.actions.testConnection, {
			connectedAppId: app._id,
		});
		expect(result.outcome).toBe('unreachable');
		expect(result.status).toBeNull();
	});

	it('reports a timeout distinctly on an AbortSignal.timeout rejection', async () => {
		const timeoutError = new Error('The operation timed out');
		timeoutError.name = 'TimeoutError';
		probe.fetchGuarded.mockRejectedValue(timeoutError);
		const t = client();
		const app = await register(t);
		const result = await t.action(api.connectedApps.actions.testConnection, {
			connectedAppId: app._id,
		});
		expect(result.outcome).toBe('unreachable');
		expect(result.message.toLowerCase()).toContain('timed out');
	});

	it('refuses a revoked app without making any network request', async () => {
		const t = client();
		const app = await register(t);
		await t.mutation(api.connectedApps.mutations.revoke, { connectedAppId: app._id });
		const result = await t.action(api.connectedApps.actions.testConnection, {
			connectedAppId: app._id,
		});
		expect(result.outcome).toBe('blocked');
		expect(probe.fetchGuarded).not.toHaveBeenCalled();
	});

	it('can test a disabled app (operator verifies before re-enabling)', async () => {
		probe.fetchGuarded.mockResolvedValue(fakeResponse(200));
		const t = client();
		const app = await register(t);
		await t.mutation(api.connectedApps.mutations.disable, { connectedAppId: app._id });
		const result = await t.action(api.connectedApps.actions.testConnection, {
			connectedAppId: app._id,
		});
		expect(result.outcome).toBe('ok');
		expect(probe.fetchGuarded).toHaveBeenCalledTimes(1);
	});

	it('denies the connection test to a non-admin member', async () => {
		const t = client();
		const app = await register(t);
		auth.role = 'editor';
		await expect(
			t.action(api.connectedApps.actions.testConnection, { connectedAppId: app._id })
		).rejects.toThrow();
		expect(probe.fetchGuarded).not.toHaveBeenCalled();
	});

	it('denies the connection test across tenants with a not_found', async () => {
		const t = client();
		const app = await register(t);
		auth.organizationId = 'tenant-b';
		auth.userId = 'user-b';
		await expect(
			t.action(api.connectedApps.actions.testConnection, { connectedAppId: app._id })
		).rejects.toThrow();
		expect(probe.fetchGuarded).not.toHaveBeenCalled();
	});
});
