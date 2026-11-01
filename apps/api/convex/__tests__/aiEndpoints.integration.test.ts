/**
 * The AI provider config, visualization, global search and Quick Query gate
 * endpoints (`aiRouting/providerConfig{,Actions}`, `analytics/visualizationAgent`,
 * `search/global`, `assistant/quickQueryGate`): what each reads and writes,
 * what it schedules, and the auth floor and feature flag each keeps. The
 * LLM-backed actions are covered in `aiEndpointActions.integration.test.ts`.
 */

import { convexTest } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { encryptSecret } from '../lib/credentialCrypto';
import { createTestCampaign, createTestContact, enableFeatures } from './factories';
import { seedFolder, seedMailbox, seedMessage } from '../mail/__tests__/helpers.testlib';

vi.stubEnv('INSTANCE_SECRET', 'test-instance-secret-value-for-aes-256-gcm-kdf');

const session = vi.hoisted(() => ({ role: 'owner' as 'owner' | 'admin' | 'editor' }));
const adapter = vi.hoisted(() => ({ validateCredentials: vi.fn() }));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	const member = () => ({
		userId: 'user-1',
		role: session.role,
		activeOrganizationId: 'org-1',
	});
	const denied = () => new Error("You don't have permission to perform this action");
	const admin = async () => {
		if (session.role === 'editor') throw denied();
		return member();
	};
	return {
		...actual,
		requireOrgMember: vi.fn(async () => member()),
		getMutationContext: vi.fn(async () => member()),
		isActiveOrgMember: vi.fn(async () => true),
		getUserIdFromSession: vi.fn(async () => 'user-1'),
		// The adminMutation floor.
		requireAdminContext: vi.fn(admin),
		// The adminQuery floor and `organization:manage`; `knowledge:read` is only
		// asked with an owner here.
		requireOrgPermission: vi.fn(admin),
	};
});

// The provider registry, so a save and a connection test need no real vendor.
vi.mock('../lib/llmProviders', async () => ({
	...(await vi.importActual<object>('../lib/llmProviders')),
	languageProviderFor: (kind: string) => ({
		kind,
		isLocal: false,
		defaultModels: { fast: 'fast-default', capable: 'capable-default' },
		validateCredentials: adapter.validateCredentials,
	}),
	embeddingProviderFor: (kind: string) => ({
		kind,
		dimensions: 1536,
		isLocal: kind === 'local',
		defaultModel: kind === 'local' ? 'nomic-embed-text' : 'text-embedding-3-small',
		validateCredentials: adapter.validateCredentials,
	}),
}));

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('agentSecurity') &&
			!path.includes('agentContext') &&
			!path.includes('agentClassifier') &&
			!path.includes('agentDrafter') &&
			!path.includes('agentRouter') &&
			!path.includes('agent/walker') &&
			!path.includes('agent/steps/index') &&
			!path.includes('agent/steps/shared') &&
			!path.includes('agent/steps/classify') &&
			!path.includes('agent/steps/draft') &&
			!path.includes('knowledgeExtraction') &&
			!path.includes('files/processing') &&
			!path.includes('llmProvider')
	)
);

const identity = {
	subject: 'user-1',
	issuer: 'https://test.issuer.com',
	tokenIdentifier: 'https://test.issuer.com|user-1',
};

type T = ReturnType<typeof convexTest>;

function setup() {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	return { t, user: t.withIdentity(identity) };
}

const denied = "You don't have permission to perform this action";

/** The names of the functions scheduled so far, in order. */
async function scheduledNames(t: T): Promise<string[]> {
	return await t.run(async (ctx) =>
		(await ctx.db.system.query('_scheduled_functions').collect()).map((job) => job.name)
	);
}

async function insertVisualization(t: T, dataQuery?: string): Promise<Id<'visualizations'>> {
	return await t.run((ctx) =>
		ctx.db.insert('visualizations', {
			title: 'Delivery',
			description: 'chart our delivery',
			html: '<p>old</p>',
			dataQuery,
			pinned: false,
			createdBy: 'user-1',
			createdAt: 1_000,
			updatedAt: 1_000,
		})
	);
}

beforeEach(() => {
	session.role = 'owner';
	adapter.validateCredentials.mockReset();
});

describe('visualization endpoints', () => {
	it('list, pinned and the live datasets read what is stored', async () => {
		const { t, user } = setup();
		await enableFeatures(t, ['ai.visualizations']);
		const first = await insertVisualization(t, 'email_delivery_30d');
		await insertVisualization(t);
		await t.run(async (ctx) => {
			await ctx.db.patch(first, { pinned: true });
			await ctx.db.insert('contacts', createTestContact({ createdAt: Date.now() }));
			await ctx.db.insert(
				'campaigns',
				createTestCampaign({ status: 'sent', sentAt: 2_000, statsSent: 40, statsOpened: 9 })
			);
		});

		const list = await user.query(api.analytics.visualizationAgent.list, { limit: 5 });
		expect(list).toHaveLength(2);
		const pinned = await user.query(api.analytics.visualizationAgent.listPinned, {});
		expect(pinned.map((viz) => viz._id)).toEqual([first]);

		const campaigns = await t.query(
			internal.analytics.visualizationAgent.dataCampaignPerformance,
			{}
		);
		expect(campaigns).toMatchObject([{ sent: 40, opened: 9 }]);
		expect(
			await t.query(internal.analytics.visualizationAgent.dataEmailDelivery30d, {})
		).toBeDefined();
		expect(await t.query(internal.analytics.visualizationAgent.dataAgentHealth, {})).toBeDefined();
		// No cached contact count: the read refuses, so generation falls back to
		// illustrative data.
		await expect(
			t.query(internal.analytics.visualizationAgent.dataContactGrowth, {})
		).rejects.toThrow(/not initialized/);
	});

	it('writes edit the row and schedule the generation', async () => {
		const { t, user } = setup();
		await enableFeatures(t, ['ai.visualizations']);

		const created = await user.mutation(api.analytics.visualizationAgent.createFromPrompt, {
			prompt: 'Sends per day',
			pinned: true,
			dataset: 'email_delivery_30d',
		});
		expect(await t.run((ctx) => ctx.db.get(created))).toMatchObject({
			title: 'Sends per day',
			pinned: true,
			createdBy: 'user-1',
		});

		const live = await insertVisualization(t, 'contact_growth');
		await user.mutation(api.analytics.visualizationAgent.regenerate, { id: live });
		expect((await t.run((ctx) => ctx.db.get(live)))?.html).toContain('Refreshing');
		const illustrative = await insertVisualization(t);
		await expect(
			user.mutation(api.analytics.visualizationAgent.regenerate, { id: illustrative })
		).rejects.toThrow(/illustrative sample data/);
		// Both writes queue the generation action.
		expect(await scheduledNames(t)).toEqual([
			'analytics/visualizationAgentActions:generate',
			'analytics/visualizationAgentActions:generate',
		]);

		await user.mutation(api.analytics.visualizationAgent.togglePin, { id: created });
		expect((await t.run((ctx) => ctx.db.get(created)))?.pinned).toBe(false);

		await t.mutation(internal.analytics.visualizationAgent.updateGenerated, {
			id: live,
			title: 'Growth',
			html: '<p>new</p>',
			dataQuery: 'contact_growth',
		});
		expect(await t.run((ctx) => ctx.db.get(live))).toMatchObject({
			title: 'Growth',
			html: '<p>new</p>',
			dataQuery: 'contact_growth',
		});

		await user.mutation(api.analytics.visualizationAgent.remove, { id: created });
		expect(await t.run((ctx) => ctx.db.get(created))).toBeNull();
		// A late commit for a deleted visualization is dropped.
		await t.mutation(internal.analytics.visualizationAgent.updateGenerated, {
			id: created,
			title: 'Late',
			html: '<p>late</p>',
		});
		expect(await t.run((ctx) => ctx.db.get(created))).toBeNull();
	});

	it('keep the owner/admin floor and the feature flag on every public endpoint', async () => {
		const { t, user } = setup();
		const id = await insertVisualization(t, 'email_delivery_30d');

		// Feature off: list throws, the dashboard card reads empty.
		await expect(user.query(api.analytics.visualizationAgent.list, {})).rejects.toThrow(
			/ai\.visualizations/
		);
		expect(await user.query(api.analytics.visualizationAgent.listPinned, {})).toEqual([]);

		await enableFeatures(t, ['ai.visualizations']);
		session.role = 'editor';
		await expect(user.query(api.analytics.visualizationAgent.list, {})).rejects.toThrow(denied);
		await expect(user.query(api.analytics.visualizationAgent.listPinned, {})).rejects.toThrow(
			denied
		);
		await expect(
			user.mutation(api.analytics.visualizationAgent.createFromPrompt, { prompt: 'x' })
		).rejects.toThrow(denied);
		await expect(
			user.mutation(api.analytics.visualizationAgent.regenerate, { id })
		).rejects.toThrow(denied);
		await expect(user.mutation(api.analytics.visualizationAgent.togglePin, { id })).rejects.toThrow(
			denied
		);
		await expect(user.mutation(api.analytics.visualizationAgent.remove, { id })).rejects.toThrow(
			denied
		);
		expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({
			pinned: false,
			html: '<p>old</p>',
		});
		expect(await scheduledNames(t)).toEqual([]);
	});
});

describe('global search endpoints', () => {
	it('search contacts and mail, mail scoped to the caller', async () => {
		const { t, user } = setup();
		const token = 'zzglobalsearchtoken';
		await t.run((ctx) =>
			ctx.db.insert(
				'contacts',
				createTestContact({ searchableText: `${token} ada`, email: 'ada@example.com' })
			)
		);
		const mine = await seedMailbox(t, { userId: 'user-1', address: 'a@owlat.test' });
		const theirs = await seedMailbox(t, { userId: 'user-2', address: 'b@owlat.test' });
		await seedFolder(t, mine);
		await seedFolder(t, theirs);
		const visible = await seedMessage(t, mine, { subject: token, snippet: token });
		await seedMessage(t, theirs, { subject: token, snippet: token });

		const result = await user.query(api.search.global.search, { query: token });
		expect(result.contacts).toHaveLength(1);
		expect(result.mail.map((row) => row.id)).toEqual([visible]);

		const internalResult = await t.query(internal.search.global.searchInternal, { query: token });
		expect(internalResult.contacts).toHaveLength(1);
		expect(internalResult.mail).toEqual([]);
	});
});

describe('AI provider config endpoints', () => {
	const persistArgs = {
		languageProviderKind: 'openai' as const,
		modelFast: 'gpt-fast',
		modelCapable: 'gpt-capable',
		isLanguageLocal: false,
		languageEnvelope: { ...encryptSecret('sk-persisted'), keyPreview: 'sk-…sted' },
		// Ignored: derived from the kind, but still accepted.
		isEmbeddingLocal: true,
	};

	it('persist, read and remove the config, logging each write', async () => {
		const { t, user } = setup();
		expect(await user.query(api.aiRouting.providerConfig.getConfig, {})).toMatchObject({
			configured: false,
		});

		const configId = await user.mutation(
			internal.aiRouting.providerConfig._persistConfig,
			persistArgs
		);
		expect(await user.query(api.aiRouting.providerConfig.getConfig, {})).toMatchObject({
			configured: true,
			modelFast: 'gpt-fast',
		});

		const row = await t.query(internal.aiRouting.providerConfig._getConfigRow, {});
		expect(row?._id).toBe(configId);

		expect(await user.mutation(api.aiRouting.providerConfig.removeConfig, {})).toEqual({
			removed: true,
		});
		expect(await user.mutation(api.aiRouting.providerConfig.removeConfig, {})).toEqual({
			removed: false,
		});
		expect(await t.query(internal.aiRouting.providerConfig._getConfigRow, {})).toBeNull();

		const audit = await t.run((ctx) => ctx.db.query('auditLogs').collect());
		expect(audit.map((entry) => [entry.action, entry.userId])).toEqual([
			['ai_provider_config.updated', 'user-1'],
			['ai_provider_config.removed', 'user-1'],
		]);
	});

	it('saves, tests and lists models', async () => {
		const { t, user } = setup();
		const configId = await user.action(api.aiRouting.providerConfigActions.saveConfig, {
			languageProviderKind: 'openai',
			apiKey: 'sk-openai-test-key',
		});
		expect(await user.query(api.aiRouting.providerConfig.getConfig, {})).toMatchObject({
			configured: true,
			modelFast: 'fast-default',
			isLanguageKeySet: true,
			keyPreview: 'sk-…-key',
		});
		expect((await t.query(internal.aiRouting.providerConfig._getConfigRow, {}))?._id).toBe(
			configId
		);

		expect(await user.action(api.aiRouting.providerConfigActions.testConnection, {})).toEqual({
			ok: true,
		});
		// The stored key was decrypted and handed to the adapter.
		expect(adapter.validateCredentials).toHaveBeenLastCalledWith({
			apiKey: 'sk-openai-test-key',
			baseUrl: undefined,
		});
		// This registry has no model discovery, so the picker stays free-text.
		expect(await user.action(api.aiRouting.providerConfigActions.listModels, {})).toEqual({
			supported: false,
			models: [],
		});
	});

	it('decrypts a stored key envelope', async () => {
		const { t } = setup();
		const envelope = encryptSecret('sk-envelope');
		expect(
			await t.action(internal.aiRouting.providerConfigActions._decryptSecretEnvelope, envelope)
		).toBe('sk-envelope');
	});

	it('keep the owner/admin floor on the write and admin endpoints', async () => {
		const { t, user } = setup();
		await user.mutation(internal.aiRouting.providerConfig._persistConfig, persistArgs);
		session.role = 'editor';
		await expect(user.mutation(api.aiRouting.providerConfig.removeConfig, {})).rejects.toThrow(
			denied
		);
		await expect(
			user.mutation(internal.aiRouting.providerConfig._persistConfig, persistArgs)
		).rejects.toThrow(denied);
		await expect(
			user.action(api.aiRouting.providerConfigActions.saveConfig, {
				languageProviderKind: 'openai',
			})
		).rejects.toThrow(denied);
		await expect(
			user.action(api.aiRouting.providerConfigActions.testConnection, {})
		).rejects.toThrow(denied);
		await expect(user.action(api.aiRouting.providerConfigActions.listModels, {})).rejects.toThrow(
			denied
		);
		expect(
			(await t.query(internal.aiRouting.providerConfig._getConfigRow, {}))?.configRevision
		).toBe(1);
	});
});

describe('Quick Query gate', () => {
	it('refuses with ai.knowledge off and reports inbox access with it on', async () => {
		const { t, user } = setup();
		await expect(
			user.query(internal.assistant.quickQueryGate.assertKnowledgeReadAccess, {})
		).rejects.toThrow(/ai\.knowledge.*disabled/);
		await enableFeatures(t, ['ai.knowledge']);
		const access = await user.query(
			internal.assistant.quickQueryGate.assertKnowledgeReadAccess,
			{}
		);
		expect(typeof access.canReadInbox).toBe('boolean');
	});
});
