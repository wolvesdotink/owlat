/**
 * The AI-provider form's inline validation copy. `embeddingProviderMeta().label`
 * is a MESSAGE KEY, so the hosted-embedder "needs an API key" error has to
 * translate it before interpolation — otherwise the admin reads
 * "shared.aiProviders.embedders.openai.label needs an API key." on the settings
 * page. These tests pin the rendered sentence, not the key path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';
import { createTestI18n } from '~/__tests__/i18n';

// `api` is a bottomless Proxy: every path resolves to the same value, which is
// all the stubbed query/operation helpers below need.
vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

import { useAiProviderForm } from '../useAiProviderForm';

beforeEach(() => {
	const i18n = createTestI18n();
	vi.stubGlobal('useI18n', () => i18n.global);
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
	// No stored config: nothing is hydrated and no key is on file, which is the
	// state in which the hosted-embedder guard fires.
	vi.stubGlobal('useOrganizationQuery', () => ({
		data: ref(null),
		isLoading: ref(false),
		error: ref(null),
	}));
	vi.stubGlobal('useBackendOperation', () => ({
		run: vi.fn(async () => ({})),
		isLoading: ref(false),
	}));
});

describe('useAiProviderForm hosted-embedder key guard', () => {
	it('names the embedder in translated copy, not by its message key', async () => {
		const form = useAiProviderForm();
		// The language half has to validate first — handleSave returns early on a
		// language error, before it ever reaches the embedding guard.
		form.form.apiKey = 'sk-language';
		form.form.embeddingProviderKind = 'openai';
		form.form.embeddingApiKey = '';

		await form.handleSave();

		expect(form.embeddingError.value).toBe('OpenAI (hosted) needs an API key.');
		expect(form.embeddingError.value).not.toContain('shared.aiProviders');
		expect(form.embeddingError.value).not.toContain('{provider}');
	});

	it('clears once a key is typed', async () => {
		const form = useAiProviderForm();
		form.form.apiKey = 'sk-language';
		form.form.embeddingProviderKind = 'openai';
		await form.handleSave();
		expect(form.embeddingError.value).not.toBeNull();

		form.form.embeddingApiKey = 'sk-test';
		await form.handleSave();
		expect(form.embeddingError.value).toBeNull();
	});

	it('leaves a local embedder unguarded (no key needed)', async () => {
		const form = useAiProviderForm();
		form.form.apiKey = 'sk-language';
		form.form.embeddingProviderKind = 'local';

		await form.handleSave();

		expect(form.embeddingError.value).toBeNull();
	});
});
