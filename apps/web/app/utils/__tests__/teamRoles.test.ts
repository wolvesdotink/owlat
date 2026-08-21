import { describe, it, expect } from 'vitest';
import { createTestI18n } from '~/__tests__/i18n';
import {
	ROLE_DEFINITIONS,
	roleDefinition,
	mailboxStatusMeta,
	type MemberMailboxStatus,
} from '../teamRoles';

/** The tables carry catalog keys, so the copy audit renders them in English. */
const { t } = createTestI18n().global;

describe('ROLE_DEFINITIONS', () => {
	it('lists the three roles in privilege order', () => {
		expect(ROLE_DEFINITIONS.map((r) => r.role)).toEqual(['owner', 'admin', 'editor']);
	});

	it('gives every role a two-line description the catalog actually carries', () => {
		for (const def of ROLE_DEFINITIONS) {
			// A key with no message renders as its own path, which would pass a
			// length check — so each one is asserted to resolve to something else.
			expect(t(def.label)).not.toBe(def.label);
			expect(t(def.summary)).not.toBe(def.summary);
			expect(t(def.detail)).not.toBe(def.detail);
		}
	});

	it('keeps the copy honest to the current permission map', () => {
		const owner = ROLE_DEFINITIONS.find((r) => r.role === 'owner')!;
		const admin = ROLE_DEFINITIONS.find((r) => r.role === 'admin')!;
		const editor = ROLE_DEFINITIONS.find((r) => r.role === 'editor')!;

		// Only the owner can delete the workspace / transfer ownership.
		expect(t(owner.detail).toLowerCase()).toContain('delet');
		// Admins run the workspace but cannot delete it.
		expect(t(admin.detail).toLowerCase()).toContain('cannot delete');
		// Editors now run the campaign pipeline (send from the curated list) but
		// cannot curate senders or change settings.
		expect(t(editor.detail).toLowerCase()).toContain('send campaigns');
		expect(t(editor.detail).toLowerCase()).toContain('cannot curate senders');
	});
});

describe('roleDefinition', () => {
	it('maps each known role to its definition', () => {
		expect(t(roleDefinition('owner').label)).toBe('Owner');
		expect(t(roleDefinition('admin').label)).toBe('Admin');
		expect(t(roleDefinition('editor').label)).toBe('Editor');
	});

	it('falls back to the editor floor for an unknown role', () => {
		expect(roleDefinition('superuser').role).toBe('editor');
	});
});

describe('mailboxStatusMeta', () => {
	it('labels each mailbox status', () => {
		expect(t(mailboxStatusMeta('hosted').label)).toBe('Hosted');
		expect(t(mailboxStatusMeta('external').label)).toBe('External');
		expect(t(mailboxStatusMeta('external-instance').label)).toBe('External, sends here');
		expect(t(mailboxStatusMeta('none').label)).toBe('No mailbox');
	});

	it('treats an absent status as no mailbox', () => {
		expect(t(mailboxStatusMeta(undefined).label)).toBe('No mailbox');
		expect(t(mailboxStatusMeta(null).label)).toBe('No mailbox');
	});

	it('uses design-token tone classes, never raw colors', () => {
		const statuses: MemberMailboxStatus[] = ['hosted', 'external', 'external-instance', 'none'];
		for (const status of statuses) {
			const meta = mailboxStatusMeta(status);
			expect(meta.toneClass).toMatch(/^text-text-/);
			expect(meta.icon.startsWith('lucide:')).toBe(true);
			expect(t(meta.description)).not.toBe(meta.description);
		}
	});
});
