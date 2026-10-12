/**
 * Stored-key reuse on the AI-provider form (Phase 0 follow-up). A stored key
 * applies only while its plane keeps the same provider kind and base URL; the
 * server refuses a save that would carry it across either change
 * (`stored_key_not_reusable`). The form asks the same question: the key field
 * reads as empty, the reason shows at once, and a save without a new key never
 * reaches the server. The server's own refusal lands on its field instead of
 * in a toast.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref, type Ref } from 'vue';
import type { OperationError } from '@owlat/shared/operationError';
import { createTestI18n } from '~/__tests__/i18n';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

const { useAiProviderForm } = await import('../useAiProviderForm');

let config: Ref<Record<string, unknown> | null>;
let saveCalls: Record<string, unknown>[];
/** The `onError` each operation was built with, by label. */
let onErrors: Record<string, (op: OperationError) => boolean>;
/** What `saveConfig` does next: land, or fail through its `onError`. */
let saveFailure: OperationError | null;
const showToast = vi.fn();

const NOT_REUSABLE =
	"The saved key belongs to the previous provider or address, so it doesn't carry over. Paste the key for this one to continue.";

beforeEach(() => {
	const i18n = createTestI18n();
	vi.stubGlobal('useI18n', () => i18n.global);
	vi.stubGlobal('useToast', () => ({ showToast }));
	showToast.mockReset();
	config = ref(null);
	saveCalls = [];
	onErrors = {};
	saveFailure = null;
	vi.stubGlobal('useOrganizationQuery', () => ({
		data: config,
		isLoading: ref(false),
		error: ref(null),
	}));
	vi.stubGlobal(
		'useBackendOperation',
		(
			_reference: unknown,
			options: { label: string | (() => string); onError?: (op: OperationError) => boolean }
		) => {
			const label = typeof options.label === 'function' ? options.label() : options.label;
			if (options.onError) onErrors[label] = options.onError;
			return {
				run: vi.fn(async (args: Record<string, unknown>) => {
					if (label === 'Save AI provider') {
						saveCalls.push(args);
						if (saveFailure) {
							options.onError?.(saveFailure);
							return { ok: false };
						}
					}
					return { ok: true, result: { ok: true } };
				}),
				isLoading: ref(false),
			};
		}
	);
});

function existingConfig(overrides: Record<string, unknown> = {}) {
	return {
		configured: true,
		languageProviderKind: 'openai',
		modelFast: 'gpt-5.6-luna',
		modelCapable: 'gpt-5.6-sol',
		isLanguageKeySet: true,
		keyPreview: 'sk-…7c1e',
		embeddingProviderKind: 'openai',
		resolvedEmbeddingModel: 'text-embedding-3-small',
		isEmbeddingKeySet: true,
		...overrides,
	};
}

describe('the language key', () => {
	it('keeps the stored key for the same provider and an equivalent base URL', async () => {
		config.value = existingConfig({ languageBaseUrl: 'https://API.example.com:443/v1/' });
		const form = useAiProviderForm();
		form.form.languageBaseUrl = 'https://api.example.com/v1';
		expect(form.storedLanguageKeySet.value).toBe(true);
		expect(form.languageError.value).toBeNull();
		await form.handleSave();
		expect(saveCalls).toHaveLength(1);
		expect(saveCalls[0]?.['apiKey']).toBeUndefined();
	});

	it('drops the stored key when the base URL changes, says so, and does not save', async () => {
		config.value = existingConfig();
		const form = useAiProviderForm();
		form.form.languageBaseUrl = 'https://proxy.example.com/v1';
		expect(form.storedLanguageKeySet.value).toBe(false);
		expect(form.languageError.value).toBe(NOT_REUSABLE);
		expect(form.liveLanguageError.value).toBe('shared.aiProviders.validation.storedKeyNotReusable');
		await form.handleSave();
		expect(saveCalls).toHaveLength(0);
		expect(form.languageError.value).toBe(NOT_REUSABLE);

		form.form.apiKey = 'sk-new';
		expect(form.liveLanguageError.value).toBeNull();
		await form.handleSave();
		expect(saveCalls[0]).toMatchObject({
			apiKey: 'sk-new',
			languageBaseUrl: 'https://proxy.example.com/v1',
		});
	});

	it('drops the stored key when the provider changes', () => {
		config.value = existingConfig();
		const form = useAiProviderForm();
		form.form.languageProviderKind = 'anthropic';
		expect(form.storedLanguageKeySet.value).toBe(false);
		expect(form.languageError.value).toBe(NOT_REUSABLE);
	});

	it('says nothing for a local provider, which needs no key', () => {
		config.value = existingConfig();
		const form = useAiProviderForm();
		form.form.languageProviderKind = 'ollama';
		expect(form.languageError.value).toBeNull();
	});
});

describe('the embedding key', () => {
	it('drops the stored key when the embedder changes, and blocks the save', async () => {
		config.value = existingConfig();
		const form = useAiProviderForm();
		expect(form.storedEmbeddingKeySet.value).toBe(true);
		form.form.embeddingProviderKind = 'google';
		expect(form.storedEmbeddingKeySet.value).toBe(false);
		expect(form.embeddingError.value).toBe(NOT_REUSABLE);
		await form.handleSave();
		expect(saveCalls).toHaveLength(0);
		expect(form.embeddingError.value).toBe(NOT_REUSABLE);
	});

	it('keeps the stored key for the same embedder', async () => {
		config.value = existingConfig();
		const form = useAiProviderForm();
		form.form.embeddingModelChoice = 'text-embedding-3-large';
		expect(form.embeddingError.value).toBeNull();
		await form.handleSave();
		expect(saveCalls).toHaveLength(1);
	});
});

describe('the decision key', () => {
	const typesafe = {
		decisionProviderKind: 'typesafe',
		decisionModel: 'jev-1.13.0',
		isDecisionKeySet: true,
		decisionKeyPreview: 'ts-…a1b2',
	};

	it('keeps the stored key for the same vendor and origin', () => {
		config.value = existingConfig(typesafe);
		const form = useAiProviderForm();
		expect(form.storedDecisionKeySet.value).toBe(true);
		expect(form.decisionKeyHint.value).toBeNull();
	});

	it('notes, without blocking, that a changed origin needs the key again', async () => {
		config.value = existingConfig(typesafe);
		const form = useAiProviderForm();
		form.decisionForm.baseUrl = 'https://ai-proxy.example.com';
		expect(form.storedDecisionKeySet.value).toBe(false);
		expect(form.decisionKeyHint.value).toBe('shared.aiProviders.decision.storedKeyNotReusable');
		// The environment may hold the key, so the server decides.
		await form.handleSave();
		expect(saveCalls).toHaveLength(1);
	});
});

describe('save refusals on their field', () => {
	it('puts the server refusal for each plane on its field, with no toast', async () => {
		config.value = existingConfig();
		const form = useAiProviderForm();
		saveFailure = {
			category: 'invalid_input',
			message: 'The language provider or its base URL changed …',
			data: { reason: 'stored_key_not_reusable', plane: 'language' },
		};
		await form.handleSave();
		expect(form.languageError.value).toBe(NOT_REUSABLE);

		saveFailure = {
			...saveFailure,
			data: { reason: 'stored_key_not_reusable', plane: 'embedding' },
		};
		await form.handleSave();
		expect(form.embeddingError.value).toBe(NOT_REUSABLE);
	});

	it('puts a decision refusal on the decision card', async () => {
		config.value = existingConfig({ decisionProviderKind: 'typesafe', isDecisionKeySet: true });
		const form = useAiProviderForm();
		saveFailure = {
			category: 'invalid_input',
			message: 'x',
			data: { reason: 'stored_key_not_reusable', plane: 'decision' },
		};
		await form.handleSave();
		expect(form.decisionError.value).toBe(
			'shared.aiProviders.decision.validation.storedKeyNotReusable'
		);
	});

	it('leaves any other failure to the operation layer', () => {
		config.value = existingConfig();
		useAiProviderForm();
		const claim = onErrors['Save AI provider'];
		expect(claim?.({ category: 'internal', message: 'boom' })).toBe(false);
		expect(claim?.({ category: 'invalid_input', message: 'x', data: { reason: 'other' } })).toBe(
			false
		);
	});
});
