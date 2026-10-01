import { api } from '@owlat/api';
import { effectScope, type EffectScope } from 'vue';
import type { ConvexQueryResult } from './useConvexQuery';
import type { OrganizationRole } from './useOrganization';

type SettingsQuery = ConvexQueryResult<(typeof api.workspaces.settings.get)['_returnType']> | null;

let settingsScope: EffectScope | null = null;

let settingsQuery: SettingsQuery = null;

/**
 * The workspace-settings subscription, opened ONCE for the app's lifetime.
 *
 * `useOrganizationContext` is reached from the `auth` and `admin` route guards,
 * which call it after an `await` — there is no effect scope there, so
 * `useConvexQuery` had nothing to register a teardown on and every navigation to
 * one of the 117 guarded pages opened another subscription that was never
 * closed. The settings are a single workspace-wide document, so one subscription
 * is also the correct shape. Own it in a DETACHED scope, as `useFeatureFlag`
 * does, so the first caller's component scope cannot dispose it out from under
 * everyone else.
 */
function workspaceSettingsQuery(): NonNullable<SettingsQuery> {
	if (!settingsQuery) {
		settingsScope = effectScope(true);
		settingsScope.run(() => {
			const { isPending: authPending, activeOrganizationId } = useAuth();
			settingsQuery = useConvexQuery(api.workspaces.settings.get, () => {
				if (authPending.value) {
					return 'skip';
				}
				if (!activeOrganizationId.value) {
					return 'skip';
				}
				return {};
			});
		});
	}
	// `run` is a no-op on a stopped scope, and a fresh detached one is never
	// stopped — but say so rather than asserting a null away.
	if (!settingsQuery) {
		throw new Error('useOrganizationContext: could not build the workspace-settings query');
	}
	return settingsQuery;
}

/**
 * Composable for getting the current user's active organization context.
 * Consolidates organization-related state from BetterAuth and Convex.
 *
 * This is the single source of truth for:
 * - Organization data (name, slug, etc.)
 * - Organization settings from Convex (timezone, email theme, etc.)
 * - User's role in the organization
 * - Current user info (for audit logging and permissions)
 *
 * Use this composable instead of directly accessing useAuth for organization-related data.
 */
export function useOrganizationContext() {
	const { isPending: authPending, activeOrganizationId, user } = useAuth();
	const { organization, organizations, setActive } = useOrganization();
	const { role: memberRole, isResolved: roleResolved } = useActiveMemberRole();

	// Instance settings from Convex (timezone, email theme, etc.) — shared, see
	// `workspaceSettingsQuery`.
	const { data: settings, isLoading: settingsLoading, error } = workspaceSettingsQuery();

	// Loading means "the member's role is not known yet":
	// 1. the session itself is still loading, or
	// 2. the session names an active organization and the role lookup for it has
	//    not settled. It settles on failure too (no role), so nothing waiting on
	//    this can hang on a request that already failed.
	// No active organization means no role is coming: loaded. Neither the member
	// list nor the invitation list is involved; only roster pages load those.
	// The `auth` guard does not wait on this at all, only `admin` does, so every
	// other page renders at once and shows skeletons for its role-gated parts.
	const isLoading = computed(() => {
		if (authPending.value) return true;
		if (!activeOrganizationId.value) return false;
		return !roleResolved.value;
	});

	const isSettingsLoading = computed(() => settingsLoading.value);

	const organizationId = computed(() => activeOrganizationId.value ?? null);

	// One small `get-active-member` lookup keyed on the session (see
	// `useActiveMemberRole`), not the member list.
	const role = computed<OrganizationRole | null>(() => memberRole.value ?? null);

	return {
		// BetterAuth organization data (name, slug, etc.)
		organization,
		// Organization ID from BetterAuth
		organizationId,
		// All organizations the user belongs to
		organizations,
		// Convex settings (timezone, emailTheme, defaultFromName, etc.)
		settings,
		// User's role in the organization ('owner' | 'admin' | 'editor')
		role,
		// Current user info (for audit logging and other needs)
		user,
		// Loading state
		isLoading,
		isSettingsLoading,
		error,
		// Actions
		setActive,
		// Convenience flags
		hasActiveOrganization: computed(() => !!activeOrganizationId.value),
	};
}

// Detached scopes outlive their callers and must be stopped on hot replacement.
if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		settingsScope?.stop();
		settingsScope = null;
		settingsQuery = null;
	});
}
