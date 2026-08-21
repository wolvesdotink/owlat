/**
 * Regression tests for the DOI capability-token redaction fix.
 *
 * `contacts.doiConfirmationToken` is a capability: anyone holding it can
 * confirm double-opt-in for the contact via the public token endpoints, i.e.
 * fabricate consent evidence. GDPR export and form-submission reads already
 * stripped it; `contacts.get`, `contacts.list` and
 * `contacts.organization.listForExportByOrganization` did not, so any member
 * could harvest pending tokens at scale. These tests pin the strip on all
 * three member-readable read paths.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import { createTestContact } from './factories';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
	};
});

const modules = import.meta.glob('../**/*.*s');

async function insertPendingDoiContact(
	t: ReturnType<typeof convexTest>,
	overrides: Record<string, unknown> = {}
) {
	return t.run(async (ctx) =>
		ctx.db.insert(
			'contacts',
			createTestContact({
				doiStatus: 'pending',
				doiConfirmationToken: 'cap-token-must-never-leave-the-backend',
				doiTokenExpiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
				...overrides,
			})
		)
	);
}

describe('DOI capability-token redaction on member-readable contact reads', () => {
	it('contacts.get returns the contact without doiConfirmationToken / doiTokenExpiresAt', async () => {
		const t = convexTest(schema, modules);
		const contactId = await insertPendingDoiContact(t);

		const contact = await t.query(api.contacts.contacts.get, { contactId });

		expect(contact).not.toBeNull();
		expect(contact).not.toHaveProperty('doiConfirmationToken');
		expect(contact).not.toHaveProperty('doiTokenExpiresAt');
	});

	it('contacts.list pages never carry the token (browse path)', async () => {
		const t = convexTest(schema, modules);
		await insertPendingDoiContact(t);

		const result = await t.query(api.contacts.contacts.list, {
			paginationOpts: { numItems: 10, cursor: null },
		});

		expect(result.page.length).toBeGreaterThan(0);
		for (const contact of result.page) {
			expect(contact).not.toHaveProperty('doiConfirmationToken');
			expect(contact).not.toHaveProperty('doiTokenExpiresAt');
		}
	});

	it('contacts.list pages never carry the token (search path)', async () => {
		const t = convexTest(schema, modules);
		const contactId = await insertPendingDoiContact(t);

		const email = await t.run(async (ctx) => (await ctx.db.get(contactId))!.email!);
		const result = await t.query(api.contacts.contacts.list, {
			search: email,
			paginationOpts: { numItems: 10, cursor: null },
		});

		expect(result.page.length).toBeGreaterThan(0);
		for (const contact of result.page) {
			expect(contact).not.toHaveProperty('doiConfirmationToken');
			expect(contact).not.toHaveProperty('doiTokenExpiresAt');
		}
	});

	it('listForExportByOrganization rows never carry the token', async () => {
		const t = convexTest(schema, modules);
		await insertPendingDoiContact(t);

		const rows = await t.query(api.contacts.organization.listForExportByOrganization, {});

		expect(rows.length).toBeGreaterThan(0);
		for (const contact of rows) {
			expect(contact).not.toHaveProperty('doiConfirmationToken');
			expect(contact).not.toHaveProperty('doiTokenExpiresAt');
		}
	});

	it('the stored row keeps its token — redaction is read-side only', async () => {
		const t = convexTest(schema, modules);
		const contactId = await insertPendingDoiContact(t);

		await t.run(async (ctx) => {
			const stored = await ctx.db.get(contactId);
			expect(stored!.doiConfirmationToken).toBe('cap-token-must-never-leave-the-backend');
		});
	});
});
