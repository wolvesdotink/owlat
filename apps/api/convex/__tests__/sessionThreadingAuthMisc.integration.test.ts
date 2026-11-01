/**
 * Auth, assistant, workspace, connected-app, dev-shortcut and global-search
 * handlers take the caller from the session their builder floor resolved (the
 * handler's third argument) instead of resolving it again.
 *
 * Each case runs once as an owner, asserting by call count that the floor was
 * the only session resolution and, where the handler records who acted or which
 * tenant it acted in, that both come from the floor's session. Privileged cases
 * also run as an editor and must be refused with the message the handler used
 * before.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TestConvex } from 'convex-test';
import type schema from '../schema';
import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import * as sessionOrganization from '../lib/sessionOrganization';
import { createTestApiKey, createTestDomain, enableFeatures } from './factories';
import { newHarness } from './testModules';
import { seedFolder, seedMailbox, seedMessage } from '../mail/__tests__/helpers.testlib';
import { clearResolverCalls, expectOnlyFloor, setSession, type Floor } from './threadedSessionMock';

vi.mock('../lib/sessionOrganization', async () => {
	const { threadedSessionMock } = await import('./threadedSessionMock');
	return await threadedSessionMock();
});

type T = TestConvex<typeof schema>;

interface Case<S> {
	name: string;
	floor: Floor;
	/** The message an editor is refused with; absent for member-level handlers. */
	denied?: string;
	seed?: (t: T) => Promise<S>;
	call: (t: T, seeded: S) => Promise<unknown>;
	/** Extra assertions on what the owner's call wrote or returned. */
	check?: (t: T, seeded: S, result: unknown) => Promise<void>;
}

const defineCase = <S>(c: Case<S>) => c as unknown as Case<unknown>;

const ADMIN = 'Only owners and admins can perform this action';
const CONNECTED_APPS = 'Only owners and admins can manage connected apps';

const newConversation = (t: T) => t.mutation(api.assistant.conversations.createConversation, {});

const insertApiKey = (t: T) => t.run((ctx) => ctx.db.insert('apiKeys', createTestApiKey()));

function insertConnectedApp(
	t: T,
	status: 'enabled' | 'disabled' = 'enabled',
	organizationId = 'org-1'
): Promise<Id<'connectedApps'>> {
	return t.run((ctx) =>
		ctx.db.insert('connectedApps', {
			organizationId,
			pluginId: 'policy-pack',
			name: 'Approvals',
			endpointUrl: 'https://hooks.example.com/owlat',
			status,
			grantedCapabilities: ['send:gate'],
			secretCiphertext: 'c',
			secretIv: 'i',
			secretAuthTag: 'a',
			secretEnvelopeVersion: 1,
			secretRotatedAt: 1,
			createdByUserId: 'admin-user',
			createdAt: 1,
			updatedAt: 1,
		})
	);
}

async function lifecycleAudit(t: T, action: string) {
	const rows = await t.run((ctx) => ctx.db.query('auditLogs').collect());
	return rows
		.filter((row) => row.action === action)
		.map((row) => ({ userId: row.userId, organizationId: row.organizationId }));
}

const lifecycleCases = (
	[
		['enable', 'disabled', 'connected_app.enabled'],
		['disable', 'enabled', 'connected_app.disabled'],
		['revoke', 'enabled', 'connected_app.revoked'],
	] as const
).map(([name, from, action]) =>
	defineCase({
		name: `connectedApps.mutations.${name}`,
		floor: 'getMutationContext',
		denied: CONNECTED_APPS,
		seed: (t) => insertConnectedApp(t, from),
		call: (t, connectedAppId: Id<'connectedApps'>) =>
			t.mutation(api.connectedApps.mutations[name], { connectedAppId }),
		check: async (t) => {
			expect(await lifecycleAudit(t, action)).toEqual([
				{ userId: 'admin-user', organizationId: 'org-1' },
			]);
		},
	})
);

const cases: Case<unknown>[] = [
	defineCase({
		name: 'assistant.conversations.createConversation',
		floor: 'getMutationContext',
		call: newConversation,
		check: async (t, _seeded, id) => {
			const convo = await t.run((ctx) => ctx.db.get(id as Id<'aiConversations'>));
			expect(convo?.ownerId).toBe('admin-user');
		},
	}),
	defineCase({
		name: 'assistant.conversations.listConversations',
		floor: 'requireOrgMember',
		seed: newConversation,
		call: (t) => t.query(api.assistant.conversations.listConversations, {}),
		check: async (_t, id, rows) => {
			expect((rows as Array<{ _id: string }>).map((row) => row._id)).toEqual([id]);
		},
	}),
	defineCase({
		name: 'assistant.conversations.listMessages',
		floor: 'requireOrgMember',
		seed: newConversation,
		call: (t, conversationId: Id<'aiConversations'>) =>
			t.query(api.assistant.conversations.listMessages, { conversationId }),
	}),
	defineCase({
		name: 'assistant.conversations.renameConversation',
		floor: 'getMutationContext',
		seed: newConversation,
		call: (t, conversationId: Id<'aiConversations'>) =>
			t.mutation(api.assistant.conversations.renameConversation, {
				conversationId,
				title: 'Renamed',
			}),
	}),
	defineCase({
		name: 'assistant.conversations.deleteConversation',
		floor: 'getMutationContext',
		seed: newConversation,
		call: (t, conversationId: Id<'aiConversations'>) =>
			t.mutation(api.assistant.conversations.deleteConversation, { conversationId }),
	}),
	defineCase({
		name: 'assistant.conversations.stopGeneration',
		floor: 'getMutationContext',
		seed: async (t) => {
			const conversationId = await newConversation(t);
			return await t.run((ctx) =>
				ctx.db.insert('aiMessages', {
					conversationId,
					ownerId: 'admin-user',
					role: 'assistant',
					text: '',
					status: 'streaming',
					createdAt: 1,
				})
			);
		},
		call: (t, messageId: Id<'aiMessages'>) =>
			t.mutation(api.assistant.conversations.stopGeneration, { messageId }),
		check: async (t, messageId) => {
			const message = await t.run((ctx) => ctx.db.get(messageId as Id<'aiMessages'>));
			expect(message?.status).toBe('stopped');
		},
	}),
	defineCase({
		name: 'auth.accountManagement.exportContactsForOrganization',
		floor: 'requireOrgMember',
		denied: 'Only owners and admins can export contacts',
		call: (t) => t.query(api.auth.accountManagement.exportContactsForOrganization, {}),
	}),
	defineCase({
		name: 'auth.apiKeys.listByTeam',
		floor: 'requireOrgMember',
		denied: 'Only owners and admins can view API keys',
		call: (t) => t.query(api.auth.apiKeys.listByTeam, {}),
	}),
	defineCase({
		name: 'auth.apiKeys.create',
		floor: 'getMutationContext',
		denied: 'Only owners and admins can create API keys',
		call: (t) => t.mutation(api.auth.apiKeys.create, { name: 'CI key', scopes: ['contacts:read'] }),
	}),
	defineCase({
		name: 'auth.apiKeys.updateName',
		floor: 'getMutationContext',
		denied: 'Only owners and admins can manage API keys',
		seed: insertApiKey,
		call: (t, keyId: Id<'apiKeys'>) =>
			t.mutation(api.auth.apiKeys.updateName, { keyId, name: 'Renamed' }),
	}),
	defineCase({
		name: 'auth.apiKeys.revoke',
		floor: 'getMutationContext',
		denied: 'Only owners and admins can revoke API keys',
		seed: insertApiKey,
		call: (t, keyId: Id<'apiKeys'>) => t.mutation(api.auth.apiKeys.revoke, { keyId }),
	}),
	defineCase({
		name: 'auth.apiKeys.remove',
		floor: 'getMutationContext',
		denied: 'Only owners and admins can delete API keys',
		seed: insertApiKey,
		call: (t, keyId: Id<'apiKeys'>) => t.mutation(api.auth.apiKeys.remove, { keyId }),
	}),
	defineCase({
		name: 'auth.invitationResend.throttleResend',
		floor: 'requireAdminContext',
		denied: ADMIN,
		call: (t) => t.mutation(api.auth.invitationResend.throttleResend, { invitationId: 'inv-1' }),
	}),
	defineCase({
		name: 'connectedApps.queries.listByTeam',
		floor: 'requireOrgMember',
		denied: 'Only owners and admins can view connected apps',
		seed: async (t) => {
			await insertConnectedApp(t);
			await insertConnectedApp(t, 'enabled', 'org-2');
		},
		call: (t) => t.query(api.connectedApps.queries.listByTeam, {}),
		check: async (_t, _seeded, rows) => {
			// Tenant-scoped by the floor's org: the other tenant's app stays out.
			expect(rows).toHaveLength(1);
		},
	}),
	defineCase({
		name: 'connectedApps.mutations.remove',
		floor: 'getMutationContext',
		denied: CONNECTED_APPS,
		seed: insertConnectedApp,
		call: (t, connectedAppId: Id<'connectedApps'>) =>
			t.mutation(api.connectedApps.mutations.remove, { connectedAppId }),
		check: async (t) => {
			expect(await lifecycleAudit(t, 'connected_app.deleted')).toEqual([
				{ userId: 'admin-user', organizationId: 'org-1' },
			]);
		},
	}),
	...lifecycleCases,
	defineCase({
		name: 'devShortcuts.forceVerifyDomain.forceVerifyDomain',
		floor: 'getMutationContext',
		denied: 'Only owners and admins can force-verify domains',
		seed: (t) =>
			t.run((ctx) => ctx.db.insert('domains', createTestDomain({ status: 'pending' }) as never)),
		call: (t, domainId: Id<'domains'>) =>
			t.mutation(api.devShortcuts.forceVerifyDomain.forceVerifyDomain, { domainId }),
		check: async (t) => {
			const rows = await t.run((ctx) => ctx.db.query('auditLogs').collect());
			expect(
				rows.filter((row) => row.action === 'sending_domain.verified').map((row) => row.userId)
			).toEqual(['admin-user']);
		},
	}),
	defineCase({
		name: 'search/global.search',
		floor: 'requireOrgMember',
		seed: async (t) => {
			const mine = await seedMailbox(t, { userId: 'admin-user', address: 'a@owlat.test' });
			const theirs = await seedMailbox(t, { userId: 'someone-else', address: 'b@owlat.test' });
			await seedFolder(t, mine);
			await seedFolder(t, theirs);
			const own = await seedMessage(t, mine, { subject: 'zzthreaded mine', snippet: 'zzthreaded' });
			await seedMessage(t, theirs, { subject: 'zzthreaded theirs', snippet: 'zzthreaded' });
			return own;
		},
		call: (t) => t.query(api.search.global.search, { query: 'zzthreaded' }),
		check: async (_t, own, result) => {
			// Mail is scoped to the floor session's user, never another user's box.
			const { mail } = result as { mail: Array<{ id: string }> };
			expect(mail.map((row) => row.id)).toEqual([own]);
		},
	}),
	defineCase({
		name: 'workspaces.featureFlags.setFeatureFlag',
		floor: 'requireAdminContext',
		denied: ADMIN,
		call: (t) =>
			t.mutation(api.workspaces.featureFlags.setFeatureFlag, { flag: 'webhooks', value: true }),
	}),
	defineCase({
		name: 'workspaces.featureFlags.setFeaturePack',
		floor: 'requireAdminContext',
		denied: ADMIN,
		call: (t) =>
			t.mutation(api.workspaces.featureFlags.setFeaturePack, { pack: 'marketing', value: true }),
	}),
	defineCase({
		name: 'workspaces.featureFlags.setAllFeatureFlags',
		floor: 'requireAdminContext',
		denied: ADMIN,
		call: (t) =>
			t.mutation(api.workspaces.featureFlags.setAllFeatureFlags, { flags: { webhooks: true } }),
	}),
	defineCase({
		name: 'workspaces.settings.get',
		floor: 'requireOrgMember',
		call: (t) => t.query(api.workspaces.settings.get, {}),
	}),
	defineCase({
		name: 'workspaces.settings.update',
		floor: 'getMutationContext',
		denied: 'Only owners and admins can update organization settings',
		call: (t) => t.mutation(api.workspaces.settings.update, { timezone: 'Europe/Berlin' }),
	}),
	defineCase({
		name: 'workspaces.settings.remove',
		floor: 'getMutationContext',
		denied: 'Only the owner can delete the organization',
		call: (t) => t.mutation(api.workspaces.settings.remove, {}),
	}),
];

async function harness(): Promise<T> {
	const t = newHarness();
	await enableFeatures(t, ['ai.assistant']);
	return t;
}

beforeEach(() => {
	// Scheduled follow-ups (deletion sweeps, backfills) are not under test; fake
	// timers keep convex-test from running them.
	vi.useFakeTimers();
	vi.stubEnv('OWLAT_DEV_MODE', 'true');
	setSession('admin-user', 'owner');
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

describe('auth and misc handlers use the session their floor resolved', () => {
	it.each(cases.map((c) => [c.name, c] as const))(
		'%s resolves the session once, on its floor',
		async (_name, c) => {
			const t = await harness();
			const seeded = await c.seed?.(t);
			clearResolverCalls(sessionOrganization);

			const result = await c.call(t, seeded);

			expectOnlyFloor(sessionOrganization, c.floor);
			await c.check?.(t, seeded, result);
		}
	);

	const privileged = cases.filter((c) => c.denied !== undefined);
	it.each(privileged.map((c) => [c.name, c] as const))(
		'%s refuses an editor with its existing message',
		async (_name, c) => {
			const t = await harness();
			const seeded = await c.seed?.(t);
			setSession('editor-user', 'editor');

			await expect(c.call(t, seeded)).rejects.toThrow(c.denied);
		}
	);

	it('workspaces.settings.remove refuses an admin: deletion stays owner-only', async () => {
		const t = await harness();
		setSession('admin-user', 'admin');
		await expect(t.mutation(api.workspaces.settings.remove, {})).rejects.toThrow(
			'Only the owner can delete the organization'
		);
	});

	it('a connected-app lifecycle edge acts only in the floor session tenant', async () => {
		const t = await harness();
		const foreign = await insertConnectedApp(t, 'enabled', 'org-2');

		await expect(
			t.mutation(api.connectedApps.mutations.disable, { connectedAppId: foreign })
		).rejects.toThrow();
		const row = await t.run((ctx) => ctx.db.get(foreign));
		expect(row?.status).toBe('enabled');
	});

	it('assistant reads and writes stay with the conversation owner', async () => {
		const t = await harness();
		const conversationId = await newConversation(t);
		setSession('other-user', 'owner');

		expect(await t.query(api.assistant.conversations.listConversations, {})).toEqual([]);
		await expect(
			t.mutation(api.assistant.conversations.renameConversation, { conversationId, title: 'x' })
		).rejects.toThrow();
		const convo = await t.run((ctx) => ctx.db.get(conversationId));
		expect(convo?.title).toBe('New conversation');
	});
});
