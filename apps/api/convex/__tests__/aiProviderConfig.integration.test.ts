/**
 * Pluggable AI providers — config storage + save/get/test surface.
 *
 * Covers the security-sensitive contract of this piece:
 *   • saveConfig round-trips: the config is readable back WITHOUT the secret
 *     (only a masked keyPreview + booleans); the encrypted envelope never
 *     appears in a query result.
 *   • admin gating: a non-admin write is rejected.
 *   • an audit-log row is written on save.
 *   • local providers save with NO key.
 *   • testConnection ok / err paths (adapter mocked; real crypto round-trip).
 *
 * The adapter registry (`lib/llmProviders`) is mocked so no `@ai-sdk/*` client
 * is built and `validateCredentials` is controllable. Key crypto is REAL
 * (`INSTANCE_SECRET` stubbed) so the encrypt→persist→decrypt round-trip is
 * exercised end-to-end. `lib/sessionOrganization` is mocked to drive the
 * auth/admin floors from a per-test session.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import schema from '../schema';
import { api } from '../_generated/api';

vi.stubEnv('INSTANCE_SECRET', 'test-instance-secret-value-for-aes-256-gcm-kdf');

const sessionMocks = vi.hoisted(() => ({
	session: null as { userId: string; role: 'owner' | 'admin' | 'editor' } | null,
}));

const adapterMocks = vi.hoisted(() => ({
	validateCredentials: vi.fn(),
}));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockImplementation(async () => {
			if (!sessionMocks.session) throw new Error('Not authenticated');
			return { userId: sessionMocks.session.userId, role: sessionMocks.session.role };
		}),
		requireOrgPermission: vi.fn().mockImplementation(async () => {
			const s = sessionMocks.session;
			if (!s) throw new Error('Not authenticated');
			if (s.role !== 'owner' && s.role !== 'admin') throw new Error('forbidden');
			return { userId: s.userId, role: s.role };
		}),
	};
});

vi.mock('../lib/llmProviders', () => ({
	languageProviderFor: (kind: string) => ({
		kind,
		isLocal: kind === 'openaiCompatible',
		defaultBaseUrl: kind === 'openaiCompatible' ? 'http://localhost:11434/v1' : undefined,
		defaultModels: { fast: 'fast-default', capable: 'capable-default' },
		validateCredentials: adapterMocks.validateCredentials,
	}),
	embeddingProviderFor: (kind: string) => ({
		kind,
		dimensions: 1536,
		// Local + custom-compatible embedders are keyless; openai/google are hosted.
		isLocal: kind === 'local' || kind === 'openaiCompatible',
		defaultModel: kind === 'local' ? 'nomic-embed-text' : 'text-embedding-3-small',
		validateCredentials: adapterMocks.validateCredentials,
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
			!path.includes('visualizationAgent') &&
			!path.includes('llmProvider')
	)
);

const identity = {
	subject: 'test-admin',
	issuer: 'https://test.issuer.com',
	tokenIdentifier: 'https://test.issuer.com|test-admin',
};

function setup() {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	return t.withIdentity(identity);
}

beforeEach(() => {
	sessionMocks.session = { userId: 'test-admin', role: 'owner' };
	adapterMocks.validateCredentials.mockReset();
});

describe('aiProviderConfig.saveConfig + getConfig', () => {
	it('returns { configured: false } when no config exists', async () => {
		const t = setup();
		const result = await t.query(api.aiProviderConfig.getConfig, {});
		expect(result.configured).toBe(false);
	});

	it('round-trips a hosted config readable back WITHOUT the secret', async () => {
		const t = setup();
		await t.action(api.aiProviderConfigActions.saveConfig, {
			languageProviderKind: 'anthropic',
			modelFast: 'claude-haiku-4-5',
			modelCapable: 'claude-opus-4-8',
			apiKey: 'sk-ant-secret-key-1234',
		});

		const result = await t.query(api.aiProviderConfig.getConfig, {});
		expect(result.configured).toBe(true);
		if (!result.configured) throw new Error('unreachable');
		expect(result.languageProviderKind).toBe('anthropic');
		expect(result.modelFast).toBe('claude-haiku-4-5');
		expect(result.modelCapable).toBe('claude-opus-4-8');
		expect(result.isLanguageKeySet).toBe(true);
		// Masked preview only — never the raw key or ciphertext.
		expect(result.keyPreview).toBe('sk-…1234');
		expect(result).not.toHaveProperty('secretCiphertext');
		expect(result).not.toHaveProperty('secretIv');
		expect(result).not.toHaveProperty('secretAuthTag');
		// Embedding plane is local by default.
		expect(result.embeddingProviderKind).toBe('local');
		expect(result.embeddingModelVersion).toBe(1);
		expect(result.isEmbeddingKeySet).toBe(false);
	});

	it('persists the encrypted envelope but the query never returns ciphertext', async () => {
		const t = setup();
		await t.action(api.aiProviderConfigActions.saveConfig, {
			languageProviderKind: 'openai',
			apiKey: 'sk-openai-abcd-key',
		});

		// The stored row DOES hold ciphertext…
		const row = await t.run((ctx) => ctx.db.query('aiProviderConfig').first());
		expect(row?.secretCiphertext).toBeTruthy();
		expect(row?.secretIv).toBeTruthy();
		expect(row?.secretAuthTag).toBeTruthy();
		// …but it is not the plaintext, and defaults fill the model tiers.
		expect(row?.secretCiphertext).not.toContain('sk-openai');
		expect(row?.modelFast).toBe('fast-default');

		// …and the public query exposes none of it.
		const result = await t.query(api.aiProviderConfig.getConfig, {});
		if (!result.configured) throw new Error('unreachable');
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain(row?.secretCiphertext ?? '__nope__');
		expect(serialized).not.toContain('sk-openai-abcd-key');
	});

	it('saves a local provider with NO key', async () => {
		const t = setup();
		await t.action(api.aiProviderConfigActions.saveConfig, {
			languageProviderKind: 'openaiCompatible',
			languageBaseUrl: 'http://localhost:11434/v1',
		});

		const result = await t.query(api.aiProviderConfig.getConfig, {});
		if (!result.configured) throw new Error('unreachable');
		expect(result.languageProviderKind).toBe('openaiCompatible');
		expect(result.isLanguageKeySet).toBe(false);
		expect(result.keyPreview).toBeUndefined();
		expect(result.languageBaseUrl).toBe('http://localhost:11434/v1');
	});

	it('rejects a hosted provider saved with no key at all', async () => {
		const t = setup();
		await expect(
			t.action(api.aiProviderConfigActions.saveConfig, {
				languageProviderKind: 'anthropic',
			})
		).rejects.toThrow(/API key/i);
	});

	it('rejects a non-admin write', async () => {
		const t = setup();
		sessionMocks.session = { userId: 'editor-user', role: 'editor' };
		await expect(
			t.action(api.aiProviderConfigActions.saveConfig, {
				languageProviderKind: 'anthropic',
				apiKey: 'sk-ant-secret-key-1234',
			})
		).rejects.toThrow(/forbidden/i);

		// Nothing was persisted.
		const row = await t.run((ctx) => ctx.db.query('aiProviderConfig').first());
		expect(row).toBeNull();
	});

	it('writes an audit-log row on save', async () => {
		const t = setup();
		await t.action(api.aiProviderConfigActions.saveConfig, {
			languageProviderKind: 'anthropic',
			apiKey: 'sk-ant-secret-key-1234',
		});

		const logs = await t.run((ctx) =>
			ctx.db
				.query('auditLogs')
				.withIndex('by_action', (q) => q.eq('action', 'ai_provider_config.updated'))
				.collect()
		);
		expect(logs.length).toBe(1);
		expect(logs[0]!.resource).toBe('ai_provider_config');
		expect(logs[0]!.userId).toBe('test-admin');
		// The audit detail carries no secret.
		expect(logs[0]!.detailsBlob ?? '').not.toContain('sk-ant-secret-key-1234');
	});

	it('bumps embeddingModelVersion when the embedding model changes', async () => {
		const t = setup();
		await t.action(api.aiProviderConfigActions.saveConfig, {
			languageProviderKind: 'anthropic',
			apiKey: 'sk-ant-secret-key-1234',
			embeddingModel: 'model-a',
		});
		await t.action(api.aiProviderConfigActions.saveConfig, {
			languageProviderKind: 'anthropic',
			// key omitted — the stored key is preserved
			embeddingModel: 'model-b',
		});

		const result = await t.query(api.aiProviderConfig.getConfig, {});
		if (!result.configured) throw new Error('unreachable');
		expect(result.embeddingModel).toBe('model-b');
		expect(result.embeddingModelVersion).toBe(2);
		// The key survived a keyless re-save.
		expect(result.isLanguageKeySet).toBe(true);
	});

	it('bumps embeddingModelVersion when the embedding provider kind changes (re-index flag)', async () => {
		const t = setup();
		await t.action(api.aiProviderConfigActions.saveConfig, {
			languageProviderKind: 'anthropic',
			apiKey: 'sk-ant-secret-key-1234',
			// default embedding kind: local
		});
		await t.action(api.aiProviderConfigActions.saveConfig, {
			languageProviderKind: 'anthropic',
			embeddingProviderKind: 'openai',
			embeddingModel: 'text-embedding-3-small',
			embeddingApiKey: 'sk-embed-secret-key-9999',
		});

		const result = await t.query(api.aiProviderConfig.getConfig, {});
		if (!result.configured) throw new Error('unreachable');
		expect(result.embeddingProviderKind).toBe('openai');
		// Switching planes bumps the guard so a re-index can be prompted.
		expect(result.embeddingModelVersion).toBe(2);
	});

	it('round-trips a HOSTED embedder key without ever returning ciphertext', async () => {
		const t = setup();
		await t.action(api.aiProviderConfigActions.saveConfig, {
			languageProviderKind: 'anthropic',
			apiKey: 'sk-ant-secret-key-1234',
			embeddingProviderKind: 'openai',
			embeddingModel: 'text-embedding-3-small',
			embeddingApiKey: 'sk-embed-secret-key-9999',
		});

		// The stored row holds the embedding envelope…
		const row = await t.run((ctx) => ctx.db.query('aiProviderConfig').first());
		expect(row?.embeddingSecretCiphertext).toBeTruthy();
		expect(row?.embeddingSecretCiphertext).not.toContain('sk-embed');

		// …but the public query exposes only a masked preview + boolean.
		const result = await t.query(api.aiProviderConfig.getConfig, {});
		if (!result.configured) throw new Error('unreachable');
		expect(result.isEmbeddingKeySet).toBe(true);
		expect(result.embeddingKeyPreview).toBe('sk-…9999');
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain('sk-embed-secret-key-9999');
		expect(serialized).not.toContain(row?.embeddingSecretCiphertext ?? '__nope__');
	});
});

describe('aiProviderConfig.testConnection', () => {
	it('returns { ok: false } when nothing is configured', async () => {
		const t = setup();
		const res = await t.action(api.aiProviderConfigActions.testConnection, {});
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/configured/i);
	});

	it('returns ok when the hosted adapter validates the decrypted key', async () => {
		const t = setup();
		await t.action(api.aiProviderConfigActions.saveConfig, {
			languageProviderKind: 'anthropic',
			apiKey: 'sk-ant-secret-key-1234',
		});
		adapterMocks.validateCredentials.mockReset(); // ignore the save-time validation
		adapterMocks.validateCredentials.mockImplementation(() => undefined);

		const res = await t.action(api.aiProviderConfigActions.testConnection, {});
		expect(res.ok).toBe(true);
		// The adapter received the DECRYPTED key (crypto round-trip), never a blank.
		expect(adapterMocks.validateCredentials).toHaveBeenLastCalledWith(
			expect.objectContaining({ apiKey: 'sk-ant-secret-key-1234' })
		);
	});

	it('returns { ok: false, error } when the hosted adapter rejects the key', async () => {
		const t = setup();
		await t.action(api.aiProviderConfigActions.saveConfig, {
			languageProviderKind: 'anthropic',
			apiKey: 'sk-ant-secret-key-1234',
		});
		adapterMocks.validateCredentials.mockReset();
		adapterMocks.validateCredentials.mockImplementation(() => {
			throw new Error('Anthropic rejected the key.');
		});

		const res = await t.action(api.aiProviderConfigActions.testConnection, {});
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/rejected the key/i);
	});

	it('probes the base URL for a local provider (reachable ⇒ ok)', async () => {
		const t = setup();
		await t.action(api.aiProviderConfigActions.saveConfig, {
			languageProviderKind: 'openaiCompatible',
			languageBaseUrl: 'http://localhost:11434/v1',
		});
		const fetchMock = vi.fn().mockResolvedValue({ ok: true });
		vi.stubGlobal('fetch', fetchMock);
		try {
			const res = await t.action(api.aiProviderConfigActions.testConnection, {});
			expect(res.ok).toBe(true);
			expect(fetchMock).toHaveBeenCalledWith(
				'http://localhost:11434/v1',
				expect.objectContaining({ method: 'GET' })
			);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
