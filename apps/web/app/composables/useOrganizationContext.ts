import { api } from '@owlat/api';
import type { OrganizationRole } from './useOrganization';

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
	const {
		organization,
		organizations,
		isLoadingMembers,
		hasResolvedMembers,
		activeOrganizationError,
		currentMemberRole,
		setActive,
	} = useOrganization();

	// Get instance settings from Convex (timezone, email theme, etc.)
	const {
		data: settings,
		isLoading: settingsLoading,
		error,
	} = useConvexQuery(api.workspaces.settings.get, () => {
		if (authPending.value) {
			return 'skip';
		}
		if (!activeOrganizationId.value) {
			return 'skip';
		}
		return {};
	});

	// Loading logic:
	// 1. If auth session is still loading, we're loading
	// 2. If user doesn't have an active organization in their session, no need to wait for org data
	// 3. Otherwise, wait for Convex settings and member data (for role) to load
	// Note: we don't include BetterAuth's hook isPending here — authPending already
	// gates the initial state, and the session provides the activeOrganizationId.
	const isLoading = computed(() => {
		if (authPending.value) return true;
		if (!activeOrganizationId.value) return false;
		// A failed active-organization request is a settled answer — no role is
		// coming — so report loaded and let the caller act on what it has. Waiting
		// on it instead would trade the bounce for a worse bug: every guard
		// stalling its full timeout and every page that folds this into a loading
		// flag spinning forever.
		if (activeOrganizationError.value) return false;
		// Not `isLoadingMembers`: that starts false and only turns true once the
		// fetch begins, which waits on BetterAuth's separate organization request.
		// Reading it directly reports "loaded" during the window where the role is
		// simply not known yet — and a guard that asks "is this user an admin?"
		// then gets `false` for an owner. Stay loading until the fetch has SETTLED.
		return !hasResolvedMembers.value || isLoadingMembers.value;
	});

	const isSettingsLoading = computed(() => settingsLoading.value);

	const organizationId = computed(() => activeOrganizationId.value ?? null);

	// Use the current member role from useOrganization (fetched via member list)
	// This is more reliable than trying to extract from useActiveOrganization hook
	const role = computed<OrganizationRole | null>(() => {
		return currentMemberRole.value ?? null;
	});

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
