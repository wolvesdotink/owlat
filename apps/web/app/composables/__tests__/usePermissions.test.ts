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
		it('can only send test emails', () => {
			roleRef.value = 'editor';
			const perms = usePermissions();

			expect(perms.role.value).toBe('editor');
			expect(perms.isOwner.value).toBe(false);
			expect(perms.isAdmin.value).toBe(false);
			expect(perms.canSendTestEmails.value).toBe(true);
			expect(perms.canSendCampaigns.value).toBe(false);
			expect(perms.canManageOrganization.value).toBe(false);
			expect(perms.canManageContacts.value).toBe(false);
			expect(perms.canManageSettings.value).toBe(false);
			expect(perms.canDeleteOrganization.value).toBe(false);
			// A resolved non-admin member gets the "Admins only" gate.
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

	describe('reactive updates', () => {
		it('updates permissions when role changes', () => {
			roleRef.value = 'editor';
			const perms = usePermissions();

			expect(perms.isAdmin.value).toBe(false);
			expect(perms.canSendCampaigns.value).toBe(false);

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
