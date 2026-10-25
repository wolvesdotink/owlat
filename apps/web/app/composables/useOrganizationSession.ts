/**
 * The active organization as the session sees it: which one is active, which
 * ones the user belongs to, and switching between them.
 *
 * Split from `useOrganization.ts` because `useOrganizationContext` (and through
 * it identity tracking in app.vue) needs only this, on every page, while the
 * roster half (members, invitations and their mutations) is for team pages.
 * `useOrganization` builds on this and adds the roster.
 */
import { effectScope, type EffectScope } from 'vue';
import {
	useActiveOrganization,
	useListOrganizations,
	setActiveOrganization,
} from '~/lib/auth-client';

const ORGANIZATION_SYNC_TIMEOUT_MS = 5_000;

/**
 * The message catalog, resolved where one exists.
 *
 * `useOrganization` is called from route middleware (the `admin`-gated pages'
 * guard reads `currentMemberRole` / permission flags) as well as from page
 * setups, and `useI18n()` THROWS outside a component instance — which would 500
 * every `admin`-gated route. Middleware only reads org state; it never reaches a
 * branch that produces user copy, so outside a component the fallback degrades a
 * key to itself rather than taking the app down. Mirrors `useAuth.ts`.
 */
export function organizationTranslator(): (key: string) => string {
	if (!getCurrentInstance()) return (key: string) => key;
	const { t } = useI18n();
	return (key: string) => t(key);
}

/**
 * The BetterAuth organization stores, subscribed ONCE for the app's lifetime.
 *
 * They are nanostore-backed and release their listener only through
 * `onScopeDispose`, so a call made where no effect scope is active — route
 * middleware after its first `await`, which is how the `auth` and `admin` guards
 * reach this composable — subscribed forever. One listener per navigation over
 * 117 guarded pages. Both stores are app-wide singletons upstream, so a single
 * subscriber is also the correct shape; a DETACHED scope owns it so no caller's
 * teardown can freeze the refs for everyone else. The module explicitly stops its detached scopes on hot replacement
 * before the replacement module builds new subscriptions.
 */
let organizationScope: EffectScope | null = null;

let organizationStores: {
	activeOrganization: ReturnType<typeof useActiveOrganization>;
	organizationsList: ReturnType<typeof useListOrganizations>;
} | null = null;

function betterAuthOrganizationStores(): NonNullable<typeof organizationStores> {
	if (!organizationStores) {
		organizationScope = effectScope(true);
		organizationScope.run(() => {
			organizationStores = {
				activeOrganization: useActiveOrganization(),
				organizationsList: useListOrganizations(),
			};
		});
		// `run` is a no-op on a stopped scope, and a fresh detached one is never
		// stopped — but say so rather than asserting a null away.
		if (!organizationStores) {
			throw new Error('useOrganization: could not build the better-auth organization stores');
		}
	}
	return organizationStores;
}

/**
 * Registered by `useOrganization`: after a switch it refreshes the member
 * lists, when a page is holding them, before `setActive` resolves. A switch
 * made through `useOrganizationContext` gets the refresh too.
 */
let refreshRosterAfterSwitch: (() => Promise<void>) | null = null;

export function setRosterRefreshAfterSwitch(refresh: () => Promise<void>): void {
	refreshRosterAfterSwitch = refresh;
}

/**
 * `auth` is the caller's own `useAuth()` when it has one, so a composable built
 * on this one subscribes to the session once.
 */
export function useOrganizationSession(
	auth: Pick<ReturnType<typeof useAuth>, 'refetch'> = useAuth()
) {
	const t = organizationTranslator();
	const { refetch: refetchSession } = auth;
	const { activeOrganization: activeOrgRef, organizationsList: orgsListRef } =
		betterAuthOrganizationStores();

	// Computed values - BetterAuth hooks return refs with nested data/isPending
	const organization = computed(() => {
		const orgData = activeOrgRef.value;
		return orgData?.data ?? null;
	});

	const organizationId = computed(() => organization.value?.id ?? null);

	/**
	 * The active-organization request failed.
	 *
	 * It settles with an error rather than an organization when the session still
	 * names an organization the user is no longer in — better-auth only clears
	 * `activeOrganizationId` when a member removes THEMSELVES, so an admin
	 * removing someone leaves that person's open tab pointing at a `FORBIDDEN`
	 * — and on any transient failure, such as the backend restarting mid-update.
	 *
	 * That is a settled answer: no organization is coming, so no role is coming
	 * either. Callers that wait for the role must stop waiting, or the guards
	 * stall for their whole timeout on every navigation and every page that folds
	 * this into its loading flag spins forever.
	 */
	const activeOrganizationError = computed(() => activeOrgRef.value?.error ?? null);

	const organizationsList = computed(() => {
		const orgsData = orgsListRef.value;
		return orgsData?.data ?? [];
	});

	async function waitForActiveOrganization(
		orgId: string,
		timeoutMs = ORGANIZATION_SYNC_TIMEOUT_MS
	) {
		if (organizationId.value === orgId) {
			return;
		}

		await new Promise<void>((resolve, reject) => {
			const timeoutId = setTimeout(() => {
				stop();
				reject(new Error(t('shared.useOrganization.errors.organizationSyncTimeout')));
			}, timeoutMs);

			const stop = watch(
				organizationId,
				(currentOrganizationId) => {
					if (currentOrganizationId === orgId) {
						clearTimeout(timeoutId);
						stop();
						resolve();
					}
				},
				{ immediate: true }
			);
		});
	}

	/**
	 * Set the active organization
	 */
	async function setActive(orgId: string) {
		const result = await setActiveOrganization({
			organizationId: orgId,
		});

		if (result.error) {
			throw new Error(
				result.error.message || t('shared.useOrganization.errors.setActiveOrganizationFailed')
			);
		}

		await refetchSession({
			force: true,
			expected: 'authenticated',
			activeOrganizationId: orgId,
		});
		await waitForActiveOrganization(orgId);
		// The role follows the session on its own (`useActiveMemberRole`); the
		// lists are refreshed only when a page is holding them.
		await refreshRosterAfterSwitch?.();

		return result.data;
	}

	return {
		organization,
		organizationId,
		organizations: organizationsList,
		activeOrganizationError,
		setActive,
	};
}

// Detached scopes outlive their callers and must be stopped on hot replacement.
if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		organizationScope?.stop();
		organizationScope = null;
		organizationStores = null;
		refreshRosterAfterSwitch = null;
	});
}
