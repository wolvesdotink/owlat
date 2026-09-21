import { describe, expect, it } from 'vitest';
import { hasPermission, type OrganizationRole, type Permission } from '../organizationPermissions';

/**
 * The table this file pins down is the one BOTH the Convex gates
 * (`requireOrgPermission`) and the web app's `usePermissions().can()` read, so
 * a change here is a change to what the product allows on both sides. It is
 * written out permission by permission rather than derived from the map, which
 * would only assert that the map equals itself.
 */
const EXPECTED: Record<Permission, readonly OrganizationRole[]> = {
	'campaigns:send': ['owner', 'admin', 'editor'],
	'campaigns:manage': ['owner', 'admin', 'editor'],
	'campaigns:schedule': ['owner', 'admin', 'editor'],
	'templates:manage': ['owner', 'admin'],
	'automations:manage': ['owner', 'admin'],
	'topics:manage': ['owner', 'admin'],
	'segments:manage': ['owner', 'admin'],
	'media:manage': ['owner', 'admin'],
	'shareLinks:manage': ['owner', 'admin'],
	'imports:manage': ['owner', 'admin'],
	'contacts:manage': ['owner', 'admin'],
	'contacts:annotate': ['owner', 'admin', 'editor'],
	'organization:manage': ['owner', 'admin'],
	'settings:manage': ['owner', 'admin'],
	'organization:delete': ['owner'],
	'emails:test': ['owner', 'admin', 'editor'],
	'knowledge:read': ['owner', 'admin', 'editor'],
	'chat:participate': ['owner', 'admin', 'editor'],
	'chat:manage': ['owner', 'admin'],
};

const ROLES: OrganizationRole[] = ['owner', 'admin', 'editor'];
const PERMISSIONS = Object.keys(EXPECTED) as Permission[];

describe('hasPermission', () => {
	it.each(PERMISSIONS)('grants %s to exactly the expected roles', (permission) => {
		const granted = ROLES.filter((role) => hasPermission(role, permission));
		expect(granted).toEqual(EXPECTED[permission].filter((role) => ROLES.includes(role)));
	});

	it('gives an owner every permission', () => {
		expect(PERMISSIONS.filter((p) => !hasPermission('owner', p))).toEqual([]);
	});

	it('keeps organization deletion to the owner alone', () => {
		expect(hasPermission('admin', 'organization:delete')).toBe(false);
		expect(hasPermission('editor', 'organization:delete')).toBe(false);
	});

	it('keeps the content domains admin-only', () => {
		const contentDomains: Permission[] = [
			'templates:manage',
			'automations:manage',
			'topics:manage',
			'segments:manage',
			'media:manage',
			'shareLinks:manage',
			'imports:manage',
		];
		for (const permission of contentDomains) {
			expect(hasPermission('editor', permission)).toBe(false);
			expect(hasPermission('admin', permission)).toBe(true);
		}
	});

	// An unresolved role is the web app's first-paint state; treating it as
	// "no permissions" is what keeps a gated surface from flashing for an admin.
	it.each([null, undefined])('grants nothing to a %s role', (role) => {
		expect(PERMISSIONS.filter((p) => hasPermission(role, p))).toEqual([]);
	});
});
