/**
 * Composable for checking user permissions based on role.
 * Uses the current organization's role to determine what actions the user can perform.
 *
 * Roles hierarchy:
 * - owner: Full access, can delete organization
 * - admin: Most access except organization deletion
 * - editor: Can create/edit content but cannot send campaigns or manage organization/settings
 */
export function usePermissions() {
	const { role: orgRole } = useOrganizationContext();

	const role = computed(() => orgRole.value ?? null);

	/**
	 * Check if the user is the organization owner
	 */
	const isOwner = computed(() => role.value === 'owner');

	/**
	 * Check if the user is an admin (owner or admin role)
	 */
	const isAdmin = computed(() => role.value === 'owner' || role.value === 'admin');

	/**
	 * All authenticated organization members can send test emails
	 */
	const canSendTestEmails = computed(() => role.value !== null);

	/**
	 * Only owner and admin can send campaigns
	 */
	const canSendCampaigns = computed(() => isAdmin.value);

	/**
	 * Only owner and admin can manage organization members
	 */
	const canManageOrganization = computed(() => isAdmin.value);

	/**
	 * Only owner and admin can manage contacts (editor can only view)
	 */
	const canManageContacts = computed(() => isAdmin.value);

	/**
	 * Only owner and admin can manage settings
	 */
	const canManageSettings = computed(() => isAdmin.value);

	/**
	 * Only the owner can delete the organization
	 */
	const canDeleteOrganization = computed(() => isOwner.value);

	/**
	 * Whether to show an "Admins only" gate instead of a privileged surface
	 * (audit log, API keys, …). True once the role has RESOLVED to a non-admin
	 * member — the `role !== null` guard avoids flashing the gated state on first
	 * paint before the member role loads, when an admin would otherwise see it.
	 */
	const showAdminGate = computed(() => role.value !== null && !isAdmin.value);

	return {
		// Role checks
		role,
		isOwner,
		isAdmin,

		// Permission checks
		canSendTestEmails,
		canSendCampaigns,
		canManageOrganization,
		canManageContacts,
		canManageSettings,
		canDeleteOrganization,
		showAdminGate,
	};
}
