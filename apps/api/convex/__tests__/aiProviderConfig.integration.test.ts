/**
 * Pluggable AI providers — config storage + save/get/test surface.
 *
 * Covers the security-sensitive contract of this piece:
 *   • saveConfig round-trips: the config is readable back WITHOUT the secret
 *     (only a masked keyPreview + booleans); the encrypted envelope never
 *     appears in a query result.
 *   • admin gating: a non-admin write is rejected.
 *   • an audit-log row is written on save.
 *   • removeConfig: admin-only, deletes the row and its keys, audits without a
 *     secret, and is a no-op when nothing is stored.
 *   • local providers save with NO key.
 *   • a stored key is reused only for the same provider kind and base URL.
 *   • a new embedding key is bound to the embedding kind the save names.
 *   • a vector embedded in a space that is no longer current is not committed.
 *   • embedding space (D8): an omitted embedding selection keeps the stored one,
 *     and neither a save nor a removal may move the resolved space while the
 *     knowledge or file corpus holds vectors.
 *   • testConnection ok / err paths (adapter mocked; real crypto round-trip).
 *
 * The adapter registry (`lib/llmProviders`) is mocked so no `@ai-sdk/*` client
 * is built and `validateCredentials` is controllable. Key crypto is REAL
 * (`INSTANCE_SECRET` stubbed) so the encrypt→persist→decrypt round-trip is
 * exercised end-to-end. `lib/sessionOrganization` is mocked to drive the
 * auth/admin floors from a per-test session.
 */

import { convexTest } from 'convex-test';
import { ConvexError, type Value } from 'convex/values';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import { hasStoredAiProviderConfig } from '../lib/aiNotConfigured';
import {
	EMBEDDING_SPACE_LOCKED,
	VECTOR_PROBE_ROWS,
	embeddingSpaceKey,
	resolvedEmbeddingSpace,
} from '../lib/embeddingSpace';
import { STORED_KEY_NOT_REUSABLE } from '../lib/aiProviderSecrets';

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
		// The `adminMutation` floor (removeConfig) resolves through this one.
		requireAdminContext: vi.fn().mockImplementation(async () => {
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
		defaultModel:
			kind === 'local'
				? 'nomic-embed-text'
				: kind === 'google'
					? 'gemini-embedding-2'
					: 'text-embedding-3-small',
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

	it('rejects a hosted provider whose base URL is http (SSRF/key-exfil gate)', async () => {
		const t = setup();
		await expect(
			t.action(api.aiProviderConfigActions.saveConfig, {
				languageProviderKind: 'openai',
				languageBaseUrl: 'http://api.internal.example/v1',
				apiKey: 'sk-openai-secret-1234',
			})
		).rejects.toThrow(/https/i);
		const row = await t.run((ctx) => ctx.db.query('aiProviderConfig').first());
		expect(row).toBeNull();
	});

	it('rejects a hosted provider whose base URL is a private/internal address', async () => {
		const t = setup();
		await expect(
			t.action(api.aiProviderConfigActions.saveConfig, {
				languageProviderKind: 'openai',
				languageBaseUrl: 'https://169.254.169.254/v1',
				apiKey: 'sk-openai-secret-1234',
			})
		).rejects.toThrow(/private or internal/i);
		const row = await t.run((ctx) => ctx.db.query('aiProviderConfig').first());
		expect(row).toBeNull();
	});

	it('accepts a hosted provider with a public https base URL', async () => {
		const t = setup();
		await t.action(api.aiProviderConfigActions.saveConfig, {
			languageProviderKind: 'openai',
			languageBaseUrl: 'https://proxy.example.com/v1',
			apiKey: 'sk-openai-secret-1234',
		});
		const result = await t.query(api.aiProviderConfig.getConfig, {});
		if (!result.configured) throw new Error('unreachable');
		expect(result.languageBaseUrl).toBe('https://proxy.example.com/v1');
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

	it('materializes the Google default when saving without an explicit embedding ID', async () => {
		const t = setup();
		await t.action(api.aiProviderConfigActions.saveConfig, {
			languageProviderKind: 'anthropic',
			apiKey: 'sk-ant-secret-key-1234',
			embeddingProviderKind: 'google',
			embeddingApiKey: 'google-test-embedding-key',
		});
		const result = await t.query(api.aiProviderConfig.getConfig, {});
		if (!result.configured) throw new Error('unreachable');
		expect(result.embeddingModel).toBe('gemini-embedding-2');
		expect(result.embeddingModelVersion).toBe(1);
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

describe('aiProviderConfig.removeConfig', () => {
	/** Both planes hosted, so the row holds two encrypted keys. */
	async function saveHostedConfig(t: ReturnType<typeof setup>) {
		await t.action(api.aiProviderConfigActions.saveConfig, {
			languageProviderKind: 'anthropic',
			apiKey: 'sk-ant-secret-key-1234',
			embeddingProviderKind: 'openai',
			embeddingModel: 'text-embedding-3-small',
			embeddingApiKey: 'sk-embed-secret-key-9999',
		});
	}

	const removalLogs = (t: ReturnType<typeof setup>) =>
		t.run((ctx) =>
			ctx.db
				.query('auditLogs')
				.withIndex('by_action', (q) => q.eq('action', 'ai_provider_config.removed'))
				.collect()
		);

	it('refuses a non-admin and keeps the row', async () => {
		const t = setup();
		await saveHostedConfig(t);
		sessionMocks.session = { userId: 'editor-user', role: 'editor' };

		await expect(t.mutation(api.aiProviderConfig.removeConfig, {})).rejects.toThrow(/forbidden/i);

		const row = await t.run((ctx) => ctx.db.query('aiProviderConfig').first());
		expect(row?.secretCiphertext).toBeTruthy();
		expect(await removalLogs(t)).toHaveLength(0);
	});

	it('deletes the row and its keys and audits the removal without a secret', async () => {
		const t = setup();
		await saveHostedConfig(t);
		const row = await t.run((ctx) => ctx.db.query('aiProviderConfig').first());
		if (!row) throw new Error('unreachable');

		const result = await t.mutation(api.aiProviderConfig.removeConfig, {});
		expect(result).toEqual({ removed: true });

		expect(await t.query(api.aiProviderConfig.getConfig, {})).toEqual({ configured: false });
		expect(await t.run((ctx) => hasStoredAiProviderConfig(ctx.db))).toBe(false);

		const logs = await removalLogs(t);
		expect(logs).toHaveLength(1);
		expect(logs[0]!.resource).toBe('ai_provider_config');
		expect(logs[0]!.resourceId).toBe(row._id);
		expect(logs[0]!.userId).toBe('test-admin');
		expect(JSON.parse(logs[0]!.detailsBlob ?? '{}')).toEqual({
			languageProviderKind: 'anthropic',
			embeddingProviderKind: 'openai',
			isLanguageKeySet: true,
			isEmbeddingKeySet: true,
			isDecisionKeySet: false,
		});
		// No key, preview or ciphertext reaches the audit trail.
		for (const secret of [
			'sk-ant-secret-key-1234',
			'sk-embed-secret-key-9999',
			row.keyPreview!,
			row.embeddingKeyPreview!,
			row.secretCiphertext!,
			row.embeddingSecretCiphertext!,
		]) {
			expect(logs[0]!.detailsBlob ?? '').not.toContain(secret);
		}
	});

	it('does nothing, without error, when no config is stored', async () => {
		const t = setup();

		expect(await t.mutation(api.aiProviderConfig.removeConfig, {})).toEqual({ removed: false });
		// A second removal after a real one is the same no-op.
		await saveHostedConfig(t);
		await t.mutation(api.aiProviderConfig.removeConfig, {});
		expect(await t.mutation(api.aiProviderConfig.removeConfig, {})).toEqual({ removed: false });

		expect(await removalLogs(t)).toHaveLength(1);
	});
});

describe('stored key reuse', () => {
	type T = ReturnType<typeof setup>;
	const storedRow = (t: T) => t.run((ctx) => ctx.db.query('aiProviderConfig').first());

	async function expectNewKeyRequired(promise: Promise<unknown>, plane: string) {
		const error = await promise.then(
			() => undefined,
			(e: unknown) => e
		);
		expect(error).toBeInstanceOf(ConvexError);
		const data = (
			error as ConvexError<{ category: string; message: string; data: Record<string, Value> }>
		).data;
		expect(data.category).toBe('invalid_input');
		expect(data.message).toMatch(new RegExp(`${plane} provider or its base URL changed`));
		expect(data.data).toEqual({ reason: STORED_KEY_NOT_REUSABLE, plane });
	}

	describe('language plane', () => {
		const proxied = {
			languageProviderKind: 'openai' as const,
			languageBaseUrl: 'https://proxy.example.com/v1',
		};

		it('keeps the stored key for the same provider and an equivalent base URL', async () => {
			const t = setup();
			await t.action(api.aiProviderConfigActions.saveConfig, { ...proxied, apiKey: 'sk-openai-1' });
			const before = await storedRow(t);
			await t.action(api.aiProviderConfigActions.saveConfig, {
				...proxied,
				languageBaseUrl: 'https://PROXY.example.com:443/v1/',
				modelFast: 'gpt-6-luna',
			});
			expect((await storedRow(t))?.secretCiphertext).toBe(before?.secretCiphertext);
		});

		it('requires a new key when the provider kind changes', async () => {
			const t = setup();
			await t.action(api.aiProviderConfigActions.saveConfig, { ...proxied, apiKey: 'sk-openai-1' });
			const before = await storedRow(t);
			await expectNewKeyRequired(
				t.action(api.aiProviderConfigActions.saveConfig, { languageProviderKind: 'anthropic' }),
				'language'
			);
			expect(await storedRow(t)).toEqual(before);
			// With the new provider's key, the save goes through.
			await t.action(api.aiProviderConfigActions.saveConfig, {
				languageProviderKind: 'anthropic',
				apiKey: 'sk-ant-secret-key-1234',
			});
			expect((await storedRow(t))?.keyPreview).toBe('sk-…1234');
		});

		it('requires a new key when the base URL changes or is removed', async () => {
			const t = setup();
			await t.action(api.aiProviderConfigActions.saveConfig, { ...proxied, apiKey: 'sk-openai-1' });
			await expectNewKeyRequired(
				t.action(api.aiProviderConfigActions.saveConfig, {
					...proxied,
					languageBaseUrl: 'https://other.example.com/v1',
				}),
				'language'
			);
			await expectNewKeyRequired(
				t.action(api.aiProviderConfigActions.saveConfig, { languageProviderKind: 'openai' }),
				'language'
			);
		});
	});

	describe('embedding plane (no stored base URL: the kind is the target)', () => {
		const hostedOpenAi = {
			languageProviderKind: 'anthropic' as const,
			apiKey: 'sk-ant-secret-key-1234',
			embeddingProviderKind: 'openai' as const,
			embeddingModel: 'text-embedding-3-small',
		};

		it('keeps the stored key while the embedder kind is unchanged', async () => {
			const t = setup();
			await t.action(api.aiProviderConfigActions.saveConfig, {
				...hostedOpenAi,
				embeddingApiKey: 'sk-embed-secret-key-9999',
			});
			const before = await storedRow(t);
			await t.action(api.aiProviderConfigActions.saveConfig, hostedOpenAi);
			expect((await storedRow(t))?.embeddingSecretCiphertext).toBe(
				before?.embeddingSecretCiphertext
			);
		});

		it('requires a new key when the embedder kind changes', async () => {
			const t = setup();
			await t.action(api.aiProviderConfigActions.saveConfig, {
				...hostedOpenAi,
				embeddingApiKey: 'sk-embed-secret-key-9999',
			});
			await expectNewKeyRequired(
				t.action(api.aiProviderConfigActions.saveConfig, {
					...hostedOpenAi,
					embeddingProviderKind: 'google',
					embeddingModel: undefined,
				}),
				'embedding'
			);
		});
	});

	describe('decision plane', () => {
		const typesafe = {
			languageProviderKind: 'anthropic' as const,
			apiKey: 'sk-ant-secret-key-1234',
			decisionProviderKind: 'typesafe' as const,
			decisionBaseUrl: 'https://decide.example.com',
		};

		it('keeps the stored key for the same provider and base URL', async () => {
			const t = setup();
			await t.action(api.aiProviderConfigActions.saveConfig, {
				...typesafe,
				decisionApiKey: 'ts-decision-key-5678',
			});
			const before = await storedRow(t);
			await t.action(api.aiProviderConfigActions.saveConfig, {
				...typesafe,
				decisionBaseUrl: 'https://decide.example.com/',
			});
			expect((await storedRow(t))?.decisionSecretCiphertext).toBe(before?.decisionSecretCiphertext);
		});

		it('requires a new key when the base URL changes', async () => {
			const t = setup();
			await t.action(api.aiProviderConfigActions.saveConfig, {
				...typesafe,
				decisionApiKey: 'ts-decision-key-5678',
			});
			await expectNewKeyRequired(
				t.action(api.aiProviderConfigActions.saveConfig, {
					...typesafe,
					decisionBaseUrl: 'https://elsewhere.example.com',
				}),
				'decision'
			);
		});

		it('never carries the key across a kind change', async () => {
			const t = setup();
			await t.action(api.aiProviderConfigActions.saveConfig, {
				...typesafe,
				decisionApiKey: 'ts-decision-key-5678',
			});
			// To a keyless kind: all five columns clear.
			await t.action(api.aiProviderConfigActions.saveConfig, {
				...typesafe,
				decisionProviderKind: 'llm',
				decisionBaseUrl: undefined,
			});
			expect((await storedRow(t))?.decisionSecretCiphertext).toBeUndefined();
			// And back: the old key is gone, so a new one is required.
			await expect(t.action(api.aiProviderConfigActions.saveConfig, typesafe)).rejects.toThrow(
				/requires an API key/
			);
		});
	});
});

describe('embedding space (D8)', () => {
	const ENV_KEYS = ['LLM_API_KEY', 'LLM_PROVIDER', 'LLM_BASE_URL', 'LLM_EMBEDDING_MODEL'] as const;
	afterEach(() => {
		for (const key of ENV_KEYS) vi.stubEnv(key, undefined);
	});

	const anthropic = {
		languageProviderKind: 'anthropic' as const,
		apiKey: 'sk-ant-secret-key-1234',
	};

	async function addKnowledgeEntry(t: ReturnType<typeof setup>, embedding: number[]) {
		const now = Date.now();
		await t.run((ctx) =>
			ctx.db.insert('knowledgeEntries', {
				entryType: 'fact',
				title: 'fact',
				content: 'Prefers EUR invoices',
				sourceType: 'manual',
				embedding,
				confidence: 0.9,
				lastValidatedAt: now,
				createdAt: now,
				updatedAt: now,
			})
		);
	}

	async function addFile(t: ReturnType<typeof setup>, embedding: number[]) {
		const now = Date.now();
		await t.run((ctx) =>
			ctx.db.insert('semanticFiles', {
				filename: 'invoice.pdf',
				mimeType: 'application/pdf',
				fileSize: 13,
				sourceType: 'email_attachment',
				version: 1,
				embedding,
				createdAt: now,
				updatedAt: now,
			})
		);
	}

	const storedRow = (t: ReturnType<typeof setup>) =>
		t.run((ctx) => ctx.db.query('aiProviderConfig').first());

	/** A Google row written before the default moved: no model, so `text-embedding-004`. */
	async function seedLegacyGoogleRow(t: ReturnType<typeof setup>) {
		await t.action(api.aiProviderConfigActions.saveConfig, {
			...anthropic,
			embeddingProviderKind: 'google',
			embeddingApiKey: 'google-test-embedding-key',
		});
		await t.run(async (ctx) => {
			const row = await ctx.db.query('aiProviderConfig').first();
			await ctx.db.patch(row!._id, { embeddingModel: undefined });
		});
	}

	async function expectLocked(
		promise: Promise<unknown>,
		message: RegExp = /embedding model can't change/i
	) {
		const error = await promise.then(
			() => undefined,
			(e: unknown) => e
		);
		expect(error).toBeInstanceOf(ConvexError);
		const data = (
			error as ConvexError<{ category: string; message: string; data: Record<string, Value> }>
		).data;
		expect(data.category).toBe('conflict');
		expect(data.message).toMatch(message);
		expect(data.data).toMatchObject({ reason: EMBEDDING_SPACE_LOCKED });
	}

	it('keeps the implicit legacy Google model when an API or CLI save omits the model', async () => {
		const t = setup();
		await seedLegacyGoogleRow(t);
		await addKnowledgeEntry(t, [0.1, 0.2]);

		// A language-only save, as the CLI or an API client sends it.
		await t.action(api.aiProviderConfigActions.saveConfig, {
			languageProviderKind: 'anthropic',
			modelFast: 'claude-haiku-5-5',
		});
		// The same kind without a model.
		await t.action(api.aiProviderConfigActions.saveConfig, {
			languageProviderKind: 'anthropic',
			embeddingProviderKind: 'google',
		});

		const row = await storedRow(t);
		expect(row?.embeddingProviderKind).toBe('google');
		expect(row?.embeddingModel).toBeUndefined();
		expect(row?.embeddingModelVersion).toBe(1);
		expect(row?.embeddingSecretCiphertext).toBeTruthy();
		const config = await t.query(api.aiProviderConfig.getConfig, {});
		if (!config.configured) throw new Error('unreachable');
		expect(config.resolvedEmbeddingModel).toBe('text-embedding-004');
	});

	it('accepts the form resubmitting the resolved model without a version bump', async () => {
		const t = setup();
		await seedLegacyGoogleRow(t);
		await addKnowledgeEntry(t, [0.1, 0.2]);

		await t.action(api.aiProviderConfigActions.saveConfig, {
			...anthropic,
			embeddingProviderKind: 'google',
			embeddingModel: 'text-embedding-004',
		});

		const row = await storedRow(t);
		expect(row?.embeddingModel).toBe('text-embedding-004');
		expect(row?.embeddingModelVersion).toBe(1);
	});

	it('refuses a new model or provider while the knowledge corpus holds vectors', async () => {
		const t = setup();
		await seedLegacyGoogleRow(t);
		await addKnowledgeEntry(t, [0.1, 0.2]);

		await expectLocked(
			t.action(api.aiProviderConfigActions.saveConfig, {
				...anthropic,
				embeddingProviderKind: 'google',
				embeddingModel: 'gemini-embedding-2',
			})
		);
		await expectLocked(
			t.action(api.aiProviderConfigActions.saveConfig, {
				...anthropic,
				embeddingProviderKind: 'local',
			})
		);

		const row = await storedRow(t);
		expect(row?.embeddingProviderKind).toBe('google');
		expect(row?.embeddingModel).toBeUndefined();
		expect(row?.embeddingModelVersion).toBe(1);
	});

	it('refuses a change while only the file library holds vectors', async () => {
		const t = setup();
		await t.action(api.aiProviderConfigActions.saveConfig, anthropic);
		await addFile(t, [0.3, 0.4]);

		await expectLocked(
			t.action(api.aiProviderConfigActions.saveConfig, {
				...anthropic,
				embeddingProviderKind: 'local',
				embeddingModel: 'mxbai-embed-large',
			})
		);
	});

	it('allows a change while no row holds a vector, and bumps the version', async () => {
		const t = setup();
		await t.action(api.aiProviderConfigActions.saveConfig, anthropic);
		// Rows the pipeline has not embedded yet, fewer than the probe window.
		await addKnowledgeEntry(t, []);
		await addFile(t, []);

		await t.action(api.aiProviderConfigActions.saveConfig, {
			...anthropic,
			embeddingProviderKind: 'local',
			embeddingModel: 'mxbai-embed-large',
		});

		const row = await storedRow(t);
		expect(row?.embeddingModel).toBe('mxbai-embed-large');
		expect(row?.embeddingModelVersion).toBe(2);
	});

	it('fails closed when the newest rows hold no vector but the window is full', async () => {
		const t = setup();
		await t.action(api.aiProviderConfigActions.saveConfig, anthropic);
		for (let i = 0; i < VECTOR_PROBE_ROWS; i++) await addKnowledgeEntry(t, []);

		await expectLocked(
			t.action(api.aiProviderConfigActions.saveConfig, {
				...anthropic,
				embeddingProviderKind: 'local',
				embeddingModel: 'mxbai-embed-large',
			})
		);
	});

	it('compares the first save with the env embedder', async () => {
		const t = setup();
		vi.stubEnv('LLM_API_KEY', 'sk-env-key');
		await addKnowledgeEntry(t, [0.1, 0.2]);

		// The env plane embeds with OpenAI text-embedding-3-small; local is another space.
		await expectLocked(t.action(api.aiProviderConfigActions.saveConfig, anthropic));
		expect(await storedRow(t)).toBeNull();

		await t.action(api.aiProviderConfigActions.saveConfig, {
			...anthropic,
			embeddingProviderKind: 'openai',
			embeddingModel: 'text-embedding-3-small',
			embeddingApiKey: 'sk-embed-secret-key-9999',
		});
		expect((await storedRow(t))?.embeddingProviderKind).toBe('openai');
	});

	it('refuses a removal that falls back to an env embedder in another space', async () => {
		const t = setup();
		await t.action(api.aiProviderConfigActions.saveConfig, anthropic);
		await addKnowledgeEntry(t, [0.1, 0.2]);
		vi.stubEnv('LLM_API_KEY', 'sk-env-key');

		await expectLocked(t.mutation(api.aiProviderConfig.removeConfig, {}));
		expect(await storedRow(t)).not.toBeNull();
	});

	it('refuses a removal with no env fallback, so a later save cannot switch spaces', async () => {
		const t = setup();
		await t.action(api.aiProviderConfigActions.saveConfig, anthropic);
		await addKnowledgeEntry(t, [0.1, 0.2]);

		// The row is the only record of the local space the vectors are in.
		await expectLocked(
			t.mutation(api.aiProviderConfig.removeConfig, {}),
			/can't be removed while the knowledge base or file library holds vectors/
		);
		expect(await storedRow(t)).not.toBeNull();
		// So the follow-up save still compares against it and refuses another space.
		await expectLocked(
			t.action(api.aiProviderConfigActions.saveConfig, {
				...anthropic,
				embeddingProviderKind: 'openai',
				embeddingModel: 'text-embedding-3-small',
				embeddingApiKey: 'sk-embed-secret-key-9999',
			})
		);
		expect((await storedRow(t))?.embeddingProviderKind).toBe('local');
	});

	it('allows a removal with no env fallback once the corpus holds no vector', async () => {
		const t = setup();
		await t.action(api.aiProviderConfigActions.saveConfig, anthropic);
		await addKnowledgeEntry(t, []);

		expect(await t.mutation(api.aiProviderConfig.removeConfig, {})).toEqual({ removed: true });
	});

	it('resolves an omitted embedding selection against the row the mutation writes', async () => {
		const t = setup();
		await t.action(api.aiProviderConfigActions.saveConfig, anthropic);
		// A language-only save reads the row (local) in its action. Before its
		// persist mutation runs, a concurrent save switches the embedder.
		await t.action(api.aiProviderConfigActions.saveConfig, {
			...anthropic,
			embeddingProviderKind: 'openai',
			embeddingModel: 'text-embedding-3-small',
			embeddingApiKey: 'sk-embed-secret-key-9999',
		});
		await addKnowledgeEntry(t, [0.1, 0.2]);
		// The language-only persist then lands with its embedding fields omitted,
		// exactly as saveConfig forwards them.
		await t.mutation(internal.aiProviderConfig._persistConfig, {
			languageProviderKind: 'anthropic',
			modelFast: 'claude-haiku-5-5',
			modelCapable: 'claude-sonnet-5-5',
			isLanguageLocal: false,
		});

		// Neither restored to the stale local model nor refused on the populated corpus.
		const row = await storedRow(t);
		expect(row?.embeddingProviderKind).toBe('openai');
		expect(row?.embeddingModel).toBe('text-embedding-3-small');
		expect(row?.embeddingModelVersion).toBe(2);
		expect(row?.embeddingSecretCiphertext).toBeTruthy();
	});

	it('allows a removal when the env embedder resolves the same space', async () => {
		const t = setup();
		await t.action(api.aiProviderConfigActions.saveConfig, {
			...anthropic,
			embeddingProviderKind: 'openai',
			embeddingModel: 'text-embedding-3-small',
			embeddingApiKey: 'sk-embed-secret-key-9999',
		});
		await addKnowledgeEntry(t, [0.1, 0.2]);
		vi.stubEnv('LLM_API_KEY', 'sk-env-key');

		expect(await t.mutation(api.aiProviderConfig.removeConfig, {})).toEqual({ removed: true });
	});
});

describe('vector commits from a stale embedding space', () => {
	const anthropic = {
		languageProviderKind: 'anthropic' as const,
		apiKey: 'sk-ant-secret-key-1234',
	};
	const vector = [0.1, 0.2, 0.3];

	/** What an embedding job captures when it resolves its model (`resolveIndexEmbedder`). */
	const jobSpaceKey = (t: ReturnType<typeof setup>) =>
		t.run(async (ctx) =>
			embeddingSpaceKey(resolvedEmbeddingSpace(await ctx.db.query('aiProviderConfig').first()))
		);

	it('drops the vector a job embedded before the space switched, and keeps the row', async () => {
		const t = setup();
		await t.action(api.aiProviderConfigActions.saveConfig, anthropic);
		const now = Date.now();
		const fileId = await t.run((ctx) =>
			ctx.db.insert('semanticFiles', {
				filename: 'invoice.pdf',
				mimeType: 'application/pdf',
				fileSize: 13,
				sourceType: 'email_attachment',
				version: 1,
				embedding: [],
				createdAt: now,
				updatedAt: now,
			})
		);
		// Two jobs resolve the local nomic space and start embedding.
		const staleKey = await jobSpaceKey(t);
		// The corpus is still empty, so the admin may switch to mxbai.
		await t.action(api.aiProviderConfigActions.saveConfig, {
			...anthropic,
			embeddingProviderKind: 'local',
			embeddingModel: 'mxbai-embed-large',
		});
		expect(await jobSpaceKey(t)).not.toBe(staleKey);

		// The late nomic vectors commit.
		await t.mutation(internal.semanticFiles.updateProcessedMetadata, {
			fileId,
			summary: 'An invoice',
			embedding: vector,
			embeddingModel: 'nomic-embed-text',
			embeddingGeneratedAt: now,
			embeddingSpaceKey: staleKey,
		});
		const entryId = await t.mutation(internal.knowledge.graph.saveEntry, {
			entryType: 'fact',
			title: 'fact',
			content: 'Prefers EUR invoices',
			sourceType: 'manual',
			embedding: vector,
			embeddingModel: 'nomic-embed-text',
			embeddingGeneratedAt: now,
			confidence: 0.9,
			embeddingSpaceKey: staleKey,
		});

		// The rows keep everything but the vector, so they read as not yet embedded.
		const file = await t.run((ctx) => ctx.db.get(fileId));
		expect(file).toMatchObject({ summary: 'An invoice', embedding: [] });
		expect(file?.embeddingModel).toBeUndefined();
		const entry = await t.run((ctx) => ctx.db.get(entryId));
		expect(entry).toMatchObject({ title: 'fact', embedding: [] });
		expect(entry?.embeddingGeneratedAt).toBeUndefined();

		// A job in the current space commits normally.
		await t.mutation(internal.semanticFiles.updateProcessedMetadata, {
			fileId,
			embedding: vector,
			embeddingSpaceKey: await jobSpaceKey(t),
		});
		expect((await t.run((ctx) => ctx.db.get(fileId)))?.embedding).toEqual(vector);
	});
});

describe('new embedding key binding', () => {
	const anthropic = {
		languageProviderKind: 'anthropic' as const,
		apiKey: 'sk-ant-secret-key-1234',
	};
	const envelope = {
		ciphertext: 'c',
		iv: 'i',
		authTag: 'a',
		version: 1,
		keyPreview: 'goo…9999',
	};

	it('refuses a new embedding key without the kind it belongs to', async () => {
		const t = setup();
		await t.action(api.aiProviderConfigActions.saveConfig, {
			...anthropic,
			embeddingProviderKind: 'openai',
			embeddingModel: 'text-embedding-3-small',
			embeddingApiKey: 'sk-embed-secret-key-9999',
		});
		const before = await t.run((ctx) => ctx.db.query('aiProviderConfig').first());

		await expect(
			t.action(api.aiProviderConfigActions.saveConfig, {
				...anthropic,
				embeddingApiKey: 'google-new-key-1234',
			})
		).rejects.toThrow(/embedding provider this API key belongs to/);
		expect(await t.run((ctx) => ctx.db.query('aiProviderConfig').first())).toEqual(before);
	});

	it('binds the key to the named kind even if the row switched before the mutation', async () => {
		const t = setup();
		// The admin validated a Google key; a concurrent save switched the row to OpenAI.
		await t.action(api.aiProviderConfigActions.saveConfig, {
			...anthropic,
			embeddingProviderKind: 'openai',
			embeddingModel: 'text-embedding-3-small',
			embeddingApiKey: 'sk-embed-secret-key-9999',
		});
		const persist = {
			languageProviderKind: 'anthropic' as const,
			modelFast: 'claude-haiku-5-5',
			modelCapable: 'claude-sonnet-5-5',
			isLanguageLocal: false,
			embeddingEnvelope: envelope,
		};

		// Without a kind the mutation refuses rather than attaching the key to OpenAI.
		await expect(t.mutation(internal.aiProviderConfig._persistConfig, persist)).rejects.toThrow(
			/embedding provider this API key belongs to/
		);

		await t.mutation(internal.aiProviderConfig._persistConfig, {
			...persist,
			embeddingProviderKind: 'google',
		});
		const row = await t.run((ctx) => ctx.db.query('aiProviderConfig').first());
		expect(row?.embeddingProviderKind).toBe('google');
		expect(row?.embeddingKeyPreview).toBe('goo…9999');
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
