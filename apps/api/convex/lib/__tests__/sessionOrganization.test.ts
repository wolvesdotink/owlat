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
// Editors run the marketing send pipeline end-to-end (2026-07-10 experience
// plan, decision 8) now that the curated-sender guardrail exists. This is the
// EXACT set d4 widens to editors — nothing else. Curating the sender list, the
// custom-sender toggle, contacts, domains, delivery, team, topics, and every
// other admin surface stay admin-only (asserted by the editor-floor test below).
const EDITOR_CAMPAIGN_PERMISSIONS: Permission[] = [
	'campaigns:send',
	'campaigns:manage',
	'campaigns:schedule',
];
// Everything an editor may do: the public member permissions plus the campaign
// pipeline. Any permission NOT in this set must be denied to editors.
const EDITOR_ALLOWED: Permission[] = [...PUBLIC_PERMISSIONS, ...EDITOR_CAMPAIGN_PERMISSIONS];

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

	it('editor has exactly the public + campaign-pipeline permissions and nothing more', () => {
		for (const perm of ALL_PERMISSIONS) {
			const expected = EDITOR_ALLOWED.includes(perm);
			expect(hasPermission('editor', perm)).toBe(expected);
		}
	});

	it('editors run the campaign pipeline (create/edit/schedule/send)', () => {
		for (const perm of EDITOR_CAMPAIGN_PERMISSIONS) {
			expect(hasPermission('editor', perm)).toBe(true);
		}
	});

	it('admin-only surfaces stay locked to editors after the d4 campaign remap', () => {
		// Re-assert the guardrail: opening campaigns to editors must NOT leak any
		// adjacent admin capability (decision 8 — settings/domains/delivery/team/
		// topics stay admin-only, and curating campaign senders is settings:manage).
		const adminOnlyForEditors: Permission[] = [
			'contacts:manage',
			'segments:manage',
			'media:manage',
			'templates:manage',
			'topics:manage',
			'automations:manage',
			'shareLinks:manage',
			'imports:manage',
			'organization:manage',
			'settings:manage',
			'organization:delete',
		];
		for (const perm of adminOnlyForEditors) {
			expect(hasPermission('editor', perm)).toBe(false);
			expect(hasPermission('admin', perm)).toBe(perm !== 'organization:delete');
		}
	});

	it('campaigns:send now includes editors (curated-sender guardrail)', () => {
		expect(hasPermission('owner', 'campaigns:send')).toBe(true);
		expect(hasPermission('admin', 'campaigns:send')).toBe(true);
		expect(hasPermission('editor', 'campaigns:send')).toBe(true);
	});

	it('organization:delete is owner-only', () => {
		const roles: OrganizationRole[] = ['owner', 'admin', 'editor'];
		const granted = roles.filter((r) => hasPermission(r, 'organization:delete'));
		expect(granted).toEqual(['owner']);
	});
});
