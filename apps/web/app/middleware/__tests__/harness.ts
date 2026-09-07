/**
 * Runs a route middleware the way Nuxt does: the REAL composables it reaches
 * (`useAuth`, `useOrganizationContext`, `useOrganization`, `usePermissions`,
 * `useFeatureFlag`, `useConvexQuery`) and the real `vue-i18n` `useI18n`, over a
 * fake session and a fake Convex client that the test drives.
 *
 * The stubs stop at the process boundary: the better-auth client
 * (`~/lib/auth-client`, mocked by each suite via {@link authClientMock}), the
 * Convex client (`useNuxtApp().$convex`), Nuxt's `useState` / `useRuntimeConfig`
 * / `navigateTo`. The toast, live-region and PostHog composables the chain
 * builds at setup are the shipped ones as well. Everything in between is the shipped code — so a composable
 * that calls `useI18n()` from a route guard throws here exactly as it throws in
 * the browser (`Must be called at the top of a 'setup' function`), which is the
 * regression class the earlier collaborator-stubbing suites could not see.
 *
 * Route middleware runs inside the router guard, outside any component
 * `setup()`: `getCurrentInstance()` is null. It is here too.
 */
import { vi } from 'vitest';
import { computed, ref, type Ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { getFunctionName, type FunctionReference } from 'convex/server';
import type { RouteLocationNormalized } from 'vue-router';
import { useConvex } from '@owlat/ui/composables/useConvex';
import { useToast } from '@owlat/ui/composables/useToast';
import { useAnnounce } from '~/composables/useAnnounce';
import { usePostHog } from '~/composables/usePostHog';
import { safeRedirect } from '~/utils/safeRedirect';
import { waitForLoaded } from '~/utils/waitForLoaded';

/** What the `navigateTo` stub returns, so a suite asserts the redirect itself. */
export interface Redirect {
	redirect: unknown;
	options?: unknown;
}

export function route(
	path: string,
	extra: { query?: Record<string, string>; meta?: Record<string, unknown> } = {}
): RouteLocationNormalized {
	const query = extra.query ?? {};
	const search = new URLSearchParams(query).toString();
	return {
		path,
		fullPath: search ? `${path}?${search}` : path,
		query,
		meta: extra.meta ?? {},
	} as unknown as RouteLocationNormalized;
}

// ---- session state: drives the mocked ~/lib/auth-client ----

export type FakeRole = 'owner' | 'admin' | 'member';
export interface FakeUser {
	id: string;
	email: string;
	name: string;
}
export interface FakeOrganization {
	id: string;
	name: string;
	slug: string;
}

interface SessionState {
	pending: Ref<boolean>;
	user: Ref<FakeUser | null>;
	activeOrganizationId: Ref<string | null>;
	organizations: Ref<FakeOrganization[]>;
	members: Ref<Array<{ userId: string; role: FakeRole }>>;
}

function freshSession(): SessionState {
	return {
		pending: ref(false),
		user: ref<FakeUser | null>(null),
		activeOrganizationId: ref<string | null>(null),
		organizations: ref<FakeOrganization[]>([]),
		members: ref<Array<{ userId: string; role: FakeRole }>>([]),
	};
}

export const session: SessionState = freshSession();

export const USER: FakeUser = { id: 'user-1', email: 'member@example.com', name: 'Member' };
export const ORGANIZATION: FakeOrganization = { id: 'org-1', name: 'Acme', slug: 'acme' };

export const listMembers = vi.fn(async () => ({ data: { members: session.members.value } }));
export const listInvitations = vi.fn(async () => ({ data: [] as unknown[] }));
export const listOrganizations = vi.fn(async () => ({ data: session.organizations.value }));
export const setActiveOrganization = vi.fn(async (input: { organizationId: string }) => {
	session.activeOrganizationId.value = input.organizationId;
	return {
		data: session.organizations.value.find((o) => o.id === input.organizationId) ?? null,
		error: null,
	};
});

/**
 * Fresh refs, not reset values: a previous load's `useOrganization` watcher is
 * still alive and would otherwise fire on the next case's sign-in, consuming its
 * one-shot mock answers.
 */
export function resetSession(): void {
	Object.assign(session, freshSession());
	listMembers.mockClear();
	listInvitations.mockClear();
	listOrganizations.mockClear();
	setActiveOrganization.mockClear();
}

/** A signed-in member; `role` is the member's better-auth role in {@link ORGANIZATION}. */
export function signIn(options: { role?: FakeRole; organization?: boolean } = {}): void {
	session.user.value = USER;
	if (options.organization === false) return;
	session.organizations.value = [ORGANIZATION];
	session.activeOrganizationId.value = ORGANIZATION.id;
	session.members.value = [{ userId: USER.id, role: options.role ?? 'admin' }];
}

/**
 * The `vi.mock('~/lib/auth-client', () => authClientMock())` factory. Lives here
 * so the session shape is written once; each suite still registers the mock
 * itself because `vi.mock` is hoisted per file.
 */
export function authClientMock() {
	// A fresh computed per call, as better-auth's hooks hand out: the mocked
	// module outlives `vi.resetModules()`, so a shared computed would keep the
	// previous case's refs as its dependencies.
	const sessionData = () =>
		session.user.value
			? {
					user: session.user.value,
					session: { activeOrganizationId: session.activeOrganizationId.value },
				}
			: null;
	const authClient = {
		useSession: () =>
			computed(() => ({ data: sessionData(), isPending: session.pending.value, error: null })),
		getSession: async () => ({ data: sessionData() }),
		$store: { notify: () => undefined },
		signIn: {},
		signOut: vi.fn(),
	};
	return {
		authClient,
		useSession: authClient.useSession,
		getSession: authClient.getSession,
		useActiveOrganization: () =>
			computed(() => ({
				data:
					session.organizations.value.find((o) => o.id === session.activeOrganizationId.value) ??
					null,
				isPending: false,
			})),
		useListOrganizations: () => computed(() => ({ data: session.organizations.value })),
		listOrganizations,
		listMembers,
		listInvitations,
		setActiveOrganization,
		signIn: vi.fn(),
		signUp: vi.fn(),
		signOut: vi.fn(),
		updateOrganization: vi.fn(),
		getFullOrganization: vi.fn(),
		checkOrgSlug: vi.fn(),
		inviteMember: vi.fn(),
		acceptInvitation: vi.fn(),
		rejectInvitation: vi.fn(),
		cancelInvitation: vi.fn(),
		removeMember: vi.fn(),
		updateMemberRole: vi.fn(),
		getActiveMember: vi.fn(),
		leaveOrganization: vi.fn(),
	};
}

// ---- Convex: the client behind useNuxtApp().$convex ----

type Subscriber = { onData: (data: unknown) => void; onError: (error: Error) => void };

export interface FakeConvex {
	query: ReturnType<
		typeof vi.fn<(fn: FunctionReference<'query'>, args: unknown) => Promise<unknown>>
	>;
	onUpdate: (
		fn: FunctionReference<'query'>,
		args: unknown,
		onData: (data: unknown) => void,
		onError: (error: Error) => void
	) => () => void;
	/** Push a subscription result, as the Convex socket would. */
	deliver: (fn: FunctionReference<'query'>, data: unknown) => void;
	subscriptionCount: (fn: FunctionReference<'query'>) => number;
}

export function createFakeConvex(): FakeConvex {
	const subscriptions = new Map<string, Subscriber[]>();
	const bucket = (fn: FunctionReference<'query'>) => {
		const name = getFunctionName(fn);
		const list = subscriptions.get(name) ?? [];
		subscriptions.set(name, list);
		return list;
	};
	return {
		query: vi.fn(),
		onUpdate: (fn, _args, onData, onError) => {
			const subscriber = { onData, onError };
			bucket(fn).push(subscriber);
			return () => {
				const list = bucket(fn);
				list.splice(list.indexOf(subscriber), 1);
			};
		},
		deliver: (fn, data) => {
			for (const subscriber of bucket(fn).slice()) subscriber.onData(data);
		},
		subscriptionCount: (fn) => bucket(fn).length,
	};
}

// ---- Nuxt globals + the real composables, installed fresh per load ----

export interface LoadOptions {
	convex?: FakeConvex | null;
	runtimeConfig?: { public: Record<string, unknown> };
}

export interface Loaded<T> {
	middleware: T;
	convex: FakeConvex | null;
	/** Nuxt's `useState` buckets for this load, keyed like the app keys them. */
	state: Map<string, { value: unknown }>;
}

/**
 * Reset the module registry (the composables keep module-level singletons —
 * `useOrganization`'s watch flag, `useFeatureFlag`'s inflight subscription —
 * that must not leak between cases), install the Nuxt auto-imports as globals
 * with their shipped implementations, then import the middleware under test.
 */
export async function loadMiddleware<T>(
	importer: () => Promise<{ default: unknown }>,
	options: LoadOptions = {}
): Promise<Loaded<T>> {
	vi.resetModules();

	const convex = options.convex === undefined ? createFakeConvex() : options.convex;
	const state = new Map<string, { value: unknown }>();

	vi.stubGlobal('defineNuxtRouteMiddleware', (fn: unknown) => fn);
	vi.stubGlobal('navigateTo', (to: unknown, navigateOptions?: unknown): Redirect => ({
		redirect: to,
		options: navigateOptions,
	}));
	vi.stubGlobal('useState', (key: string, init: () => unknown) => {
		if (!state.has(key)) state.set(key, ref(init()));
		return state.get(key);
	});
	vi.stubGlobal('useNuxtApp', () => ({ $convex: convex }));
	vi.stubGlobal('useRuntimeConfig', () => options.runtimeConfig ?? { public: {} });
	vi.stubGlobal('useI18n', useI18n);
	vi.stubGlobal('waitForLoaded', waitForLoaded);
	vi.stubGlobal('safeRedirect', safeRedirect);
	vi.stubGlobal('useConvex', useConvex);
	vi.stubGlobal('useToast', useToast);
	vi.stubGlobal('useAnnounce', useAnnounce);
	vi.stubGlobal('usePostHog', usePostHog);

	const [
		auth,
		organization,
		organizationContext,
		permissions,
		featureFlag,
		convexQuery,
		backendOperation,
	] = await Promise.all([
		import('~/composables/useAuth'),
		import('~/composables/useOrganization'),
		import('~/composables/useOrganizationContext'),
		import('~/composables/usePermissions'),
		import('~/composables/useFeatureFlag'),
		import('~/composables/useConvexQuery'),
		import('~/composables/useBackendOperation'),
	]);
	vi.stubGlobal('useAuth', auth.useAuth);
	vi.stubGlobal('useBackendOperation', backendOperation.useBackendOperation);
	vi.stubGlobal('useOrganization', organization.useOrganization);
	vi.stubGlobal('useOrganizationContext', organizationContext.useOrganizationContext);
	vi.stubGlobal('usePermissions', permissions.usePermissions);
	vi.stubGlobal('useFeatureFlag', featureFlag.useFeatureFlag);
	vi.stubGlobal('useConvexQuery', convexQuery.useConvexQuery);

	const middleware = (await importer()).default as T;
	return { middleware, convex, state };
}

/** Mark the page as the packaged desktop webview (`isDesktopRuntime()` reads this). */
export function enterDesktopRuntime(): void {
	Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
}

export function leaveDesktopRuntime(): void {
	delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
}
