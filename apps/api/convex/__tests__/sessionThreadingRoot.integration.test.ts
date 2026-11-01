/**
 * Convex-root handlers take the caller from the session their builder floor
 * resolved (the handler's third argument) instead of resolving it again.
 *
 * Each case runs once as an owner, asserting by call count that the floor was
 * the only session resolution and, where the handler records who acted, that
 * the actor is the floor's user. Privileged cases also run as an editor and
 * must be refused with the message the handler used before.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TestConvex } from 'convex-test';
import type schema from '../schema';
import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import * as sessionOrganization from '../lib/sessionOrganization';
import {
	createTestAutonomyRule,
	createTestBlockedEmail,
	createTestCodeWorkTask,
	createTestEmailTemplate,
	createTestSegment,
	enableFeatures,
} from './factories';
import { newHarness } from './testModules';
import { recordUploadedBlob } from './uploadFixtures.testlib';
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
const AUTONOMY = 'Only owners and admins can change autonomy rules';
const BLOCKLIST = 'Only owners and admins can manage the blocklist';
const ROUTING = 'Only owners and admins can change provider routing';
const DEFAULT_DENIAL = "You don't have permission to perform this action";

async function auditActors(t: T, action: string): Promise<string[]> {
	const rows = await t.run((ctx) => ctx.db.query('auditLogs').collect());
	return rows.filter((row) => row.action === action).map((row) => row.userId);
}

async function storedBlob(t: T): Promise<Id<'_storage'>> {
	const storageId = await t.run((ctx) => ctx.storage.store(new Blob(['body'])));
	await t.run((ctx) => recordUploadedBlob(ctx, storageId, 'admin-user'));
	return storageId;
}

async function semanticFile(t: T): Promise<Id<'semanticFiles'>> {
	const storageId = await storedBlob(t);
	return await t.mutation(api.semanticFiles.create, { storageId, ...blob, sourceType: 'upload' });
}

const insert =
	<Table extends 'autonomyRules' | 'blockedEmails' | 'codeWorkTasks' | 'segments'>(
		table: Table,
		doc: Record<string, unknown>
	) =>
	(t: T) =>
		t.run((ctx) => ctx.db.insert(table, doc as never));

const blob = { filename: 'notes.txt', mimeType: 'text/plain', fileSize: 4 };

const cases: Case<unknown>[] = [
	defineCase({
		name: 'agentConfigMutations.updateConfig',
		floor: 'requireAdminContext',
		denied: ADMIN,
		call: (t) => t.mutation(api.agentConfigMutations.updateConfig, { toneDescription: 'calm' }),
		check: async (t) => {
			expect(await auditActors(t, 'agent.config_updated')).toEqual(['admin-user']);
		},
	}),
	defineCase({
		name: 'autonomy.upsertRule',
		floor: 'getMutationContext',
		denied: AUTONOMY,
		call: (t) =>
			t.mutation(api.autonomy.upsertRule, {
				category: 'support',
				autoApproveThreshold: 0.9,
				maxDailyAutoActions: 10,
				isEnabled: true,
			}),
	}),
	defineCase({
		name: 'autonomy.setSenderAutonomy',
		floor: 'getMutationContext',
		denied: AUTONOMY,
		call: (t) =>
			t.mutation(api.autonomy.setSenderAutonomy, {
				category: 'support',
				sender: 'vip@example.com',
				isEnabled: true,
			}),
	}),
	defineCase({
		name: 'autonomy.deleteRule',
		floor: 'getMutationContext',
		denied: 'Only owners and admins can delete autonomy rules',
		seed: insert('autonomyRules', createTestAutonomyRule()),
		call: (t, ruleId: Id<'autonomyRules'>) => t.mutation(api.autonomy.deleteRule, { ruleId }),
	}),
	defineCase({
		name: 'autonomyOutcome.acknowledgeAutoDemotion',
		floor: 'getMutationContext',
		denied: 'Only owners and admins can manage autonomy',
		seed: insert('autonomyRules', createTestAutonomyRule({ autoDemotedAt: 1 })),
		call: (t, ruleId: Id<'autonomyRules'>) =>
			t.mutation(api.autonomyOutcome.acknowledgeAutoDemotion, { ruleId }),
		check: async (t) => {
			expect(await auditActors(t, 'agent.demotion_acknowledged')).toEqual(['admin-user']);
		},
	}),
	defineCase({
		name: 'autonomySuggestions.acceptGraduationSuggestion',
		floor: 'getMutationContext',
		denied: 'Only owners and admins can widen autonomy',
		seed: async (t) => {
			await insert('autonomyRules', createTestAutonomyRule({ autoApproveThreshold: 0.8 }))(t);
			return await t.run((ctx) =>
				ctx.db.insert('autonomySuggestions', {
					category: 'support',
					currentThreshold: 0.8,
					suggestedThreshold: 0.75,
					evidence: { approved: 20, sampleSize: 20, rejectionRate: 0 },
					createdAt: 1,
				})
			);
		},
		call: (t, suggestionId: Id<'autonomySuggestions'>) =>
			t.mutation(api.autonomySuggestions.acceptGraduationSuggestion, { suggestionId }),
	}),
	defineCase({
		name: 'blockedEmails.blocklist.add',
		floor: 'getMutationContext',
		denied: BLOCKLIST,
		call: (t) =>
			t.mutation(api.blockedEmails.blocklist.add, {
				email: 'blocked@example.com',
				reason: 'manual',
			}),
		check: async (t) => {
			expect(await auditActors(t, 'blocklist.added')).toEqual(['admin-user']);
		},
	}),
	defineCase({
		name: 'blockedEmails.blocklist.bulkAdd',
		floor: 'getMutationContext',
		denied: BLOCKLIST,
		call: (t) =>
			t.mutation(api.blockedEmails.blocklist.bulkAdd, {
				emails: [{ email: 'bulk@example.com', reason: 'manual' }],
			}),
	}),
	defineCase({
		name: 'blockedEmails.blocklist.remove',
		floor: 'getMutationContext',
		denied: BLOCKLIST,
		seed: insert('blockedEmails', createTestBlockedEmail({ reason: 'manual' })),
		call: (t, blockedEmailId: Id<'blockedEmails'>) =>
			t.mutation(api.blockedEmails.blocklist.remove, { blockedEmailId }),
	}),
	defineCase({
		name: 'blockedEmails.blocklist.listProviderProvenance',
		floor: 'requireOrgMember',
		denied: DEFAULT_DENIAL,
		call: (t) => t.query(api.blockedEmails.blocklist.listProviderProvenance, {}),
	}),
	defineCase({
		name: 'codeWorkTasks.cancel',
		floor: 'getMutationContext',
		denied: 'Only owners and admins can manage code tasks',
		seed: insert('codeWorkTasks', createTestCodeWorkTask()),
		call: (t, taskId: Id<'codeWorkTasks'>) => t.mutation(api.codeWorkTasks.cancel, { taskId }),
	}),
	defineCase({
		name: 'workspaces.mediaAssets.create',
		floor: 'getMutationContext',
		denied: 'Only owners and admins can create media assets',
		seed: storedBlob,
		call: (t, storageId: Id<'_storage'>) =>
			t.mutation(api.workspaces.mediaAssets.create, { storageId, ...blob }),
		check: async (t, _seeded, assetId) => {
			const asset = await t.run((ctx) => ctx.db.get(assetId as Id<'mediaAssets'>));
			expect(asset?.uploadedBy).toBe('admin-user');
		},
	}),
	defineCase({
		name: 'workspaces.mediaAssets.update',
		floor: 'getMutationContext',
		denied: 'Only owners and admins can update media assets',
		seed: async (t) =>
			t.mutation(api.workspaces.mediaAssets.create, { storageId: await storedBlob(t), ...blob }),
		call: (t, assetId: Id<'mediaAssets'>) =>
			t.mutation(api.workspaces.mediaAssets.update, { assetId, alt: 'A note' }),
	}),
	defineCase({
		name: 'workspaces.mediaAssets.bulkDelete',
		floor: 'getMutationContext',
		denied: 'Only owners and admins can bulk-delete media assets',
		seed: async (t) =>
			t.mutation(api.workspaces.mediaAssets.create, { storageId: await storedBlob(t), ...blob }),
		call: (t, assetId: Id<'mediaAssets'>) =>
			t.mutation(api.workspaces.mediaAssets.bulkDelete, { assetIds: [assetId] }),
	}),
	defineCase({
		name: 'storage.files.getUrl',
		floor: 'requireOrgMember',
		seed: async (t) => {
			const storageId = await storedBlob(t);
			await t.mutation(api.workspaces.mediaAssets.create, { storageId, ...blob });
			return storageId;
		},
		call: (t, storageId: Id<'_storage'>) => t.query(api.storage.files.getUrl, { storageId }),
		check: async (_t, _seeded, url) => {
			expect(typeof url).toBe('string');
		},
	}),
	defineCase({
		name: 'providerRoutes.listRelayDomainIdentities',
		floor: 'requireOrgMember',
		denied: DEFAULT_DENIAL,
		call: (t) =>
			t.query(api.providerRoutes.listRelayDomainIdentities, {
				paginationOpts: { cursor: null, numItems: 10 },
			}),
	}),
	defineCase({
		name: 'providerRoutes.setRoute',
		floor: 'getMutationContext',
		denied: ROUTING,
		call: (t) =>
			t.mutation(api.providerRoutes.setRoute, {
				messageType: 'campaign',
				strategy: 'single',
				providers: [{ providerType: 'mta', isEnabled: true }],
			}),
	}),
	defineCase({
		name: 'providerRoutes.removeRoute',
		floor: 'getMutationContext',
		denied: ROUTING,
		call: (t) => t.mutation(api.providerRoutes.removeRoute, { messageType: 'campaign' }),
	}),
	defineCase({
		name: 'segments.segments.create',
		floor: 'getMutationContext',
		denied: 'Only owners and admins can create segments',
		call: (t) =>
			t.mutation(api.segments.segments.create, {
				name: 'Readers',
				filters: createTestSegment().filters,
			}),
		check: async (t) => {
			expect(await auditActors(t, 'segment.created')).toEqual(['admin-user']);
		},
	}),
	defineCase({
		name: 'segments.segments.update',
		floor: 'getMutationContext',
		denied: 'Only owners and admins can update segments',
		seed: insert('segments', createTestSegment()),
		call: (t, id: Id<'segments'>) =>
			t.mutation(api.segments.segments.update, { id, name: 'Renamed' }),
	}),
	defineCase({
		name: 'segments.segments.remove',
		floor: 'getMutationContext',
		denied: 'Only owners and admins can delete segments',
		seed: insert('segments', createTestSegment()),
		call: (t, id: Id<'segments'>) => t.mutation(api.segments.segments.remove, { id }),
	}),
	defineCase({
		name: 'semanticFiles.create',
		floor: 'getMutationContext',
		denied: ADMIN,
		seed: storedBlob,
		call: (t, storageId: Id<'_storage'>) =>
			t.mutation(api.semanticFiles.create, { storageId, ...blob, sourceType: 'upload' }),
		check: async (t, _seeded, fileId) => {
			const file = await t.run((ctx) => ctx.db.get(fileId as Id<'semanticFiles'>));
			expect(file?.uploadedBy).toBe('admin-user');
		},
	}),
	defineCase({
		name: 'semanticFiles.update',
		floor: 'getMutationContext',
		denied: ADMIN,
		seed: semanticFile,
		call: (t, fileId: Id<'semanticFiles'>) =>
			t.mutation(api.semanticFiles.update, { fileId, title: 'Renamed' }),
	}),
	defineCase({
		name: 'semanticFiles.remove',
		floor: 'requireAdminContext',
		denied: ADMIN,
		seed: semanticFile,
		call: (t, fileId: Id<'semanticFiles'>) => t.mutation(api.semanticFiles.remove, { fileId }),
	}),
	defineCase({
		name: 'shareLinks.createShareLink',
		floor: 'getMutationContext',
		denied: 'Only owners and admins can create share links',
		seed: (t) => t.run((ctx) => ctx.db.insert('emailTemplates', createTestEmailTemplate())),
		call: (t, emailTemplateId: Id<'emailTemplates'>) =>
			t.mutation(api.shareLinks.createShareLink, { emailTemplateId }),
		check: async (t, _seeded, result) => {
			const { shareLinkId } = result as { shareLinkId: Id<'shareLinks'> };
			const link = await t.run((ctx) => ctx.db.get(shareLinkId));
			expect(link?.createdBy).toBe('admin-user');
		},
	}),
	defineCase({
		name: 'shareLinks.revokeShareLink',
		floor: 'getMutationContext',
		denied: 'Only owners and admins can revoke share links',
		seed: async (t) => {
			const emailTemplateId = await t.run((ctx) =>
				ctx.db.insert('emailTemplates', createTestEmailTemplate())
			);
			const { shareLinkId } = await t.mutation(api.shareLinks.createShareLink, {
				emailTemplateId,
			});
			return shareLinkId;
		},
		call: (t, shareLinkId: Id<'shareLinks'>) =>
			t.mutation(api.shareLinks.revokeShareLink, { shareLinkId }),
	}),
	defineCase({
		name: 'unifiedMessages.updateChannelConfig',
		floor: 'getMutationContext',
		denied: 'Only owners and admins can configure channels',
		call: (t) =>
			t.mutation(api.unifiedMessages.updateChannelConfig, { channel: 'sms', isEnabled: true }),
	}),
	defineCase({
		name: 'visualizationAgent.createFromPrompt',
		floor: 'requireAdminContext',
		denied: ADMIN,
		call: (t) => t.mutation(api.visualizationAgent.createFromPrompt, { prompt: 'Sends per day' }),
		check: async (t, _seeded, id) => {
			const viz = await t.run((ctx) => ctx.db.get(id as Id<'visualizations'>));
			expect(viz?.createdBy).toBe('admin-user');
		},
	}),
	...(['regenerate', 'togglePin', 'remove'] as const).map((name) =>
		defineCase({
			name: `visualizationAgent.${name}`,
			floor: 'requireAdminContext',
			denied: ADMIN,
			seed: (t) =>
				t.run((ctx) =>
					ctx.db.insert('visualizations', {
						title: 'Sends',
						html: '<div></div>',
						dataQuery: 'email_delivery_30d',
						pinned: false,
						createdBy: 'admin-user',
						createdAt: 1,
						updatedAt: 1,
					})
				),
			call: (t, id: Id<'visualizations'>) => t.mutation(api.visualizationAgent[name], { id }),
		})
	),
];

async function harness(): Promise<T> {
	const t = newHarness();
	await enableFeatures(t, ['ai.autonomy', 'ai.visualizations']);
	return t;
}

beforeEach(() => {
	// Scheduled follow-ups (visualization generation, cascades) are not under
	// test; fake timers keep convex-test from running them.
	vi.useFakeTimers();
	setSession('admin-user', 'owner');
});

afterEach(() => {
	vi.useRealTimers();
});

describe('convex-root handlers use the session their floor resolved', () => {
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
});
