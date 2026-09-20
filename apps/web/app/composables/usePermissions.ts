import { hasPermission, type Permission } from '@owlat/shared/organizationPermissions';

/**
 * Composable for checking user permissions based on role.
 * Uses the current organization's role to determine what actions the user can perform.
 *
 * The role→permission table is NOT restated here: `can()` reads the same
 * `@owlat/shared/organizationPermissions` map that the Convex gates
 * (`requireOrgPermission`) enforce. This composable used to hand-mirror it and
 * expressed only seven of the nineteen permissions; the seven admin-only
 * content domains were among the twelve it left out, which is how editors ended
 * up being offered create/edit buttons on segments, topics, automations and
 * templates that the backend then refused.
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
	 * Whether the current role carries `permission`. An unresolved role carries
	 * nothing, so this is false until the member role loads.
	 *
	 * Reactive: it reads `role` on every call, so it can be used directly in a
	 * template (`v-if="can('segments:manage')"`) or inside a `computed`.
	 */
	const can = (permission: Permission) => hasPermission(role.value, permission);

	/**
	 * Whether to show an "Admins only" gate instead of the surface that
	 * `permission` protects. True once the role has RESOLVED to one that lacks
	 * the permission — the `role !== null` guard avoids flashing the gated state
	 * on first paint before the member role loads, when an admin would otherwise
	 * see it.
	 */
	const showGateFor = (permission: Permission) => role.value !== null && !can(permission);

	/**
	 * All authenticated organization members can send test emails
	 */
	const canSendTestEmails = computed(() => can('emails:test'));

	/**
	 * Editors, admins, and owners can send campaigns. Editors are limited to the
	 * curated sender list; the verified-domain gate and custom-sender toggle are
	 * enforced on the backend (2026-07-10 experience plan, decision 8).
	 */
	const canSendCampaigns = computed(() => can('campaigns:send'));

	/**
	 * Only owner and admin can manage organization members
	 */
	const canManageOrganization = computed(() => can('organization:manage'));

	/**
	 * Only owner and admin can manage contacts (editor can only view)
	 */
	const canManageContacts = computed(() => can('contacts:manage'));

	/** Every organization member may add shared notes to a customer. */
	const canAnnotateContacts = computed(() => can('contacts:annotate'));

	/**
	 * Only owner and admin can manage settings
	 */
	const canManageSettings = computed(() => can('settings:manage'));

	/**
	 * Only the owner can delete the organization
	 */
	const canDeleteOrganization = computed(() => can('organization:delete'));

	/**
	 * Whether to show an "Admins only" gate instead of a privileged surface
	 * (audit log, API keys, …) — `showGateFor('organization:manage')`.
	 */
	const showAdminGate = computed(() => showGateFor('organization:manage'));

	return {
		// Role checks
		role,
		isOwner,
		isAdmin,

		// Typed permission checks against the shared map
		can,
		showGateFor,

		// Permission checks
		canSendTestEmails,
		canSendCampaigns,
		canManageOrganization,
		canManageContacts,
		canAnnotateContacts,
		canManageSettings,
		canDeleteOrganization,
		showAdminGate,
	};
}
