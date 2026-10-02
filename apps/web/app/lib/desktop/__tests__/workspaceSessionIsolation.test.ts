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
/**
 * Holds A's next session check until released, and answers it with what the
 * release passes: a body, and optionally the session cookie A's server sets.
 */
let heldACheck: {
	sent: Promise<void>;
	markSent: () => void;
	release: (body: unknown, setCookie?: string) => void;
	answer: Promise<{ body: unknown; setCookie?: string }>;
	/** Streamed: the headers (with this cookie, if any) go out at once, the body on release. */
	streamed?: { setCookie?: string; bodyRead: Promise<void>; markBodyRead: () => void };
} | null = null;

function holdNextACheck(streamed?: { setCookie?: string }) {
	let markSent!: () => void;
	let release!: (body: unknown, setCookie?: string) => void;
	let markBodyRead!: () => void;
	const sent = new Promise<void>((resolve) => (markSent = resolve));
	const bodyRead = new Promise<void>((resolve) => (markBodyRead = resolve));
	const answer = new Promise<{ body: unknown; setCookie?: string }>(
		(resolve) => (release = (body, setCookie) => resolve({ body, setCookie }))
	);
	heldACheck = {
		sent,
		markSent,
		release,
		answer,
		...(streamed ? { streamed: { ...streamed, bodyRead, markBodyRead } } : {}),
	};
	return heldACheck;
}

/** A response whose headers are there now and whose body arrives on `answer`. */
function streamedResponse(held: NonNullable<typeof heldACheck>): Response {
	const streamed = held.streamed!;
	let sent = false;
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (sent) return;
			sent = true;
			streamed.markBodyRead();
			const { body: answer } = await held.answer;
			controller.enqueue(new TextEncoder().encode(JSON.stringify(answer)));
			controller.close();
		},
	});
	return new Response(body, {
		status: 200,
		headers: {
			'content-type': 'application/json',
			...(streamed.setCookie ? { 'set-better-auth-cookie': streamed.setCookie } : {}),
		},
	});
}

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
	if (url.startsWith('https://site.a.example.com/api/auth/get-session')) {
		const held = heldACheck;
		if (held) {
			heldACheck = null;
			held.markSent();
			if (held.streamed) return streamedResponse(held);
			const { body, setCookie } = await held.answer;
			return json(body, setCookie ? { 'set-better-auth-cookie': setCookie } : {});
		}
		return json(aSession);
	}
	if (url.startsWith('https://site.a.example.com/api/auth/sign-out')) {
		return json({ success: true });
	}
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
	const auth = await import('~/composables/useAuth');
	const state = await import('~/lib/desktop/workspaceState');
	await workspaces.loadWorkspaces();
	return {
		...workspaces,
		...authClientModule,
		...convexAuth,
		...connect,
		...storage,
		...auth,
		makeSessionPersistence: state.makeSessionPersistence,
	};
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
	heldACheck = null;
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
	async function reauthenticateAInMain(
		beforeReauth: (compose: Modules) => void | Promise<void> = () => {}
	) {
		const compose = await bootWithA();
		const main = await bootWithA();
		await beforeReauth(compose);
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

	// A request compose sent with the older session is still in flight when
	// main signs in again; its answer arrives after compose took the new one.
	describe('a compose request sent before the new session, answered after', () => {
		async function run(answer: { body: unknown; setCookie?: string }) {
			const held = holdNextACheck();
			let pending: Promise<unknown> = Promise.resolve();
			const { compose } = await reauthenticateAInMain((c) => {
				pending = c.authClient
					.getSession({ query: { disableCookieCache: true } })
					.catch((e: unknown) => e);
			});
			await held.sent;
			expect(cookiesSentTo('https://site.a.example.com/api/auth/get-session')[0]).toContain(
				'A-session'
			);
			// Compose has taken the new session from the replace event.
			const storage = compose.getActiveKeychainStorage();
			await storage?.flush();
			expect(storage?.getItem('better-auth_cookie')).toContain('A-new-session');

			held.release(answer.body, answer.setCookie);
			await pending;
			await storage?.flush();
			return { compose, storage, outcome: await pending };
		}

		it('a signed-out answer does not clear the new session', async () => {
			const { storage, outcome } = await run({ body: null });

			expect(outcome).toBeInstanceOf(Error);
			expect(keychainEntries.get(A.tokenRef)).toContain('A-new-session');
			expect(storage?.getItem('better-auth_cookie')).toContain('A-new-session');
		});

		it('an answer carrying the older session cookie does not bring it back', async () => {
			const { storage } = await run({
				body: { user: { id: 'user-a' }, session: { id: 's-a' } },
				setCookie: 'better-auth.session_token=A-session; Max-Age=3600; Path=/',
			});

			expect(keychainEntries.get(A.tokenRef)).toContain('A-new-session');
			expect(keychainEntries.get(A.tokenRef)).not.toContain('"A-session"');
			expect(storage?.getItem('better-auth_cookie')).toContain('A-new-session');
		});
	});

	// The headers of compose's older-session check arrive before main signs in
	// again; the body finishes only after compose has bound the new session.
	describe('a compose answer whose body finishes after the new session', () => {
		async function run(streamed: { setCookie?: string }, body: unknown) {
			const held = holdNextACheck(streamed);
			let pending: Promise<unknown> = Promise.resolve();
			const { compose } = await reauthenticateAInMain(async (c) => {
				pending = c.authClient
					.getSession({ query: { disableCookieCache: true } })
					.catch((e: unknown) => e);
				// The headers are in and the client is reading the body.
				await held.streamed!.bodyRead;
			});
			expect(cookiesSentTo('https://site.a.example.com/api/auth/get-session')[0]).toContain(
				'A-session'
			);
			const storage = compose.getActiveKeychainStorage();
			await storage?.flush();
			expect(keychainEntries.get(A.tokenRef)).toContain('A-new-session');

			held.release(body);
			const outcome = await pending;
			await compose.getActiveKeychainStorage()?.flush();
			return { compose, outcome };
		}

		it('a signed-out body does not clear the new session', async () => {
			const { compose, outcome } = await run({}, null);

			expect(outcome).toBeInstanceOf(Error);
			expect(keychainEntries.get(A.tokenRef)).toContain('A-new-session');
			expect(compose.getActiveKeychainStorage()?.getItem('better-auth_cookie')).toContain(
				'A-new-session'
			);
		});

		it('a body under the older session cookie does not bring it back', async () => {
			const { compose } = await run(
				{ setCookie: 'better-auth.session_token=A-session; Max-Age=3600; Path=/' },
				{ user: { id: 'user-a' }, session: { id: 's-a' } }
			);

			expect(keychainEntries.get(A.tokenRef)).toContain('A-new-session');
			expect(keychainEntries.get(A.tokenRef)).not.toContain('"A-session"');
			expect(compose.getActiveKeychainStorage()?.getItem('better-auth_cookie')).toContain(
				'A-new-session'
			);
		});
	});

	// What compose subscribed to before main signed in again (the app's session
	// view, the session signal the Convex plugin and the body cache listen to)
	// must keep following the session after the replacement.
	describe('subscribers from before the new session', () => {
		it('useAuth keeps following the session: a later sign-out reads as signed out', async () => {
			let auth!: ReturnType<Modules['useAuth']>;
			const { compose } = await reauthenticateAInMain(async (c) => {
				auth = c.useAuth();
				await vi.waitFor(() => expect(auth.isAuthenticated.value).toBe(true));
			});

			// Signed out in compose, after the replacement.
			aSession = null;
			await compose.authClient.signOut();
			await auth.refetch({ force: true, expected: 'unauthenticated' });

			await vi.waitFor(() => expect(auth.isAuthenticated.value).toBe(false));
		});

		it('a session-signal listener keeps hearing, and hears the replacement', async () => {
			const heard = vi.fn();
			const { compose } = await reauthenticateAInMain((c) => {
				c.authClient.$store.listen('$sessionSignal', heard);
			});
			await compose.getActiveKeychainStorage()?.flush();
			await vi.waitFor(() => expect(heard).toHaveBeenCalled());

			const before = heard.mock.calls.length;
			compose.authClient.$store.notify('$sessionSignal');
			await vi.waitFor(() => expect(heard.mock.calls.length).toBeGreaterThan(before));
		});
	});

	// The cross-domain hook writes the answer's cookie, awaits, then writes the
	// session data (and, for a signed-out answer, clears the cookie). Compose
	// takes the new session exactly between those writes.
	it('a rebind landing inside the answer hook leaves the rest of its writes out of the new session', async () => {
		keychain.setDeliverEvents(false);
		const held = holdNextACheck();
		let pending: Promise<unknown> = Promise.resolve();
		const { compose } = await reauthenticateAInMain(async (c) => {
			pending = c.authClient
				.getSession({ query: { disableCookieCache: true } })
				.catch((e: unknown) => e);
			await held.sent;
		});
		// Compose missed the event and still holds the older session.
		const old = compose.getActiveKeychainStorage()!;
		expect(old.getItem('better-auth_cookie')).toContain('"A-session"');
		const entry = await keychain.bridge.sessionRead(A.tokenRef);
		expect(entry.value).toContain('A-new-session');

		// The hook's first write is the cookie; bind the new session right then.
		const write = old.setItem.bind(old);
		let rebound = false;
		old.setItem = (key, value) => {
			write(key, value);
			if (!rebound && key === 'better-auth_cookie') {
				rebound = true;
				compose.bindActiveSession(A.tokenRef, entry, compose.makeSessionPersistence());
			}
		};

		held.release(null, 'better-auth.session_token=; Max-Age=0; Path=/');
		await pending;
		expect(rebound).toBe(true);
		const bound = compose.getActiveKeychainStorage();
		await bound?.flush();
		await old.flush();

		expect(bound).not.toBe(old);
		// The new storage, and the keychain, hold what main stored; the old
		// answer's cookie and its `null` session stayed in the retired storage.
		expect(bound?.getItem('better-auth_session_data')).not.toBe('null');
		expect(bound?.getItem('better-auth_cookie')).toContain('A-new-session');
		await bound?.flush();
		expect(keychainEntries.get(A.tokenRef)).toBe(entry.value);
		expect(old.getItem('better-auth_session_data')).toBe('null');
	});
});
