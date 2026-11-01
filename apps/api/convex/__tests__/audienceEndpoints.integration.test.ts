/**
 * The segment and blocklist endpoints (`segments/segments`,
 * `blockedEmails/blocklist`, `blockedEmails/events`): what each reads and
 * writes, what it schedules, and the auth floor each keeps. The clock is faked
 * so writes stamp fixed times; scheduled work is read by the function it
 * targets and never run.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Infer } from 'convex/values';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import type { segmentFiltersValidator } from '../lib/convexValidators';

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

/** The rows a write leaves behind, without their ids, plus the function each scheduled job targets. */
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

describe('segment endpoints', () => {
	it('create, update and remove write the segment, log each write and refresh its count', async () => {
		const { t } = await seeded();
		const id = await t.mutation(api.segments.segments.create, {
			name: 'Readers',
			description: 'Read a lot',
			filters: acmeFilters,
		});
		expect((await written(t)).segments.map((row) => row.name)).toEqual(['Acme', 'Readers']);

		await t.mutation(api.segments.segments.update, { id, name: 'Renamed', filters: acmeFilters });
		expect((await written(t)).segments.map((row) => row.name)).toEqual(['Acme', 'Renamed']);

		await t.mutation(api.segments.segments.remove, { id });
		const after = await written(t);
		expect(after.segments.map((row) => row.name)).toEqual(['Acme']);
		expect(after.auditLogs.map((row) => row.action)).toEqual([
			'segment.created',
			'segment.updated',
			'segment.deleted',
		]);
		expect(after.scheduled).toEqual([
			'segments/countRefresh:refreshSingleSegmentCount',
			'segments/countRefresh:refreshSingleSegmentCount',
		]);
	});

	it('the reads answer the saved segment and its matching members', async () => {
		const { t, segmentId } = await seeded();
		const page = { paginationOpts: { numItems: 10, cursor: null } };

		const segment = await t.query(api.segments.segments.get, { id: segmentId });
		expect(segment).toMatchObject({ name: 'Acme' });
		expect(await t.query(internal.segments.segments.getInternal, { id: segmentId })).toEqual(
			segment
		);

		const list = await t.query(api.segments.segments.list, page);
		expect(list.page.map((row) => row.name)).toEqual(['Acme']);

		const members = await t.query(api.segments.segments.listMembers, { id: segmentId, ...page });
		expect(members.page.map((row) => row.email).sort()).toEqual([
			'ada@acme.example',
			'grace@acme.example',
		]);
		// The member view still strips the DOI bearer token.
		expect(members.page.every((row) => !('doiConfirmationToken' in row))).toBe(true);

		const pageArgs = { filters: acmeFilters, cursor: null, numItems: 10 };
		const memberPage = await t.query(internal.segments.segments.listMembersPage, pageArgs);
		expect(memberPage.members).toHaveLength(2);

		const countArgs = { filters: acmeFilters, cursor: null };
		const countPage = await t.query(
			internal.segments.segments.countMatchingContactsPage,
			countArgs
		);
		expect(countPage).toMatchObject({ matched: 2, isDone: true });
	});

	it('the export and the count actions answer the matching members', async () => {
		const { t, segmentId } = await seeded();

		const exported = await t.action(api.segments.segments.listMembersForExport, { id: segmentId });
		expect(exported.truncated).toBe(false);
		expect(exported.members.map((row) => row.email).sort()).toEqual([
			'ada@acme.example',
			'grace@acme.example',
		]);
		expect(exported.members.every((row) => !('doiConfirmationToken' in row))).toBe(true);

		expect(
			await t.action(api.segments.segments.countMatchingContacts, { filters: acmeFilters })
		).toBe(2);
	});

	it('keep the segments:manage write floor and the member read floor', async () => {
		const { t, segmentId } = await seeded();
		const refused = /Only owners and admins/;

		session.role = 'editor';
		await expect(
			t.mutation(api.segments.segments.create, { name: 'Nope', filters: acmeFilters })
		).rejects.toThrow(refused);
		await expect(
			t.mutation(api.segments.segments.update, { id: segmentId, name: 'Nope' })
		).rejects.toThrow(refused);
		await expect(t.mutation(api.segments.segments.remove, { id: segmentId })).rejects.toThrow(
			refused
		);
		// An editor still reads segments, as every member does.
		expect(await t.query(api.segments.segments.get, { id: segmentId })).toMatchObject({
			name: 'Acme',
		});

		session.isMember = false;
		const notMember = /not an org member/;
		await expect(t.query(api.segments.segments.get, { id: segmentId })).rejects.toThrow(notMember);
		await expect(
			t.query(api.segments.segments.list, { paginationOpts: { numItems: 10, cursor: null } })
		).rejects.toThrow(notMember);
		await expect(
			t.action(api.segments.segments.listMembersForExport, { id: segmentId })
		).rejects.toThrow(notMember);
		await expect(
			t.action(api.segments.segments.countMatchingContacts, { filters: acmeFilters })
		).rejects.toThrow(notMember);
		expect((await written(t)).segments.map((row) => row.name)).toEqual(['Acme']);
	});
});

describe('blocklist endpoints', () => {
	it('add, bulkAdd and remove write the blocklist and log each write', async () => {
		const t = convexTest(schema, modules);
		const id = await t.mutation(api.blockedEmails.blocklist.add, {
			email: 'Blocked@Example.com',
			reason: 'manual',
			notes: 'asked',
		});
		expect(
			await t.mutation(api.blockedEmails.blocklist.bulkAdd, {
				emails: [
					{ email: 'one@example.com', reason: 'bounced' },
					{ email: 'not-an-address', reason: 'manual' },
				],
			})
		).toMatchObject({ added: 1, skipped: 1 });
		expect((await written(t)).blockedEmails.map((row) => row.email).sort()).toEqual([
			'blocked@example.com',
			'one@example.com',
		]);

		await t.mutation(api.blockedEmails.blocklist.remove, { blockedEmailId: id });
		const after = await written(t);
		expect(after.blockedEmails.map((row) => row.email)).toEqual(['one@example.com']);
		expect(after.auditLogs.map((row) => row.action)).toEqual([
			'blocklist.added',
			'blocklist.added',
			'blocklist.removed',
		]);
	});

	it('addFromEvent records a provider suppression once, and a replay answers the same row', async () => {
		const t = convexTest(schema, modules);
		const event = {
			email: 'Complainer@Example.com',
			reason: 'complained' as const,
			provenance: { provider: 'mandrill', source: 'webhook' as const, evidence: 'SPAM' },
		};

		const id = await t.mutation(internal.blockedEmails.events.addFromEvent, event);
		expect(id).not.toBeNull();
		expect(await t.mutation(internal.blockedEmails.events.addFromEvent, event)).toBe(id);
		const after = await written(t);
		expect(after.blockedEmails.map((row) => [row.email, row.reason])).toEqual([
			['complainer@example.com', 'complained'],
		]);
		expect(after.auditLogs.map((row) => row.action)).toEqual(['blocklist.provider_suppressed']);
	});

	it('the reads answer the blocklist, filtered, by address, counted and with provenance', async () => {
		const t = convexTest(schema, modules);
		await t.mutation(api.blockedEmails.blocklist.add, { email: 'a@example.com', reason: 'manual' });
		await t.mutation(internal.blockedEmails.events.addFromEvent, {
			email: 'b@example.com',
			reason: 'bounced',
			provenance: { provider: 'mandrill', source: 'import' },
		});

		const all = await t.query(api.blockedEmails.blocklist.listByTeam, {});
		expect(all.map((row) => row.email).sort()).toEqual(['a@example.com', 'b@example.com']);
		const bounced = await t.query(api.blockedEmails.blocklist.listByTeam, { reason: 'bounced' });
		expect(bounced.map((row) => row.email)).toEqual(['b@example.com']);

		expect(
			await t.query(api.blockedEmails.blocklist.getByEmail, { email: 'A@Example.com' })
		).toMatchObject({ email: 'a@example.com', reason: 'manual' });

		expect(await t.query(api.blockedEmails.blocklist.getCountsByReason, {})).toMatchObject({
			total: 2,
			manual: 1,
			bounced: 1,
		});

		expect(await t.query(api.blockedEmails.blocklist.listProviderProvenance, {})).toMatchObject([
			{ provider: 'mandrill', source: 'import', evidence: null },
		]);
	});

	it('keep the contacts:manage, organization:manage and member floors', async () => {
		const t = convexTest(schema, modules);
		const blockedEmailId = await t.mutation(api.blockedEmails.blocklist.add, {
			email: 'kept@example.com',
			reason: 'manual',
		});
		const refused = /Only owners and admins can manage the blocklist/;

		session.role = 'editor';
		await expect(
			t.mutation(api.blockedEmails.blocklist.add, { email: 'new@example.com', reason: 'manual' })
		).rejects.toThrow(refused);
		await expect(
			t.mutation(api.blockedEmails.blocklist.bulkAdd, {
				emails: [{ email: 'new@example.com', reason: 'manual' }],
			})
		).rejects.toThrow(refused);
		await expect(
			t.mutation(api.blockedEmails.blocklist.remove, { blockedEmailId })
		).rejects.toThrow(refused);
		// The provider evidence is an admin read; the list itself is not.
		await expect(t.query(api.blockedEmails.blocklist.listProviderProvenance, {})).rejects.toThrow();
		expect(await t.query(api.blockedEmails.blocklist.listByTeam, {})).toHaveLength(1);

		session.isMember = false;
		const notMember = /not an org member/;
		await expect(t.query(api.blockedEmails.blocklist.listByTeam, {})).rejects.toThrow(notMember);
		await expect(
			t.query(api.blockedEmails.blocklist.getByEmail, { email: 'kept@example.com' })
		).rejects.toThrow(notMember);
		await expect(t.query(api.blockedEmails.blocklist.getCountsByReason, {})).rejects.toThrow(
			notMember
		);
		expect((await written(t)).blockedEmails.map((row) => row.email)).toEqual(['kept@example.com']);
	});
});
