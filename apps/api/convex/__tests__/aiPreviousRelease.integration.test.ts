/**
 * The previous release's AI provider config, visualization, global search and
 * Quick Query gate paths (`aiProviderConfig:*`, `aiProviderConfigActions:*`,
 * `visualizationAgent:*`, `visualizationAgentActions:generate`,
 * `globalSearch:*`, `quickQuery:ask`, `quickQueryGate:*`, `translate:*`) keep
 * working against this release: each old path takes the same arguments,
 * returns what its moved function returns, writes what it writes, and keeps
 * its auth floor. The LLM-backed action paths are covered in
 * `aiPreviousReleaseActions.integration.test.ts`.
 */

import { convexTest } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { encryptSecret } from '../lib/credentialCrypto';
import * as oldProviderConfig from '../aiProviderConfig';
import * as oldProviderConfigActions from '../aiProviderConfigActions';
import * as oldTranslate from '../translate';
import * as oldQuickQuery from '../quickQuery';
import * as oldQuickQueryGate from '../quickQueryGate';
import * as oldVisualization from '../visualizationAgent';
import * as oldVisualizationActions from '../visualizationAgentActions';
import * as oldGlobalSearch from '../globalSearch';
import * as providerConfig from '../aiRouting/providerConfig';
import * as providerConfigActions from '../aiRouting/providerConfigActions';
import * as translate from '../emailTemplates/translate';
import * as quickQuery from '../assistant/quickQuery';
import * as quickQueryGate from '../assistant/quickQueryGate';
import * as visualization from '../analytics/visualizationAgent';
import * as visualizationActions from '../analytics/visualizationAgentActions';
import * as globalSearch from '../search/global';
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
			!path.includes('semanticFileProcessing') &&
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

describe('previous-release AI paths: shapes', () => {
	it('take the same arguments and declare the same result as the moved functions', () => {
		const shape = (fn: unknown) => {
			const registered = fn as { exportArgs(): string; exportReturns(): string };
			return { args: registered.exportArgs(), returns: registered.exportReturns() };
		};
		const pairs: [unknown, unknown][] = [
			[oldProviderConfig.getConfig, providerConfig.getConfig],
			[oldProviderConfig._persistConfig, providerConfig._persistConfig],
			[oldProviderConfig._getConfigRow, providerConfig._getConfigRow],
			[oldProviderConfig.removeConfig, providerConfig.removeConfig],
			[oldProviderConfigActions.saveConfig, providerConfigActions.saveConfig],
			[oldProviderConfigActions.testConnection, providerConfigActions.testConnection],
			[oldProviderConfigActions.listModels, providerConfigActions.listModels],
			[
				oldProviderConfigActions._decryptSecretEnvelope,
				providerConfigActions._decryptSecretEnvelope,
			],
			[oldTranslate.translateBatch, translate.translateBatch],
			[oldQuickQuery.ask, quickQuery.ask],
			[oldQuickQueryGate.assertKnowledgeReadAccess, quickQueryGate.assertKnowledgeReadAccess],
			[oldVisualization.list, visualization.list],
			[oldVisualization.listPinned, visualization.listPinned],
			[oldVisualization.createFromPrompt, visualization.createFromPrompt],
			[oldVisualization.regenerate, visualization.regenerate],
			[oldVisualization.togglePin, visualization.togglePin],
			[oldVisualization.remove, visualization.remove],
			[oldVisualization.updateGenerated, visualization.updateGenerated],
			[oldVisualization.dataEmailDelivery30d, visualization.dataEmailDelivery30d],
			[oldVisualization.dataAgentHealth, visualization.dataAgentHealth],
			[oldVisualization.dataContactGrowth, visualization.dataContactGrowth],
			[oldVisualization.dataCampaignPerformance, visualization.dataCampaignPerformance],
			[oldVisualizationActions.generate, visualizationActions.generate],
			[oldGlobalSearch.search, globalSearch.search],
			[oldGlobalSearch.searchInternal, globalSearch.searchInternal],
		];
		expect(pairs).toHaveLength(25);
		for (const [old, moved] of pairs) expect(shape(old)).toEqual(shape(moved));
		// The persist validator keeps every field the previous release's save sends.
		expect(
			Object.keys(JSON.parse(shape(oldProviderConfig._persistConfig).args).value)
		).toHaveLength(18);
	});
});

describe('previous-release visualization paths', () => {
	it('reads through visualizationAgent:* match analytics/visualizationAgent', async () => {
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

		const list = await user.query(api.visualizationAgent.list, { limit: 5 });
		expect(list).toEqual(await user.query(api.analytics.visualizationAgent.list, { limit: 5 }));
		expect(list).toHaveLength(2);
		const pinned = await user.query(api.visualizationAgent.listPinned, {});
		expect(pinned).toEqual(await user.query(api.analytics.visualizationAgent.listPinned, {}));
		expect(pinned.map((viz) => viz._id)).toEqual([first]);

		const campaigns = await t.query(internal.visualizationAgent.dataCampaignPerformance, {});
		expect(campaigns).toEqual(
			await t.query(internal.analytics.visualizationAgent.dataCampaignPerformance, {})
		);
		expect(campaigns).toMatchObject([{ sent: 40, opened: 9 }]);
		expect(await t.query(internal.visualizationAgent.dataEmailDelivery30d, {})).toEqual(
			await t.query(internal.analytics.visualizationAgent.dataEmailDelivery30d, {})
		);
		expect(await t.query(internal.visualizationAgent.dataAgentHealth, {})).toEqual(
			await t.query(internal.analytics.visualizationAgent.dataAgentHealth, {})
		);
		// No cached contact count: both paths refuse, so generation falls back to
		// illustrative data either way.
		await expect(t.query(internal.visualizationAgent.dataContactGrowth, {})).rejects.toThrow(
			/not initialized/
		);
		await expect(
			t.query(internal.analytics.visualizationAgent.dataContactGrowth, {})
		).rejects.toThrow(/not initialized/);
	});

	it('writes through visualizationAgent:* and schedule the moved generation', async () => {
		const { t, user } = setup();
		await enableFeatures(t, ['ai.visualizations']);

		const created = await user.mutation(api.visualizationAgent.createFromPrompt, {
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
		await user.mutation(api.visualizationAgent.regenerate, { id: live });
		expect((await t.run((ctx) => ctx.db.get(live)))?.html).toContain('Refreshing');
		const illustrative = await insertVisualization(t);
		await expect(
			user.mutation(api.visualizationAgent.regenerate, { id: illustrative })
		).rejects.toThrow(/illustrative sample data/);
		// Both old writes queue this release's generation, not the old path.
		expect(await scheduledNames(t)).toEqual([
			'analytics/visualizationAgentActions:generate',
			'analytics/visualizationAgentActions:generate',
		]);

		await user.mutation(api.visualizationAgent.togglePin, { id: created });
		expect((await t.run((ctx) => ctx.db.get(created)))?.pinned).toBe(false);

		await t.mutation(internal.visualizationAgent.updateGenerated, {
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

		await user.mutation(api.visualizationAgent.remove, { id: created });
		expect(await t.run((ctx) => ctx.db.get(created))).toBeNull();
		// A late commit for a deleted visualization is dropped, as on the new path.
		await t.mutation(internal.visualizationAgent.updateGenerated, {
			id: created,
			title: 'Late',
			html: '<p>late</p>',
		});
		expect(await t.run((ctx) => ctx.db.get(created))).toBeNull();
	});

	it('keep the owner/admin floor and the feature flag on every old public path', async () => {
		const { t, user } = setup();
		const id = await insertVisualization(t, 'email_delivery_30d');

		// Feature off: list throws, the dashboard card reads empty.
		await expect(user.query(api.visualizationAgent.list, {})).rejects.toThrow(/ai\.visualizations/);
		expect(await user.query(api.visualizationAgent.listPinned, {})).toEqual([]);

		await enableFeatures(t, ['ai.visualizations']);
		session.role = 'editor';
		await expect(user.query(api.visualizationAgent.list, {})).rejects.toThrow(denied);
		await expect(user.query(api.visualizationAgent.listPinned, {})).rejects.toThrow(denied);
		await expect(
			user.mutation(api.visualizationAgent.createFromPrompt, { prompt: 'x' })
		).rejects.toThrow(denied);
		await expect(user.mutation(api.visualizationAgent.regenerate, { id })).rejects.toThrow(denied);
		await expect(user.mutation(api.visualizationAgent.togglePin, { id })).rejects.toThrow(denied);
		await expect(user.mutation(api.visualizationAgent.remove, { id })).rejects.toThrow(denied);
		expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({
			pinned: false,
			html: '<p>old</p>',
		});
		expect(await scheduledNames(t)).toEqual([]);
	});
});

describe('previous-release global search paths', () => {
	it('globalSearch:* return what search/global returns, mail scoped to the caller', async () => {
		const { t, user } = setup();
		const token = 'zzpreviousrelease';
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

		const result = await user.query(api.globalSearch.search, { query: token });
		expect(result).toEqual(await user.query(api.search.global.search, { query: token }));
		expect(result.contacts).toHaveLength(1);
		expect(result.mail.map((row) => row.id)).toEqual([visible]);

		const internalResult = await t.query(internal.globalSearch.searchInternal, { query: token });
		expect(internalResult).toEqual(
			await t.query(internal.search.global.searchInternal, { query: token })
		);
		expect(internalResult.contacts).toHaveLength(1);
		expect(internalResult.mail).toEqual([]);
	});
});

describe('previous-release AI provider config paths', () => {
	const persistArgs = {
		languageProviderKind: 'openai' as const,
		modelFast: 'gpt-fast',
		modelCapable: 'gpt-capable',
		isLanguageLocal: false,
		languageEnvelope: { ...encryptSecret('sk-persisted'), keyPreview: 'sk-…sted' },
		// The previous release's save still sends this ignored flag.
		isEmbeddingLocal: true,
	};

	it('reads and writes through aiProviderConfig:* match aiRouting/providerConfig', async () => {
		const { t, user } = setup();
		expect(await user.query(api.aiProviderConfig.getConfig, {})).toEqual(
			await user.query(api.aiRouting.providerConfig.getConfig, {})
		);

		const configId = await user.mutation(internal.aiProviderConfig._persistConfig, persistArgs);
		const config = await user.query(api.aiProviderConfig.getConfig, {});
		expect(config).toEqual(await user.query(api.aiRouting.providerConfig.getConfig, {}));
		expect(config).toMatchObject({ configured: true, modelFast: 'gpt-fast' });

		const row = await t.query(internal.aiProviderConfig._getConfigRow, {});
		expect(row).toEqual(await t.query(internal.aiRouting.providerConfig._getConfigRow, {}));
		expect(row?._id).toBe(configId);

		expect(await user.mutation(api.aiProviderConfig.removeConfig, {})).toEqual({ removed: true });
		expect(await user.mutation(api.aiProviderConfig.removeConfig, {})).toEqual({ removed: false });
		expect(await t.query(internal.aiRouting.providerConfig._getConfigRow, {})).toBeNull();

		const audit = await t.run((ctx) => ctx.db.query('auditLogs').collect());
		expect(audit.map((entry) => [entry.action, entry.userId])).toEqual([
			['ai_provider_config.updated', 'user-1'],
			['ai_provider_config.removed', 'user-1'],
		]);
	});

	it('saves, tests and lists models through aiProviderConfigActions:*', async () => {
		const { t, user } = setup();
		const configId = await user.action(api.aiProviderConfigActions.saveConfig, {
			languageProviderKind: 'openai',
			apiKey: 'sk-previous-release-key',
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

		expect(await user.action(api.aiProviderConfigActions.testConnection, {})).toEqual({ ok: true });
		// The stored key was decrypted and handed to the adapter.
		expect(adapter.validateCredentials).toHaveBeenLastCalledWith({
			apiKey: 'sk-previous-release-key',
			baseUrl: undefined,
		});
		// This registry has no model discovery, so the picker stays free-text.
		expect(await user.action(api.aiProviderConfigActions.listModels, {})).toEqual({
			supported: false,
			models: [],
		});
	});

	it('decrypts a stored key envelope through the old internal path', async () => {
		const { t } = setup();
		const envelope = encryptSecret('sk-envelope');
		expect(await t.action(internal.aiProviderConfigActions._decryptSecretEnvelope, envelope)).toBe(
			'sk-envelope'
		);
		expect(
			await t.action(internal.aiRouting.providerConfigActions._decryptSecretEnvelope, envelope)
		).toBe('sk-envelope');
	});

	it('keep the owner/admin floor on the old write and admin paths', async () => {
		const { t, user } = setup();
		await user.mutation(internal.aiRouting.providerConfig._persistConfig, persistArgs);
		session.role = 'editor';
		await expect(user.mutation(api.aiProviderConfig.removeConfig, {})).rejects.toThrow(denied);
		await expect(
			user.mutation(internal.aiProviderConfig._persistConfig, persistArgs)
		).rejects.toThrow(denied);
		await expect(
			user.action(api.aiProviderConfigActions.saveConfig, { languageProviderKind: 'openai' })
		).rejects.toThrow(denied);
		await expect(user.action(api.aiProviderConfigActions.testConnection, {})).rejects.toThrow(
			denied
		);
		await expect(user.action(api.aiProviderConfigActions.listModels, {})).rejects.toThrow(denied);
		expect(
			(await t.query(internal.aiRouting.providerConfig._getConfigRow, {}))?.configRevision
		).toBe(1);
	});
});

describe('previous-release Quick Query gate path', () => {
	it('quickQueryGate:assertKnowledgeReadAccess answers as assistant/quickQueryGate does', async () => {
		const { t, user } = setup();
		await expect(user.query(internal.quickQueryGate.assertKnowledgeReadAccess, {})).rejects.toThrow(
			/ai\.knowledge.*disabled/
		);
		await enableFeatures(t, ['ai.knowledge']);
		const access = await user.query(internal.quickQueryGate.assertKnowledgeReadAccess, {});
		expect(access).toEqual(
			await user.query(internal.assistant.quickQueryGate.assertKnowledgeReadAccess, {})
		);
		expect(typeof access.canReadInbox).toBe('boolean');
	});
});
