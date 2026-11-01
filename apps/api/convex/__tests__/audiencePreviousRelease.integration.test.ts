/**
 * The previous release's segment and blocklist paths (`segments:*`,
 * `blockedEmails:*`) keep working against this release: each old path takes
 * the same arguments, declares the same result, keeps its auth floor, and reads
 * and writes what its moved function in `segments/segments`,
 * `blockedEmails/blocklist` or `blockedEmails/events` does.
 *
 * Writes are compared across two fresh deployments seeded alike, one driven
 * through the old path and one through the new, with the clock faked so both
 * stamp the same times. Scheduled work is compared by the function it targets
 * and never run.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Infer } from 'convex/values';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import type { segmentFiltersValidator } from '../lib/convexValidators';
import * as oldSegments from '../segments';
import * as oldBlockedEmails from '../blockedEmails';
import * as segments from '../segments/segments';
import * as blocklist from '../blockedEmails/blocklist';
import * as blockEvents from '../blockedEmails/events';

const session = vi.hoisted(() => ({
	role: 'owner' as 'owner' | 'admin' | 'editor',
	isMember: true,
}));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<Record<string, unknown>>('../lib/sessionOrganization');
	const member = () => {
		if (!session.isMember) throw new Error('forbidden: not an org member');
		return { userId: 'test-user', role: session.role, activeOrganizationId: 'org-1' };
	};
	return {
		...actual,
		requireOrgMember: vi.fn(async () => member()),
		getMutationContext: vi.fn(async () => member()),
		isActiveOrgMember: vi.fn(async () => session.isMember),
	};
});

const modules = import.meta.glob('../**/*.*s');
const NOW = Date.UTC(2026, 9, 1, 12);

type T = TestConvex<typeof schema>;

const acmeFilters: Infer<typeof segmentFiltersValidator> = {
	logic: 'AND',
	conditions: [{ kind: 'contact_property', field: 'email', operator: 'contains', value: 'acme' }],
};

beforeEach(() => {
	session.role = 'owner';
	session.isMember = true;
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
});

afterEach(() => {
	vi.useRealTimers();
});

async function insertContact(ctx: MutationCtx, email: string) {
	return await ctx.db.insert('contacts', {
		email,
		source: 'api',
		doiStatus: 'not_required',
		doiConfirmationToken: `token-${email}`,
		createdAt: NOW,
		updatedAt: NOW,
	});
}

/** A deployment with three contacts (two match `acmeFilters`) and one saved segment. */
async function seeded(): Promise<{ t: T; segmentId: Id<'segments'> }> {
	const t = convexTest(schema, modules);
	const segmentId = await t.run(async (ctx) => {
		await insertContact(ctx, 'ada@acme.example');
		await insertContact(ctx, 'grace@acme.example');
		await insertContact(ctx, 'alan@other.example');
		return await ctx.db.insert('segments', {
			name: 'Acme',
			filters: acmeFilters,
			createdAt: NOW,
			updatedAt: NOW,
		});
	});
	return { t, segmentId };
}

/**
 * The rows a write leaves behind, without the ids two deployments assign
 * independently, plus the function each scheduled job targets.
 */
async function written(t: T) {
	return await t.run(async (ctx) => {
		const strip = <R extends { _id: unknown; _creationTime: unknown }>(row: R) => {
			const { _id, _creationTime, ...rest } = row;
			return rest;
		};
		return {
			segments: (await ctx.db.query('segments').collect()).map(strip),
			blockedEmails: (await ctx.db.query('blockedEmails').collect()).map(strip),
			auditLogs: (await ctx.db.query('auditLogs').collect()).map((row) => {
				const { resourceId, ...rest } = strip(row);
				return rest;
			}),
			scheduled: (await ctx.db.system.query('_scheduled_functions').collect()).map(
				(job) => job.name
			),
		};
	});
}

describe('previous-release audience paths: shapes', () => {
	it('keep the builder kind, visibility, arguments and result of the moved functions', () => {
		const shape = (fn: unknown) => {
			const registered = fn as {
				isQuery?: boolean;
				isMutation?: boolean;
				isAction?: boolean;
				isPublic?: boolean;
				isInternal?: boolean;
				exportArgs(): string;
				exportReturns(): string;
			};
			return {
				kind: [registered.isQuery, registered.isMutation, registered.isAction],
				visibility: [registered.isPublic, registered.isInternal],
				args: registered.exportArgs(),
				returns: registered.exportReturns(),
			};
		};
		const pairs: [unknown, unknown][] = [
			[oldSegments.get, segments.get],
			[oldSegments.list, segments.list],
			[oldSegments.listMembers, segments.listMembers],
			[oldSegments.listMembersForExport, segments.listMembersForExport],
			[oldSegments.create, segments.create],
			[oldSegments.update, segments.update],
			[oldSegments.remove, segments.remove],
			[oldSegments.countMatchingContacts, segments.countMatchingContacts],
			[oldSegments.getInternal, segments.getInternal],
			[oldSegments.listMembersPage, segments.listMembersPage],
			[oldSegments.countMatchingContactsPage, segments.countMatchingContactsPage],
			[oldBlockedEmails.listByTeam, blocklist.listByTeam],
			[oldBlockedEmails.listProviderProvenance, blocklist.listProviderProvenance],
			[oldBlockedEmails.getByEmail, blocklist.getByEmail],
			[oldBlockedEmails.add, blocklist.add],
			[oldBlockedEmails.remove, blocklist.remove],
			[oldBlockedEmails.bulkAdd, blocklist.bulkAdd],
			[oldBlockedEmails.getCountsByReason, blocklist.getCountsByReason],
			[oldBlockedEmails.addFromEvent, blockEvents.addFromEvent],
		];
		expect(pairs).toHaveLength(19);
		for (const [old, moved] of pairs) expect(shape(old)).toEqual(shape(moved));
		// Every root export is one of the pairs above: no old path was dropped.
		expect(Object.keys(oldSegments).sort()).toEqual(
			[
				'countMatchingContacts',
				'countMatchingContactsPage',
				'create',
				'get',
				'getInternal',
				'list',
				'listMembers',
				'listMembersForExport',
				'listMembersPage',
				'remove',
				'update',
			].sort()
		);
		expect(Object.keys(oldBlockedEmails).sort()).toEqual(
			[
				'add',
				'addFromEvent',
				'bulkAdd',
				'getByEmail',
				'getCountsByReason',
				'listByTeam',
				'listProviderProvenance',
				'remove',
			].sort()
		);
	});
});

describe('previous-release segment paths', () => {
	it('segments:create, update and remove write what segments/segments does', async () => {
		const created = { name: 'Readers', description: 'Read a lot', filters: acmeFilters };
		const old = await seeded();
		const moved = await seeded();

		const oldId = await old.t.mutation(api.segments.create, created);
		const newId = await moved.t.mutation(api.segments.segments.create, created);
		expect(await written(old.t)).toEqual(await written(moved.t));

		await old.t.mutation(api.segments.update, { id: oldId, name: 'Renamed', filters: acmeFilters });
		await moved.t.mutation(api.segments.segments.update, {
			id: newId,
			name: 'Renamed',
			filters: acmeFilters,
		});
		expect(await written(old.t)).toEqual(await written(moved.t));

		await old.t.mutation(api.segments.remove, { id: oldId });
		await moved.t.mutation(api.segments.segments.remove, { id: newId });
		const after = await written(old.t);
		expect(after).toEqual(await written(moved.t));
		expect(after.auditLogs.map((row) => row.action)).toEqual([
			'segment.created',
			'segment.updated',
			'segment.deleted',
		]);
		// The old path schedules the refresh this release runs, not a root path.
		expect(after.scheduled).toEqual([
			'segments/countRefresh:refreshSingleSegmentCount',
			'segments/countRefresh:refreshSingleSegmentCount',
		]);
	});

	it('the old segment reads answer what segments/segments answers', async () => {
		const { t, segmentId } = await seeded();
		const page = { paginationOpts: { numItems: 10, cursor: null } };

		const segment = await t.query(api.segments.get, { id: segmentId });
		expect(segment).toMatchObject({ name: 'Acme' });
		expect(segment).toEqual(await t.query(api.segments.segments.get, { id: segmentId }));
		expect(await t.query(internal.segments.getInternal, { id: segmentId })).toEqual(segment);

		const list = await t.query(api.segments.list, page);
		expect(list.page.map((row) => row.name)).toEqual(['Acme']);
		expect(list).toEqual(await t.query(api.segments.segments.list, page));

		const members = await t.query(api.segments.listMembers, { id: segmentId, ...page });
		expect(members.page.map((row) => row.email).sort()).toEqual([
			'ada@acme.example',
			'grace@acme.example',
		]);
		// The member view still strips the DOI bearer token.
		expect(members.page.every((row) => !('doiConfirmationToken' in row))).toBe(true);
		expect(members).toEqual(
			await t.query(api.segments.segments.listMembers, { id: segmentId, ...page })
		);

		const pageArgs = { filters: acmeFilters, cursor: null, numItems: 10 };
		const memberPage = await t.query(internal.segments.listMembersPage, pageArgs);
		expect(memberPage.members).toHaveLength(2);
		expect(memberPage).toEqual(await t.query(internal.segments.segments.listMembersPage, pageArgs));

		const countArgs = { filters: acmeFilters, cursor: null };
		const countPage = await t.query(internal.segments.countMatchingContactsPage, countArgs);
		expect(countPage).toMatchObject({ matched: 2, isDone: true });
		expect(countPage).toEqual(
			await t.query(internal.segments.segments.countMatchingContactsPage, countArgs)
		);
	});

	it('the old segment actions answer what segments/segments answers', async () => {
		const { t, segmentId } = await seeded();

		const exported = await t.action(api.segments.listMembersForExport, { id: segmentId });
		expect(exported.truncated).toBe(false);
		expect(exported.members.map((row) => row.email).sort()).toEqual([
			'ada@acme.example',
			'grace@acme.example',
		]);
		expect(exported.members.every((row) => !('doiConfirmationToken' in row))).toBe(true);
		expect(exported).toEqual(
			await t.action(api.segments.segments.listMembersForExport, { id: segmentId })
		);

		const count = await t.action(api.segments.countMatchingContacts, { filters: acmeFilters });
		expect(count).toBe(2);
		expect(count).toBe(
			await t.action(api.segments.segments.countMatchingContacts, { filters: acmeFilters })
		);
	});

	it('keep the segments:manage write floor and the member read floor on the old paths', async () => {
		const { t, segmentId } = await seeded();
		const refused = /Only owners and admins/;

		session.role = 'editor';
		await expect(
			t.mutation(api.segments.create, { name: 'Nope', filters: acmeFilters })
		).rejects.toThrow(refused);
		await expect(t.mutation(api.segments.update, { id: segmentId, name: 'Nope' })).rejects.toThrow(
			refused
		);
		await expect(t.mutation(api.segments.remove, { id: segmentId })).rejects.toThrow(refused);
		// An editor still reads segments, as every member does.
		expect(await t.query(api.segments.get, { id: segmentId })).toMatchObject({ name: 'Acme' });

		session.isMember = false;
		const notMember = /not an org member/;
		await expect(t.query(api.segments.get, { id: segmentId })).rejects.toThrow(notMember);
		await expect(
			t.query(api.segments.list, { paginationOpts: { numItems: 10, cursor: null } })
		).rejects.toThrow(notMember);
		await expect(t.action(api.segments.listMembersForExport, { id: segmentId })).rejects.toThrow(
			notMember
		);
		await expect(
			t.action(api.segments.countMatchingContacts, { filters: acmeFilters })
		).rejects.toThrow(notMember);
		expect((await written(t)).segments.map((row) => row.name)).toEqual(['Acme']);
	});
});

describe('previous-release blocklist paths', () => {
	it('blockedEmails:add, bulkAdd and remove write what blockedEmails/blocklist does', async () => {
		const old = convexTest(schema, modules);
		const moved = convexTest(schema, modules);
		const manual = { email: 'Blocked@Example.com', reason: 'manual' as const, notes: 'asked' };
		const bulk = {
			emails: [
				{ email: 'one@example.com', reason: 'bounced' as const },
				{ email: 'not-an-address', reason: 'manual' as const },
			],
		};

		const oldId = await old.mutation(api.blockedEmails.add, manual);
		const newId = await moved.mutation(api.blockedEmails.blocklist.add, manual);
		const oldBulk = await old.mutation(api.blockedEmails.bulkAdd, bulk);
		expect(oldBulk).toEqual(await moved.mutation(api.blockedEmails.blocklist.bulkAdd, bulk));
		expect(oldBulk).toMatchObject({ added: 1, skipped: 1 });
		expect(await written(old)).toEqual(await written(moved));

		expect(await old.mutation(api.blockedEmails.remove, { blockedEmailId: oldId })).toEqual(
			await moved.mutation(api.blockedEmails.blocklist.remove, { blockedEmailId: newId })
		);
		const after = await written(old);
		expect(after).toEqual(await written(moved));
		expect(after.blockedEmails.map((row) => row.email)).toEqual(['one@example.com']);
		expect(after.auditLogs.map((row) => row.action)).toEqual([
			'blocklist.added',
			'blocklist.added',
			'blocklist.removed',
		]);
	});

	it('blockedEmails:addFromEvent writes what blockedEmails/events:addFromEvent does', async () => {
		const old = convexTest(schema, modules);
		const moved = convexTest(schema, modules);
		const event = {
			email: 'Complainer@Example.com',
			reason: 'complained' as const,
			provenance: { provider: 'mandrill', source: 'webhook' as const, evidence: 'SPAM' },
		};

		const oldId = await old.mutation(internal.blockedEmails.addFromEvent, event);
		const newId = await moved.mutation(internal.blockedEmails.events.addFromEvent, event);
		expect(oldId).not.toBeNull();
		expect(newId).not.toBeNull();
		// A replay through the old path writes nothing and answers the same row.
		expect(await old.mutation(internal.blockedEmails.addFromEvent, event)).toBe(oldId);
		const after = await written(old);
		expect(after).toEqual(await written(moved));
		expect(after.auditLogs.map((row) => row.action)).toEqual(['blocklist.provider_suppressed']);
	});

	it('the old blocklist reads answer what blockedEmails/blocklist answers', async () => {
		const t = convexTest(schema, modules);
		await t.mutation(api.blockedEmails.blocklist.add, { email: 'a@example.com', reason: 'manual' });
		await t.mutation(internal.blockedEmails.events.addFromEvent, {
			email: 'b@example.com',
			reason: 'bounced',
			provenance: { provider: 'mandrill', source: 'import' },
		});

		const all = await t.query(api.blockedEmails.listByTeam, {});
		expect(all.map((row) => row.email).sort()).toEqual(['a@example.com', 'b@example.com']);
		expect(all).toEqual(await t.query(api.blockedEmails.blocklist.listByTeam, {}));
		const bounced = await t.query(api.blockedEmails.listByTeam, { reason: 'bounced' });
		expect(bounced.map((row) => row.email)).toEqual(['b@example.com']);
		expect(bounced).toEqual(
			await t.query(api.blockedEmails.blocklist.listByTeam, { reason: 'bounced' })
		);

		const one = await t.query(api.blockedEmails.getByEmail, { email: 'A@Example.com' });
		expect(one).toMatchObject({ email: 'a@example.com', reason: 'manual' });
		expect(one).toEqual(
			await t.query(api.blockedEmails.blocklist.getByEmail, { email: 'A@Example.com' })
		);

		const counts = await t.query(api.blockedEmails.getCountsByReason, {});
		expect(counts).toMatchObject({ total: 2, manual: 1, bounced: 1 });
		expect(counts).toEqual(await t.query(api.blockedEmails.blocklist.getCountsByReason, {}));

		const provenance = await t.query(api.blockedEmails.listProviderProvenance, {});
		expect(provenance).toMatchObject([{ provider: 'mandrill', source: 'import', evidence: null }]);
		expect(provenance).toEqual(
			await t.query(api.blockedEmails.blocklist.listProviderProvenance, {})
		);
	});

	it('keep the contacts:manage, organization:manage and member floors on the old paths', async () => {
		const t = convexTest(schema, modules);
		const blockedEmailId = await t.mutation(api.blockedEmails.blocklist.add, {
			email: 'kept@example.com',
			reason: 'manual',
		});
		const refused = /Only owners and admins can manage the blocklist/;

		session.role = 'editor';
		await expect(
			t.mutation(api.blockedEmails.add, { email: 'new@example.com', reason: 'manual' })
		).rejects.toThrow(refused);
		await expect(
			t.mutation(api.blockedEmails.bulkAdd, {
				emails: [{ email: 'new@example.com', reason: 'manual' }],
			})
		).rejects.toThrow(refused);
		await expect(t.mutation(api.blockedEmails.remove, { blockedEmailId })).rejects.toThrow(refused);
		// The provider evidence is an admin read; the list itself is not.
		await expect(t.query(api.blockedEmails.listProviderProvenance, {})).rejects.toThrow();
		expect(await t.query(api.blockedEmails.listByTeam, {})).toHaveLength(1);

		session.isMember = false;
		const notMember = /not an org member/;
		await expect(t.query(api.blockedEmails.listByTeam, {})).rejects.toThrow(notMember);
		await expect(
			t.query(api.blockedEmails.getByEmail, { email: 'kept@example.com' })
		).rejects.toThrow(notMember);
		await expect(t.query(api.blockedEmails.getCountsByReason, {})).rejects.toThrow(notMember);
		expect((await written(t)).blockedEmails.map((row) => row.email)).toEqual(['kept@example.com']);
	});
});
