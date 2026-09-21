/**
 * Watches auth and organization state to keep PostHog identity in sync.
 * Call once in app.vue — handles identify, group, and reset automatically.
 *
 * Only IDs are sent. PostHog holds product analytics, not a copy of the user
 * directory: the distinct id already IS the user id, so an email address or a
 * display name adds nothing an Owlat operator can act on and everything a
 * processor agreement then has to cover. The organization group is likewise
 * keyed by id alone — a workspace's name and slug identify the customer as
 * plainly as a person's name identifies the person. Anyone who needs the human
 * label joins it from Owlat's own database, where it already lives.
 *
 * The PostHog client only exists while `analytics.posthog` is on, and the flag
 * resolves asynchronously, so the instance is a watch source: identity is
 * (re-)sent when the client appears rather than dropped for having arrived
 * first.
 */
export function usePostHogIdentity() {
	const { isAuthenticated, user } = useAuth();
	const { organizationId } = useOrganizationContext();
	const { identify, setOrganization, reset, getInstance } = usePostHog();

	// Identify user when authenticated
	watch(
		[isAuthenticated, user, getInstance],
		([authed, u, ph]) => {
			if (authed && u && ph) {
				identify(u.id);
			}
		},
		{ immediate: true }
	);

	// Associate user with organization group
	watch(
		[organizationId, getInstance],
		([orgId, ph]) => {
			if (orgId && ph) {
				setOrganization(orgId);
			}
		},
		{ immediate: true }
	);

	// Reset identity on sign out
	watch(isAuthenticated, (current, previous) => {
		if (previous && !current) {
			reset();
		}
	});
}
