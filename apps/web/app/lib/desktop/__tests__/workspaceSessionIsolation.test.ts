import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WorkspaceConfig, WorkspaceStoreShape } from '~/lib/desktop/workspaceTypes';
import { createFakeSessionKeychain } from './fakeSessionKeychain';

// Each desktop workspace client owns its session storage and keychain entry.
// Driven with the REAL better-auth client and cross-domain plugin, the real
// storage, workspace list and connect handshake; only the network, the Tauri
// bridges and the page navigation are fakes. The workspace this window is
// signed in to keeps working (session checks, Convex token refreshes) while a
// second workspace is being connected.

const keychain = createFakeSessionKeychain();
const keychainEntries = keychain.entries;
vi.mock('@owlat/desktop/src/keychain', () => keychain.bridge);

let savedStore: WorkspaceStoreShape = { workspaces: [], activeWorkspaceId: null };
vi.mock('@owlat/desktop/src/workspace', () => ({
	loadWorkspaceStore: async () => JSON.parse(JSON.stringify(savedStore)),
	saveWorkspaceStore: async (next: WorkspaceStoreShape) => {
		savedStore = JSON.parse(JSON.stringify(next));
	},
}));

vi.mock('@owlat/desktop/src/shell', () => ({ openExternal: vi.fn(async () => {}) }));
vi.mock('~/lib/desktop/workspaceAccent', () => ({ applyWorkspaceAccent: vi.fn() }));

const A: WorkspaceConfig = {
	id: 'ws-a',
	label: 'A',
	siteUrl: 'https://a.example.com',
	convexUrl: 'https://a.example.com/convex',
	convexSiteUrl: 'https://site.a.example.com',
	userId: 'user-a',
	tokenRef: 'owlat-ws:ws-a',
	addedAt: 1,
	lastActiveAt: 1,
	accentColor: '#8c5a7a',
};
const A_INFO = {
	name: 'A',
	siteUrl: A.siteUrl,
	convexUrl: A.convexUrl,
	convexSiteUrl: A.convexSiteUrl,
	deploymentMode: 'selfhost',
};
const B_INFO = {
	name: 'B',
	siteUrl: 'https://b.example.com',
	convexUrl: 'https://b.example.com/convex',
	convexSiteUrl: 'https://site.b.example.com',
	deploymentMode: 'selfhost',
};

/** A's persisted session, as the cross-domain plugin stores it. */
const A_BLOB = JSON.stringify({
	'better-auth_cookie': JSON.stringify({
		'better-auth.session_token': { value: 'A-session', expires: null },
	}),
});

interface SeenRequest {
	url: string;
	cookie: string;
}

const seen: SeenRequest[] = [];
/** What A's server answers to a session check: the session, or `null` (gone). */
let aSession: unknown = { user: { id: 'user-a' }, session: { id: 's-a' } };
/** Runs while B's one-time token is being redeemed, to overlap A's traffic. */
let duringRedeem: () => Promise<void> = async () => {};
/** Runs while B's new session is being checked (B's session already received). */
let duringSessionCheck: () => Promise<void> = async () => {};

function json(body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json', ...headers },
	});
}

const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
	const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : {}));
	seen.push({ url, cookie: headers.get('Better-Auth-Cookie') ?? '' });

	if (url === 'https://a.example.com/api/instance-info') return json(A_INFO);
	if (url === 'https://b.example.com/api/instance-info') return json(B_INFO);
	if (url.startsWith('https://site.a.example.com/api/auth/cross-domain/one-time-token/verify')) {
		return json(
			{ token: 'A-new-session' },
			{
				'set-better-auth-cookie': 'better-auth.session_token=A-new-session; Max-Age=3600; Path=/',
			}
		);
	}
	if (url.startsWith('https://site.b.example.com/api/auth/cross-domain/one-time-token/verify')) {
		await duringRedeem();
		return json(
			{ token: 'B-session' },
			{ 'set-better-auth-cookie': 'better-auth.session_token=B-session; Max-Age=3600; Path=/' }
		);
	}
	if (url.startsWith('https://site.b.example.com/api/auth/get-session')) {
		await duringSessionCheck();
		return json({ user: { id: 'user-b' }, session: { id: 's-b' } });
	}
	if (url.startsWith('https://site.a.example.com/api/auth/get-session')) return json(aSession);
	if (url.startsWith('https://site.a.example.com/api/auth/convex/token')) {
		return json({ token: null });
	}
	return new Response('not found', { status: 404 });
});

type Modules = Awaited<ReturnType<typeof bootWithA>>;

/** A fresh page load signed in to A, as the boot plugin leaves it. */
async function bootWithA() {
	vi.resetModules();
	const workspaces = await import('~/composables/useDesktopWorkspaces');
	const authClientModule = await import('~/lib/auth-client');
	const convexAuth = await import('~/lib/convex-auth');
	const connect = await import('~/lib/desktop/workspaceConnect');
	const storage = await import('~/lib/desktop/keychainStorage');
	await workspaces.loadWorkspaces();
	return { ...workspaces, ...authClientModule, ...convexAuth, ...connect, ...storage };
}

/** Start connecting B the way the connect screen does; returns the handshake state. */
async function beginConnectingB(mod: Modules): Promise<string> {
	await mod.addWorkspace('https://b.example.com');
	const { openExternal } = await import('@owlat/desktop/src/shell');
	const opened = new URL(vi.mocked(openExternal).mock.calls.at(-1)?.[0] as string);
	return opened.searchParams.get('state') as string;
}

const cookiesSentTo = (origin: string) =>
	seen.filter((r) => r.url.startsWith(origin)).map((r) => r.cookie);

let assign: ReturnType<typeof vi.fn>;

beforeEach(() => {
	(window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
	window.localStorage.clear();
	keychain.reset();
	keychainEntries.set(A.tokenRef, A_BLOB);
	savedStore = { workspaces: [A], activeWorkspaceId: A.id };
	seen.length = 0;
	aSession = { user: { id: 'user-a' }, session: { id: 's-a' } };
	duringRedeem = async () => {};
	duringSessionCheck = async () => {};
	vi.stubGlobal('fetch', fakeFetch);
	assign = vi.fn();
	Object.defineProperty(window.location, 'assign', {
		value: assign,
		configurable: true,
		writable: true,
	});
});

// Not `vi.unstubAllGlobals()`: the setup file's Nuxt auto-import stubs must stay.
afterEach(() => {
	delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
});

describe('desktop workspace session isolation', () => {
	it("keeps the active workspace's requests on its own session while another connects", async () => {
		const mod = await bootWithA();
		const state = await beginConnectingB(mod);
		const overlapA = async () => {
			await mod.authClient.getSession({ query: { disableCookieCache: true } });
			await mod.getConvexAuthToken(true);
		};
		duringRedeem = overlapA;
		duringSessionCheck = overlapA;

		await mod.completeConnection({ ott: 'one-time', state });
		// And after B's session exists in this page, A still sends only its own.
		await mod.authClient.getSession({ query: { disableCookieCache: true } });
		await mod.getConvexAuthToken(true);

		const toA = cookiesSentTo('https://site.a.example.com');
		expect(toA.length).toBeGreaterThanOrEqual(6);
		for (const cookie of toA) {
			expect(cookie).toContain('A-session');
			expect(cookie).not.toContain('B-session');
		}
		for (const cookie of cookiesSentTo('https://site.b.example.com')) {
			expect(cookie).not.toContain('A-session');
		}
		expect(assign).toHaveBeenCalledWith('/dashboard');
	});

	it("does not let the active workspace's signed-out answer touch the new session", async () => {
		const mod = await bootWithA();
		const state = await beginConnectingB(mod);
		aSession = null;
		duringSessionCheck = async () => {
			await mod.authClient.getSession({ query: { disableCookieCache: true } });
		};

		await mod.completeConnection({ ott: 'one-time', state });

		// A's server did answer A's session check, with "signed out".
		expect(cookiesSentTo('https://site.a.example.com')).toHaveLength(1);
		const bEntry = [...keychainEntries.entries()].find(([key]) => key !== A.tokenRef);
		expect(bEntry?.[1]).toContain('B-session');
		expect(bEntry?.[1]).not.toContain('A-session');
		// A's own entry was cleared by A's own answer, and holds nothing of B.
		for (const [key, blob] of keychain.sessionWrite.mock.calls) {
			if (key === A.tokenRef) expect(blob).not.toContain('B-session');
		}
		expect(savedStore.activeWorkspaceId).toBe(bEntry?.[0].replace('owlat-ws:', ''));
	});

	it('keeps the active session in memory and on disk when a connection fails', async () => {
		const mod = await bootWithA();
		const state = await beginConnectingB(mod);
		fakeFetch.mockImplementationOnce(async () => new Response('gone', { status: 500 }));

		await expect(mod.completeConnection({ ott: 'one-time', state })).rejects.toThrow();
		await mod.authClient.getSession({ query: { disableCookieCache: true } });

		expect(cookiesSentTo('https://site.a.example.com').at(-1)).toContain('A-session');
		expect(keychainEntries.get(A.tokenRef)).toBe(A_BLOB);
		expect([...keychainEntries.keys()]).toEqual([A.tokenRef]);
		expect(savedStore).toEqual({ workspaces: [A], activeWorkspaceId: A.id });
	});
});

/**
 * Signing in to the active workspace again from the main window while a
 * compose window is open on it. Compose is a second webview: its own module
 * graph, auth client and storage for the same keychain entry, and the same
 * native keychain.
 */
describe('desktop session replacement across windows', () => {
	async function reauthenticateAInMain() {
		const compose = await bootWithA();
		const main = await bootWithA();
		await main.addWorkspace(A.siteUrl);
		const { openExternal } = await import('@owlat/desktop/src/shell');
		const opened = new URL(vi.mocked(openExternal).mock.calls.at(-1)?.[0] as string);
		await main.completeConnection({
			ott: 'one-time',
			state: opened.searchParams.get('state') as string,
		});
		expect(keychainEntries.get(A.tokenRef)).toContain('A-new-session');
		return { compose, main };
	}

	async function composeSessionCheck(compose: Modules) {
		await compose.authClient.getSession({ query: { disableCookieCache: true } });
		await compose.getActiveKeychainStorage()?.flush();
	}

	it('an open compose window moves to the new session', async () => {
		const { compose } = await reauthenticateAInMain();

		await composeSessionCheck(compose);

		expect(keychainEntries.get(A.tokenRef)).toContain('A-new-session');
		expect(keychainEntries.get(A.tokenRef)).not.toContain('"A-session"');
		expect(cookiesSentTo('https://site.a.example.com/api/auth/get-session').at(-1)).toContain(
			'A-new-session'
		);
	});

	it('a compose window that missed the change cannot write the older session back', async () => {
		keychain.setDeliverEvents(false);
		const { compose } = await reauthenticateAInMain();

		await composeSessionCheck(compose);

		expect(keychainEntries.get(A.tokenRef)).toContain('A-new-session');
		expect(keychainEntries.get(A.tokenRef)).not.toContain('"A-session"');
		// Its refused write made it read the new session, which it uses from then on.
		await compose.authClient.getSession({ query: { disableCookieCache: true } });
		expect(cookiesSentTo('https://site.a.example.com/api/auth/get-session').at(-1)).toContain(
			'A-new-session'
		);
	});

	it("a signed-out answer to compose's older session does not clear the new one", async () => {
		keychain.setDeliverEvents(false);
		const { compose } = await reauthenticateAInMain();
		aSession = null;

		await composeSessionCheck(compose);

		expect(keychainEntries.get(A.tokenRef)).toContain('A-new-session');
	});
});
