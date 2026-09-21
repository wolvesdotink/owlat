import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';
import { usePermissions } from '../usePermissions';

describe('usePermissions', () => {
	let roleRef: ReturnType<typeof ref<string | null>>;

	beforeEach(() => {
		roleRef = ref<string | null>(null);
		vi.stubGlobal('useOrganizationContext', () => ({
			role: roleRef,
		}));
	});

	describe('owner role', () => {
		it('has full permissions', () => {
			roleRef.value = 'owner';
			const perms = usePermissions();

			expect(perms.role.value).toBe('owner');
			expect(perms.isOwner.value).toBe(true);
			expect(perms.isAdmin.value).toBe(true);
			expect(perms.canSendTestEmails.value).toBe(true);
			expect(perms.canSendCampaigns.value).toBe(true);
			expect(perms.canManageOrganization.value).toBe(true);
			expect(perms.canManageContacts.value).toBe(true);
			expect(perms.canManageSettings.value).toBe(true);
			expect(perms.canDeleteOrganization.value).toBe(true);
			expect(perms.showAdminGate.value).toBe(false);
		});
	});

	describe('admin role', () => {
		it('has admin permissions but cannot delete organization', () => {
			roleRef.value = 'admin';
			const perms = usePermissions();

			expect(perms.role.value).toBe('admin');
			expect(perms.isOwner.value).toBe(false);
			expect(perms.isAdmin.value).toBe(true);
			expect(perms.canSendTestEmails.value).toBe(true);
			expect(perms.canSendCampaigns.value).toBe(true);
			expect(perms.canManageOrganization.value).toBe(true);
			expect(perms.canManageContacts.value).toBe(true);
			expect(perms.canManageSettings.value).toBe(true);
			expect(perms.canDeleteOrganization.value).toBe(false);
			expect(perms.showAdminGate.value).toBe(false);
		});
	});

	describe('editor role', () => {
		it('runs the campaign pipeline but stays out of admin surfaces', () => {
			roleRef.value = 'editor';
			const perms = usePermissions();

			expect(perms.role.value).toBe('editor');
			expect(perms.isOwner.value).toBe(false);
			expect(perms.isAdmin.value).toBe(false);
			expect(perms.canSendTestEmails.value).toBe(true);
			// d4: editors send campaigns from the curated sender list.
			expect(perms.canSendCampaigns.value).toBe(true);
			// Adjacent admin surfaces stay locked.
			expect(perms.canManageOrganization.value).toBe(false);
			expect(perms.canManageContacts.value).toBe(false);
			expect(perms.canManageSettings.value).toBe(false);
			expect(perms.canDeleteOrganization.value).toBe(false);
			// A resolved non-admin member still gets the "Admins only" gate on
			// admin surfaces (settings, curating campaign senders, etc.).
			expect(perms.showAdminGate.value).toBe(true);
		});
	});

	describe('null role', () => {
		it('has no permissions', () => {
			roleRef.value = null;
			const perms = usePermissions();

			expect(perms.role.value).toBe(null);
			expect(perms.isOwner.value).toBe(false);
			expect(perms.isAdmin.value).toBe(false);
			expect(perms.canSendTestEmails.value).toBe(false);
			expect(perms.canSendCampaigns.value).toBe(false);
			expect(perms.canManageOrganization.value).toBe(false);
			expect(perms.canManageContacts.value).toBe(false);
			expect(perms.canManageSettings.value).toBe(false);
			expect(perms.canDeleteOrganization.value).toBe(false);
			// Role not resolved yet → no gate flash on first paint.
			expect(perms.showAdminGate.value).toBe(false);
		});
	});

	describe('can() — the shared permission map', () => {
		it('gives an editor the campaign pipeline but none of the content domains', () => {
			roleRef.value = 'editor';
			const { can } = usePermissions();

			expect(can('campaigns:send')).toBe(true);
			expect(can('contacts:annotate')).toBe(true);
			// The seven the composable used to omit entirely, which is how an editor
			// was offered buttons the backend then refused.
			expect(can('templates:manage')).toBe(false);
			expect(can('automations:manage')).toBe(false);
			expect(can('topics:manage')).toBe(false);
			expect(can('segments:manage')).toBe(false);
			expect(can('media:manage')).toBe(false);
			expect(can('imports:manage')).toBe(false);
			expect(can('shareLinks:manage')).toBe(false);
		});

		it('gives an admin the content domains but not organization deletion', () => {
			roleRef.value = 'admin';
			const { can } = usePermissions();

			expect(can('segments:manage')).toBe(true);
			expect(can('shareLinks:manage')).toBe(true);
			expect(can('organization:delete')).toBe(false);
		});

		it('grants nothing while the role is unresolved', () => {
			roleRef.value = null;
			const { can } = usePermissions();

			expect(can('emails:test')).toBe(false);
			expect(can('segments:manage')).toBe(false);
		});

		it('tracks the role reactively', () => {
			roleRef.value = 'editor';
			const { can } = usePermissions();

			expect(can('topics:manage')).toBe(false);
			roleRef.value = 'owner';
			expect(can('topics:manage')).toBe(true);
		});
	});

	describe('showGateFor()', () => {
		it('stays quiet until the role resolves, then gates a role that lacks it', () => {
			roleRef.value = null;
			const { showGateFor } = usePermissions();

			// No flash of the gated state on first paint.
			expect(showGateFor('segments:manage')).toBe(false);

			roleRef.value = 'editor';
			expect(showGateFor('segments:manage')).toBe(true);

			roleRef.value = 'admin';
			expect(showGateFor('segments:manage')).toBe(false);
		});
	});

	describe('reactive updates', () => {
		it('updates permissions when role changes', () => {
			roleRef.value = 'editor';
			const perms = usePermissions();

			expect(perms.isAdmin.value).toBe(false);
			// Editors can send campaigns (d4).
			expect(perms.canSendCampaigns.value).toBe(true);

			roleRef.value = 'admin';
			expect(perms.role.value).toBe('admin');
			expect(perms.isAdmin.value).toBe(true);
			expect(perms.canSendCampaigns.value).toBe(true);
			expect(perms.canDeleteOrganization.value).toBe(false);

			roleRef.value = 'owner';
			expect(perms.isOwner.value).toBe(true);
			expect(perms.canDeleteOrganization.value).toBe(true);
		});

		it('updates permissions when role becomes null', () => {
			roleRef.value = 'owner';
			const perms = usePermissions();

			expect(perms.isOwner.value).toBe(true);

			roleRef.value = null;
			expect(perms.role.value).toBe(null);
			expect(perms.isOwner.value).toBe(false);
			expect(perms.isAdmin.value).toBe(false);
			expect(perms.canSendTestEmails.value).toBe(false);
		});
	});
});
