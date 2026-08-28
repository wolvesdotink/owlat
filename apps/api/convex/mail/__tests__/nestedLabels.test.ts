/**
 * Nested labels (idea 38) — path creation, reparenting, ordering, pinning, the
 * unread tally and what happens to a branch when its middle is deleted.
 *
 * The properties worth pinning are the ones that used to be impossible on a
 * flat wall of labels: two branches may hold the same leaf name, a reparent may
 * never close a cycle, and deleting a branch promotes its children instead of
 * quietly destroying them.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { api } from '../../_generated/api';
import { modules, seedMailbox, seedFolder, seedMessage } from './helpers.testlib';

const sessionMocks = vi.hoisted(() => ({
	userId: 'user-A',
	role: 'owner' as 'owner' | 'admin' | 'editor',
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn(async () => ({
			userId: sessionMocks.userId,
			role: sessionMocks.role,
		})),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(async () => ({
			userId: sessionMocks.userId,
			role: sessionMocks.role,
		})),
		getBetterAuthSessionWithRole: vi.fn(async () => ({
			userId: sessionMocks.userId,
			role: sessionMocks.role,
			activeOrganizationId: 'org-1',
		})),
	};
});

beforeEach(() => {
	sessionMocks.userId = 'user-A';
	sessionMocks.role = 'owner';
});

async function byName(t: TestConvex<typeof schema>, mailboxId: Id<'mailboxes'>) {
	const list = await t.query(api.mail.labels.list, { mailboxId });
	return new Map(list.map((row) => [row.name, row]));
}

describe('mail.labels.create with a path', () => {
	it('creates every missing ancestor and returns the leaf', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);

		const acme = await t.mutation(api.mail.labels.create, {
			mailboxId,
			name: 'Work/Clients/Acme',
			color: '#ff8800',
		});

		const labels = await byName(t, mailboxId);
		expect([...labels.keys()].sort()).toEqual(['Acme', 'Clients', 'Work']);
		expect(labels.get('Acme')?._id).toBe(acme);
		expect(labels.get('Work')?.parentId).toBeUndefined();
		expect(labels.get('Clients')?.parentId).toBe(labels.get('Work')?._id);
		expect(labels.get('Acme')?.parentId).toBe(labels.get('Clients')?._id);
		// Only the leaf is the label the user picked a colour for; the ancestors
		// are scaffolding created on the way down.
		expect(labels.get('Acme')?.color).toBe('#ff8800');
		expect(labels.get('Work')?.color).toBeUndefined();
	});

	it('reuses existing ancestors rather than duplicating them', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await t.mutation(api.mail.labels.create, { mailboxId, name: 'Work/Clients/Acme' });
		await t.mutation(api.mail.labels.create, { mailboxId, name: 'Work/Clients/Brightpath' });
		const list = await t.query(api.mail.labels.list, { mailboxId });
		expect(list.filter((row) => row.name === 'Work')).toHaveLength(1);
		expect(list.filter((row) => row.name === 'Clients')).toHaveLength(1);
	});

	it('allows the same leaf name under two different parents', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await t.mutation(api.mail.labels.create, { mailboxId, name: 'Work/Archive' });
		// Mailbox-wide name uniqueness would refuse this, which is exactly the
		// restriction nesting exists to lift.
		await expect(
			t.mutation(api.mail.labels.create, { mailboxId, name: 'Personal/Archive' })
		).resolves.toBeDefined();
	});

	it('still refuses an exact duplicate leaf', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await t.mutation(api.mail.labels.create, { mailboxId, name: 'Work/Clients' });
		await expect(
			t.mutation(api.mail.labels.create, { mailboxId, name: 'Work/Clients' })
		).rejects.toThrow();
	});

	it('refuses to nest past the depth bound', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await expect(
			t.mutation(api.mail.labels.create, { mailboxId, name: 'a/b/c/d/e/f/g' })
		).rejects.toThrow();
	});

	it('appends each sibling after the last', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await t.mutation(api.mail.labels.create, { mailboxId, name: 'first' });
		await t.mutation(api.mail.labels.create, { mailboxId, name: 'second' });
		const labels = await byName(t, mailboxId);
		expect(labels.get('first')?.order).toBe(0);
		expect(labels.get('second')?.order).toBe(1);
	});
});

describe('mail.labels.update nesting', () => {
	it('reparents, detaches and pins', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		const work = await t.mutation(api.mail.labels.create, { mailboxId, name: 'Work' });
		const acme = await t.mutation(api.mail.labels.create, { mailboxId, name: 'Acme' });

		await t.mutation(api.mail.labels.update, { labelId: acme, parentId: work, isPinned: true });
		let labels = await byName(t, mailboxId);
		expect(labels.get('Acme')?.parentId).toBe(work);
		expect(labels.get('Acme')?.isPinned).toBe(true);

		// `null` is the explicit "back to a root", distinct from omitting the arg.
		await t.mutation(api.mail.labels.update, { labelId: acme, parentId: null });
		labels = await byName(t, mailboxId);
		expect(labels.get('Acme')?.parentId).toBeUndefined();
	});

	it('refuses a reparent that would close a cycle', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await t.mutation(api.mail.labels.create, { mailboxId, name: 'Work/Clients/Acme' });
		const labels = await byName(t, mailboxId);
		const work = labels.get('Work')!._id;
		const acme = labels.get('Acme')!._id;

		// Work under its own grandchild would detach the whole ring from every
		// root, and the tree build would silently stop rendering all three.
		await expect(
			t.mutation(api.mail.labels.update, { labelId: work, parentId: acme })
		).rejects.toThrow();
		await expect(
			t.mutation(api.mail.labels.update, { labelId: work, parentId: work })
		).rejects.toThrow();
	});

	it('scopes rename uniqueness to the siblings, not the mailbox', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await t.mutation(api.mail.labels.create, { mailboxId, name: 'Work/Archive' });
		const personal = await t.mutation(api.mail.labels.create, { mailboxId, name: 'Personal/Old' });
		await expect(
			t.mutation(api.mail.labels.update, { labelId: personal, name: 'Archive' })
		).resolves.toBeNull();
	});
});

describe('mail.labels.reorder', () => {
	it('stamps the order the caller sent', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		const a = await t.mutation(api.mail.labels.create, { mailboxId, name: 'a' });
		const b = await t.mutation(api.mail.labels.create, { mailboxId, name: 'b' });
		const c = await t.mutation(api.mail.labels.create, { mailboxId, name: 'c' });

		await t.mutation(api.mail.labels.reorder, { mailboxId, labelIds: [c, a, b] });
		const labels = await byName(t, mailboxId);
		expect([labels.get('c')?.order, labels.get('a')?.order, labels.get('b')?.order]).toEqual([
			0, 1, 2,
		]);
	});

	it('skips an id from another mailbox instead of failing the batch', async () => {
		const t = convexTest(schema, modules);
		const mine = await seedMailbox(t, { address: 'mine@hinterland.camp' });
		const other = await seedMailbox(t, { address: 'other@hinterland.camp' });
		const a = await t.mutation(api.mail.labels.create, { mailboxId: mine, name: 'a' });
		const foreign = await t.mutation(api.mail.labels.create, { mailboxId: other, name: 'x' });

		await t.mutation(api.mail.labels.reorder, { mailboxId: mine, labelIds: [foreign, a] });
		const labels = await byName(t, mine);
		expect(labels.get('a')?.order).toBe(1);
		expect((await byName(t, other)).get('x')?.order).toBe(0);
	});
});

describe('mail.labels.remove', () => {
	it('promotes the children of a deleted branch instead of destroying them', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await t.mutation(api.mail.labels.create, { mailboxId, name: 'Work/Clients/Acme' });
		const labels = await byName(t, mailboxId);

		await t.mutation(api.mail.labels.remove, { labelId: labels.get('Clients')!._id });

		const after = await byName(t, mailboxId);
		expect([...after.keys()].sort()).toEqual(['Acme', 'Work']);
		// Acme rises to where Clients was, not to a root and not into nothing.
		expect(after.get('Acme')?.parentId).toBe(labels.get('Work')!._id);
	});
});

describe('mail.labels.unreadCounts', () => {
	it('tallies unread mail per label and skips read mail', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId);
		const work = await t.mutation(api.mail.labels.create, { mailboxId, name: 'Work' });
		const acme = await t.mutation(api.mail.labels.create, { mailboxId, name: 'Acme' });

		const unread = await seedMessage(t, mailboxId, { subject: 'unread' });
		const read = await seedMessage(t, mailboxId, { subject: 'read' });
		await t.run(async (ctx) => {
			await ctx.db.patch(unread, { labelIds: [work, acme] });
			await ctx.db.patch(read, { labelIds: [work], flagSeen: true });
		});

		const { counts, isTruncated } = await t.query(api.mail.labels.unreadCounts, { mailboxId });
		expect(counts[work]).toBe(1);
		expect(counts[acme]).toBe(1);
		expect(isTruncated).toBe(false);
	});

	it('returns nothing for a mailbox the caller cannot read', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { userId: 'user-A' });
		sessionMocks.userId = 'user-B';
		sessionMocks.role = 'editor';
		expect(await t.query(api.mail.labels.unreadCounts, { mailboxId })).toEqual({
			counts: {},
			isTruncated: false,
		});
	});
});
