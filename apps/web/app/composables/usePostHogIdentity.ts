/**
 * Watches auth and organization state to keep PostHog identity in sync.
 * Call once in app.vue — handles identify, group, and reset automatically.
 */
export function usePostHogIdentity() {
	const { isAuthenticated, user } = useAuth();
	const { organizationId, organization } = useOrganizationContext();
	const { identify, setOrganization, reset } = usePostHog();

	// Identify user when authenticated
	watch(
		[isAuthenticated, user],
		([authed, u]) => {
			if (authed && u) {
				identify(u.id, {
					email: u.email,
					name: u.name,
				});
			}
		},
		{ immediate: true },
	);

	// Associate user with organization group
	watch(
		[organizationId, organization],
		([orgId, org]) => {
			if (orgId) {
				setOrganization(orgId, {
					name: org?.name,
					slug: org?.slug,
				});
			}
		},
		{ immediate: true },
	);

	// Reset identity on sign out
	watch(isAuthenticated, (current, previous) => {
		if (previous && !current) {
			reset();
		}
	});
}
