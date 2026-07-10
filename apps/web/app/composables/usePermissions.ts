/**
 * Composable for checking user permissions based on role.
 * Uses the current organization's role to determine what actions the user can perform.
 *
 * Roles hierarchy:
 * - owner: Full access, can delete organization
 * - admin: Most access except organization deletion
 * - editor: Runs the campaign pipeline — create, edit, schedule, and send
 *   campaigns (from the curated sender list) — but cannot manage the
 *   organization, settings, contacts, or curate campaign senders
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
	 * Editors, admins, and owners can send campaigns. Editors are limited to the
	 * curated sender list; the verified-domain gate and custom-sender toggle are
	 * enforced on the backend (2026-07-10 experience plan, decision 8).
	 */
	const canSendCampaigns = computed(() => role.value !== null);

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
