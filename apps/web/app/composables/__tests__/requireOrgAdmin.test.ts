import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConvexError } from 'convex/values';

/**
 * Server-gate tests for `requireOrgAdmin` (the `organization:manage` floor
 * behind `POST /api/delivery/apply-transport`). We stub the h3/Nuxt request
 * helpers and mock the Convex client so the gate's control flow is exercised in
 * isolation:
 *   - 401 when the request carries no session cookie;
 *   - 403 when the admin probe is denied (`forbidden` Operation error);
 *   - 503 (NOT 403) when the probe fails for a non-authz reason — an outage must
 *     surface honestly instead of masquerading as a permission denial.
 */

const mockQuery = vi.fn();

vi.mock('convex/browser', () => ({
	ConvexHttpClient: class {
		setAuth(): void {}
		query(...args: unknown[]): unknown {
			return mockQuery(...args);
		}
	},
}));

vi.mock('@owlat/api', () => ({
	api: { delivery: { status: { getStatus: {} } } },
}));

let cookie: string | undefined;

beforeEach(() => {
	cookie = 'better-auth.session=abc';
	mockQuery.mockReset();

	vi.stubGlobal('useRuntimeConfig', () => ({ public: { convexUrl: 'https://convex.test' } }));
	vi.stubGlobal('getHeader', (_event: unknown, name: string) =>
		name === 'cookie' ? cookie : undefined
	);
	vi.stubGlobal('getRequestHost', () => 'localhost:3000');
	vi.stubGlobal('getRequestProtocol', () => 'http');
	vi.stubGlobal('createError', (opts: { statusCode: number; message: string }) =>
		Object.assign(new Error(opts.message), { statusCode: opts.statusCode })
	);
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => ({ ok: true, json: async () => ({ token: 'jwt' }) }))
	);
});

async function importGate() {
	const mod = await import('../../../server/utils/requireOrgAdmin');
	return mod.requireOrgAdmin;
}

describe('requireOrgAdmin', () => {
	it('throws 401 when there is no session cookie', async () => {
		cookie = undefined;
		const requireOrgAdmin = await importGate();
		await expect(requireOrgAdmin({} as never)).rejects.toMatchObject({ statusCode: 401 });
		expect(mockQuery).not.toHaveBeenCalled();
	});

	it('throws 403 when the admin probe is denied (forbidden)', async () => {
		mockQuery.mockRejectedValue(
			new ConvexError({ category: 'forbidden', message: 'no permission' })
		);
		const requireOrgAdmin = await importGate();
		await expect(requireOrgAdmin({} as never)).rejects.toMatchObject({ statusCode: 403 });
	});

	it('surfaces a non-authz probe failure as 503, not 403', async () => {
		mockQuery.mockRejectedValue(new Error('Convex query subscription timed out'));
		const requireOrgAdmin = await importGate();
		await expect(requireOrgAdmin({} as never)).rejects.toMatchObject({ statusCode: 503 });
	});

	it('returns the authed client when the probe succeeds', async () => {
		mockQuery.mockResolvedValue({ canSend: true });
		const requireOrgAdmin = await importGate();
		await expect(requireOrgAdmin({} as never)).resolves.toBeDefined();
	});
});
