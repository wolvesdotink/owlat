import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The boot warm-up (plugins/0.auth-warmup.client.ts) starts the Convex token
 * fetch before the Convex client exists. These cases pin that the client's own
 * first fetch then reuses that request, whatever it answered, instead of
 * issuing a second one.
 */

vi.mock('~/lib/auth-client', () => ({ authClient: {} }));

function jwt(expiresInSeconds: number): string {
	const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expiresInSeconds }));
	return `header.${payload}.signature`;
}

function deferredResponse() {
	let resolve!: (body: { token: string | null }) => void;
	const response = new Promise<Response>((done) => {
		resolve = (body) => done(new Response(JSON.stringify(body), { status: 200 }));
	});
	return { response, resolve };
}

async function loadModule() {
	vi.resetModules();
	return import('~/lib/convex-auth');
}

describe('convex auth token warm-up', () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('starts one request, and the first caller joins it while in flight', async () => {
		const pending = deferredResponse();
		fetchMock.mockReturnValueOnce(pending.response);
		const auth = await loadModule();

		auth.warmConvexAuthToken();
		auth.warmConvexAuthToken();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock).toHaveBeenCalledWith('/api/auth/convex/token', expect.anything());

		const first = auth.getConvexAuthToken();
		const second = auth.getConvexAuthToken();
		const token = jwt(3600);
		pending.resolve({ token });

		await expect(first).resolves.toBe(token);
		await expect(second).resolves.toBe(token);
		await expect(auth.getConvexAuthToken()).resolves.toBe(token);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('hands a settled signed-out answer to the first caller instead of asking again', async () => {
		fetchMock.mockResolvedValue(new Response(JSON.stringify({ token: null }), { status: 200 }));
		const auth = await loadModule();

		auth.warmConvexAuthToken();
		await new Promise((resolve) => setTimeout(resolve, 0));

		await expect(auth.getConvexAuthToken()).resolves.toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// Only once: the next caller asks the server again, as it always did.
		fetchMock.mockResolvedValue(new Response(JSON.stringify({ token: null }), { status: 200 }));
		await expect(auth.getConvexAuthToken()).resolves.toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('does not hand the warm-up answer to a forced refresh', async () => {
		fetchMock.mockResolvedValue(new Response(JSON.stringify({ token: null }), { status: 200 }));
		const auth = await loadModule();

		auth.warmConvexAuthToken();
		await new Promise((resolve) => setTimeout(resolve, 0));

		const token = jwt(3600);
		fetchMock.mockResolvedValue(new Response(JSON.stringify({ token }), { status: 200 }));
		await expect(auth.getConvexAuthToken(true)).resolves.toBe(token);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('drops the warm-up answer on a cache reset (sign-in, session change)', async () => {
		fetchMock.mockResolvedValue(new Response(JSON.stringify({ token: null }), { status: 200 }));
		const auth = await loadModule();

		auth.warmConvexAuthToken();
		await new Promise((resolve) => setTimeout(resolve, 0));
		auth.resetConvexAuthTokenCache();

		const token = jwt(3600);
		fetchMock.mockResolvedValue(new Response(JSON.stringify({ token }), { status: 200 }));
		await expect(auth.getConvexAuthToken()).resolves.toBe(token);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('does not start a second request when one is already in flight', async () => {
		const pending = deferredResponse();
		fetchMock.mockReturnValueOnce(pending.response);
		const auth = await loadModule();

		const inFlight = auth.getConvexAuthToken();
		auth.warmConvexAuthToken();
		expect(fetchMock).toHaveBeenCalledTimes(1);

		const token = jwt(3600);
		pending.resolve({ token });
		await expect(inFlight).resolves.toBe(token);
	});

	it('keeps the token in memory only', async () => {
		const token = jwt(3600);
		fetchMock.mockResolvedValue(new Response(JSON.stringify({ token }), { status: 200 }));
		const auth = await loadModule();

		auth.warmConvexAuthToken();
		await expect(auth.getConvexAuthToken()).resolves.toBe(token);

		const stored = [...Object.values({ ...sessionStorage }), ...Object.values({ ...localStorage })];
		expect(stored.some((value) => String(value).includes(token))).toBe(false);
		expect(document.cookie).not.toContain(token);
	});
});
