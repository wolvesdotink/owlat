import { describe, it, expect } from 'vitest';
import {
	ROLE_DEFINITIONS,
	roleDefinition,
	mailboxStatusMeta,
	type MemberMailboxStatus,
} from '../teamRoles';

describe('ROLE_DEFINITIONS', () => {
	it('lists the three roles in privilege order', () => {
		expect(ROLE_DEFINITIONS.map((r) => r.role)).toEqual(['owner', 'admin', 'editor']);
	});

	it('gives every role a two-line description', () => {
		for (const def of ROLE_DEFINITIONS) {
			expect(def.label.length).toBeGreaterThan(0);
			expect(def.summary.length).toBeGreaterThan(0);
			expect(def.detail.length).toBeGreaterThan(0);
		}
	});

	it('keeps the copy honest to the current permission map', () => {
		const owner = ROLE_DEFINITIONS.find((r) => r.role === 'owner')!;
		const admin = ROLE_DEFINITIONS.find((r) => r.role === 'admin')!;
		const editor = ROLE_DEFINITIONS.find((r) => r.role === 'editor')!;

		// Only the owner can delete the workspace / transfer ownership.
		expect(owner.detail.toLowerCase()).toContain('delet');
		// Admins run the workspace but cannot delete it.
		expect(admin.detail.toLowerCase()).toContain('cannot delete');
		// Editors now run the campaign pipeline (send from the curated list) but
		// cannot curate senders or change settings.
		expect(editor.detail.toLowerCase()).toContain('send campaigns');
		expect(editor.detail.toLowerCase()).toContain('cannot curate senders');
	});
});

describe('roleDefinition', () => {
	it('maps each known role to its definition', () => {
		expect(roleDefinition('owner').label).toBe('Owner');
		expect(roleDefinition('admin').label).toBe('Admin');
		expect(roleDefinition('editor').label).toBe('Editor');
	});

	it('falls back to the editor floor for an unknown role', () => {
		expect(roleDefinition('superuser').role).toBe('editor');
	});
});

describe('mailboxStatusMeta', () => {
	it('labels each mailbox status', () => {
		expect(mailboxStatusMeta('hosted').label).toBe('Hosted');
		expect(mailboxStatusMeta('external').label).toBe('External');
		expect(mailboxStatusMeta('none').label).toBe('No mailbox');
	});

	it('treats an absent status as no mailbox', () => {
		expect(mailboxStatusMeta(undefined).label).toBe('No mailbox');
		expect(mailboxStatusMeta(null).label).toBe('No mailbox');
	});

	it('uses design-token tone classes, never raw colors', () => {
		const statuses: MemberMailboxStatus[] = ['hosted', 'external', 'none'];
		for (const status of statuses) {
			const meta = mailboxStatusMeta(status);
			expect(meta.toneClass).toMatch(/^text-text-/);
			expect(meta.icon.startsWith('lucide:')).toBe(true);
			expect(meta.description.length).toBeGreaterThan(0);
		}
	});
});
