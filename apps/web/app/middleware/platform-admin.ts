import { api } from '@owlat/api';

/**
 * Platform Admin middleware.
 *
 * Restricts a route to users who are listed in the `platformAdmins` table.
 *
 * Assumes `auth` has already run (pair it via `middleware: ['auth', 'platform-admin']`).
 *
 * Usage:
 *   definePageMeta({
 *     layout: 'dashboard',
 *     middleware: ['auth', 'platform-admin'],
 *   });
 */
export default defineNuxtRouteMiddleware(async () => {
	if (import.meta.server) return;

	const { isAuthenticated, waitUntilReady } = useAuth();
	await waitUntilReady();

	if (!isAuthenticated.value) {
		return navigateTo('/auth/login');
	}

	const { $convex } = useNuxtApp();
	if (!$convex) {
		return navigateTo('/auth/login');
	}

	try {
		const isAdmin = await $convex.query(api.platformAdmin.platformAdmin.isPlatformAdmin, {});
		if (!isAdmin) {
			return navigateTo('/dashboard');
		}
	} catch {
		return navigateTo('/auth/login');
	}
});
