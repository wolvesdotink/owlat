import { describe, it, expect } from 'vitest';
import { hasPermission } from '../sessionOrganization';
import type { Permission, OrganizationRole } from '../sessionOrganization';

const ALL_PERMISSIONS: Permission[] = [
	'campaigns:send',
	'campaigns:manage',
	'campaigns:schedule',
	'templates:manage',
	'automations:manage',
	'topics:manage',
	'segments:manage',
	'media:manage',
	'shareLinks:manage',
	'imports:manage',
	'contacts:manage',
	'organization:manage',
	'settings:manage',
	'organization:delete',
	'emails:test',
];

const OWNER_ONLY: Permission[] = ['organization:delete'];
const PUBLIC_PERMISSIONS: Permission[] = ['emails:test'];

describe('hasPermission', () => {
	it('owner has every permission', () => {
		for (const perm of ALL_PERMISSIONS) {
			expect(hasPermission('owner', perm)).toBe(true);
		}
	});

	it('admin has all permissions except owner-only ones', () => {
		for (const perm of ALL_PERMISSIONS) {
			const expected = !OWNER_ONLY.includes(perm);
			expect(hasPermission('admin', perm)).toBe(expected);
		}
	});

	it('editor only has public permissions', () => {
		for (const perm of ALL_PERMISSIONS) {
			const expected = PUBLIC_PERMISSIONS.includes(perm);
			expect(hasPermission('editor', perm)).toBe(expected);
		}
	});

	it('campaigns:send gates broadcast sending behind admin', () => {
		expect(hasPermission('owner', 'campaigns:send')).toBe(true);
		expect(hasPermission('admin', 'campaigns:send')).toBe(true);
		expect(hasPermission('editor', 'campaigns:send')).toBe(false);
	});

	it('organization:delete is owner-only', () => {
		const roles: OrganizationRole[] = ['owner', 'admin', 'editor'];
		const granted = roles.filter((r) => hasPermission(r, 'organization:delete'));
		expect(granted).toEqual(['owner']);
	});
});
