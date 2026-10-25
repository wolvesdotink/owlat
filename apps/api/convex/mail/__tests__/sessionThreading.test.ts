/**
 * Mail handlers take the caller from the session their builder floor resolved
 * (the handler's third argument) instead of resolving it again.
 *
 * One mutable session drives every floor mock, so each case can assert the
 * same access decisions the handlers made before (role gates, org binding,
 * owner scoping) and, by call count, that the floor was the only resolution.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { api } from '../../_generated/api';
import * as sessionOrganization from '../../lib/sessionOrganization';
import { enableFeatures } from '../../__tests__/factories';
import { modules, seedMailbox } from './helpers.testlib';

const sessionMock = vi.hoisted(() => ({
	userId: 'admin-user',
	role: 'admin' as 'owner' | 'admin' | 'editor',
	orgId: 'org-1',
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof import('../../lib/sessionOrganization')>(
		'../../lib/sessionOrganization'
	);
	const current = () => ({
		userId: sessionMock.userId,
		role: sessionMock.role,
		activeOrganizationId: sessionMock.orgId,
	});
	const gate = (permission: Parameters<typeof actual.hasPermission>[1], message?: string) => {
		actual.requirePermission(actual.hasPermission(sessionMock.role, permission), message);
		return current();
	};
	return {
		...actual,
		requireOrgMember: vi.fn(async () => current()),
		getMutationContext: vi.fn(async () => current()),
		requireAdminContext: vi.fn(async (_ctx: unknown, message?: string) =>
			gate('organization:manage', message ?? 'Only owners and admins can perform this action')
		),
		requireOrgPermission: vi.fn(
			async (
				_ctx: unknown,
				permission: Parameters<typeof actual.hasPermission>[1],
				message?: string
			) => gate(permission, message)
		),
		getBetterAuthSessionWithRole: vi.fn(async () => current()),
		getUserIdFromSession: vi.fn(async () => sessionMock.userId),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
	};
});

const floors = {
	query: vi.mocked(sessionOrganization.requireOrgMember),
	mutation: vi.mocked(sessionOrganization.getMutationContext),
};
const reResolvers = {
	requireAdminContext: vi.mocked(sessionOrganization.requireAdminContext),
	requireOrgPermission: vi.mocked(sessionOrganization.requireOrgPermission),
	getBetterAuthSessionWithRole: vi.mocked(sessionOrganization.getBetterAuthSessionWithRole),
	getUserIdFromSession: vi.mocked(sessionOrganization.getUserIdFromSession),
};

function setSession(userId: string, role: 'owner' | 'admin' | 'editor', orgId = 'org-1') {
	sessionMock.userId = userId;
	sessionMock.role = role;
	sessionMock.orgId = orgId;
}

function clearSessionMocks() {
	for (const mock of [floors.query, floors.mutation, ...Object.values(reResolvers)]) {
		mock.mockClear();
	}
}

function expectOnlyFloorResolutions(counts: { queries?: number; mutations?: number }) {
	expect(floors.query).toHaveBeenCalledTimes(counts.queries ?? 0);
	expect(floors.mutation).toHaveBeenCalledTimes(counts.mutations ?? 0);
	for (const mock of Object.values(reResolvers)) expect(mock).not.toHaveBeenCalled();
}

async function mailboxesOf(t: TestConvex<typeof schema>, userId: string) {
	return await t.run((ctx) =>
		ctx.db
			.query('mailboxes')
			.withIndex('by_user', (q) => q.eq('userId', userId))
			.collect()
	);
}

beforeEach(() => {
	setSession('admin-user', 'admin');
});

describe('memberMailboxStatus.byMembers', () => {
	it('scopes rows to the floor session org and resolves once', async () => {
		const t = convexTest(schema, modules);
		await seedMailbox(t, { userId: 'user-B', address: 'b@owlat.test', kind: 'hosted' });
		await seedMailbox(t, {
			userId: 'user-C',
			address: 'c@other.test',
			kind: 'hosted',
			organizationId: 'org-2',
		});
		clearSessionMocks();

		const statuses = await t.query(api.mail.memberMailboxStatus.byMembers, {
			userIds: ['user-B', 'user-C'],
		});

		expect(statuses).toEqual({ 'user-B': 'hosted', 'user-C': 'none' });
		expectOnlyFloorResolutions({ queries: 1 });
	});
});

describe('handlingRules writes', () => {
	const rule = {
		instruction: 'always decline recruiters',
		matcher: { senders: ['recruit.io'] },
		action: { type: 'draft_with_stance' as const, stance: 'a polite decline' },
	};

	it('refuse an editor with the existing messages and write nothing', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.autonomy']);
		const ruleId = await t.mutation(api.mail.handlingRules.create, rule);

		setSession('editor-user', 'editor');
		await expect(t.mutation(api.mail.handlingRules.create, rule)).rejects.toThrow(
			'Only owners and admins can change handling rules'
		);
		await expect(
			t.mutation(api.mail.handlingRules.update, { ruleId, isEnabled: false })
		).rejects.toThrow('Only owners and admins can change handling rules');
		await expect(t.mutation(api.mail.handlingRules.remove, { ruleId })).rejects.toThrow(
			'Only owners and admins can delete handling rules'
		);

		const rows = await t.run((ctx) => ctx.db.query('handlingRules').collect());
		expect(rows.map((r) => [r._id, r.isEnabled])).toEqual([[ruleId, true]]);
	});

	it('let an admin create, update and remove with one resolution per call', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.autonomy']);
		clearSessionMocks();

		const ruleId = await t.mutation(api.mail.handlingRules.create, rule);
		await t.mutation(api.mail.handlingRules.update, { ruleId, isEnabled: false });
		await t.mutation(api.mail.handlingRules.remove, { ruleId });

		expect(await t.run((ctx) => ctx.db.query('handlingRules').collect())).toHaveLength(0);
		expectOnlyFloorResolutions({ mutations: 3 });
	});
});

describe('mailbox.identity.create', () => {
	it('refuses an editor and provisions nothing', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		setSession('editor-user', 'editor');

		await expect(
			t.mutation(api.mail.mailbox.identity.create, {
				userId: 'user-B',
				address: 'b@owlat.test',
			})
		).rejects.toThrow('Only owners and admins can perform this action');
		expect(await mailboxesOf(t, 'user-B')).toHaveLength(0);
	});

	it('provisions into the floor session org with one resolution', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		clearSessionMocks();

		await t.mutation(api.mail.mailbox.identity.create, {
			userId: 'user-B',
			address: 'b@owlat.test',
		});

		const rows = await mailboxesOf(t, 'user-B');
		expect(rows.map((r) => [r.address, r.organizationId])).toEqual([['b@owlat.test', 'org-1']]);
		expectOnlyFloorResolutions({ mutations: 1 });
	});
});

describe('appPasswords.revokeAll', () => {
	async function seedAppPassword(t: TestConvex<typeof schema>, mailboxId: Id<'mailboxes'>) {
		return await t.run((ctx) =>
			ctx.db.insert('mailAppPasswords', {
				mailboxId,
				userId: 'user-B',
				label: 'phone',
				passwordHash: 'salt:hash',
				passwordPrefix: 'abcd',
				scopes: ['imap'],
				createdAt: Date.now(),
			})
		);
	}

	it('refuses an editor, and an admin of another org, leaving the credential live', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { userId: 'user-B', address: 'b@owlat.test' });
		const passwordId = await seedAppPassword(t, mailboxId);

		setSession('editor-user', 'editor');
		await expect(t.mutation(api.mail.appPasswords.revokeAll, { mailboxId })).rejects.toThrow(
			'Only owners and admins can perform this action'
		);
		setSession('foreign-admin', 'admin', 'org-2');
		await expect(t.mutation(api.mail.appPasswords.revokeAll, { mailboxId })).rejects.toThrow(
			'Mailbox not accessible'
		);

		const row = await t.run((ctx) => ctx.db.get(passwordId));
		expect(row?.revokedAt).toBeUndefined();
	});

	it('revokes for an admin of the mailbox org with one resolution', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { userId: 'user-B', address: 'b@owlat.test' });
		const passwordId = await seedAppPassword(t, mailboxId);
		clearSessionMocks();

		await t.mutation(api.mail.appPasswords.revokeAll, { mailboxId });

		const row = await t.run((ctx) => ctx.db.get(passwordId));
		expect(row?.revokedAt).toEqual(expect.any(Number));
		expectOnlyFloorResolutions({ mutations: 1 });
	});
});

describe('draft streams', () => {
	it('stay owned by the floor user: another member can neither read nor delete one', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		setSession('user-A', 'editor');
		clearSessionMocks();

		const streamId = await t.mutation(api.mail.draftStreamStore.createDraftStream, {
			surface: 'compose',
		});
		expect(await t.query(api.mail.draftStreamStore.getDraftStream, { streamId })).toMatchObject({
			_id: streamId,
			status: 'streaming',
		});
		expectOnlyFloorResolutions({ queries: 1, mutations: 1 });

		setSession('user-B', 'admin');
		expect(await t.query(api.mail.draftStreamStore.getDraftStream, { streamId })).toBeNull();
		await expect(
			t.mutation(api.mail.draftStreamStore.deleteDraftStream, { streamId })
		).rejects.toThrow('You do not own this draft stream');

		setSession('user-A', 'editor');
		await t.mutation(api.mail.draftStreamStore.deleteDraftStream, { streamId });
		expect(await t.run((ctx) => ctx.db.get(streamId))).toBeNull();
	});
});

describe('settings.update and mailboxRequest.freshStartStatus', () => {
	it('key the caller by the floor session', async () => {
		const t = convexTest(schema, modules);
		await seedMailbox(t, { userId: 'user-A', address: 'a@owlat.test' });
		setSession('user-A', 'editor');
		clearSessionMocks();

		await t.mutation(api.mail.settings.update, { isSendSoundOn: false });
		const status = await t.query(api.mail.mailboxRequest.freshStartStatus, {});

		expect(status.hasMailbox).toBe(true);
		const settings = await t.run((ctx) => ctx.db.query('mailUserSettings').collect());
		expect(settings.map((s) => [s.userId, s.isSendSoundOn])).toEqual([['user-A', false]]);
		expectOnlyFloorResolutions({ queries: 1, mutations: 1 });
	});
});
