/**
 * The AI-provider form's inline validation copy, and the DECISION plane's
 * opt-in contract.
 *
 * `embeddingProviderMeta().label` is a MESSAGE KEY, so the hosted-embedder "needs an API key" error has to
 * translate it before interpolation — otherwise the admin reads
 * "shared.aiProviders.embedders.openai.label needs an API key." on the settings
 * page. These tests pin the rendered sentence, not the key path.
 *
 * The decision-plane suites below pin the one promise P1b makes to every
 * install that never heard of this plane: a save carries NO decision arguments,
 * so `saveConfig`'s "an absent kind leaves the plane alone" rule keeps the
 * deployment exactly as it was. The arguments a save DOES carry, once an
 * operator enables it, are asserted against the captured call rather than
 * against the form — the form is not what reaches the backend.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref, type Ref } from 'vue';
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

/** The stored config the form hydrates from; set BEFORE the form is created. */
let config: Ref<Record<string, unknown> | null>;
/** Every `saveConfig` call, in order, exactly as the backend would receive it. */
let saveCalls: Record<string, unknown>[];
/** What `testConnection` answers next. */
let testResult: { ok: boolean; error?: string };

beforeEach(() => {
	const i18n = createTestI18n();
	vi.stubGlobal('useI18n', () => i18n.global);
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
	// No stored config by default: nothing is hydrated and no key is on file,
	// which is the state in which the hosted-embedder guard fires.
	config = ref(null);
	saveCalls = [];
	testResult = { ok: true };
	vi.stubGlobal('useOrganizationQuery', () => ({
		data: config,
		isLoading: ref(false),
		error: ref(null),
	}));
	// The three operations are told apart by their label getter — the function
	// references are all the same bottomless `api` Proxy.
	vi.stubGlobal(
		'useBackendOperation',
		(_reference: unknown, options: { label: string | (() => string) }) => {
			const label = typeof options.label === 'function' ? options.label() : options.label;
			return {
				run: vi.fn(async (args: Record<string, unknown>) => {
					if (label === 'Save AI provider') saveCalls.push(args);
					if (label === 'Test AI connection') return { ok: true, result: testResult };
					return { ok: true, result: { ok: true } };
				}),
				isLoading: ref(false),
			};
		}
	);
});

/** A configured install that has never touched the decision plane. */
function existingConfig(overrides: Record<string, unknown> = {}) {
	return {
		configured: true,
		languageProviderKind: 'openai',
		modelFast: 'gpt-5.6-luna',
		modelCapable: 'gpt-5.6-sol',
		isLanguageKeySet: true,
		embeddingProviderKind: 'local',
		...overrides,
	};
}

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

describe('the decision plane is an opt-in, and silent until it is taken', () => {
	it('sends no decision argument at all from an install that never opted in', async () => {
		config.value = existingConfig();
		const form = useAiProviderForm();

		await form.handleSave();

		expect(saveCalls).toHaveLength(1);
		// Not `decisionProviderKind: undefined` — the key must be ABSENT, because
		// the backend reads an absent kind as "leave the plane alone" and would
		// read anything else as an instruction.
		expect(Object.keys(saveCalls[0]!)).not.toContain('decisionProviderKind');
		expect(Object.keys(saveCalls[0]!)).not.toContain('decisionApiKey');
	});

	it('preselects no vendor on an install that already has a config', () => {
		config.value = existingConfig();
		const form = useAiProviderForm();

		expect(form.decisionEnabled.value).toBe(false);
		expect(form.decisionForm.kind).toBe('llm');
		expect(form.decisionConsentOwed.value).toBe(false);
	});

	it('pre-fills the recommended vendor for a BRAND-NEW config, and still sends nothing', async () => {
		// No stored row at all: this is the wizard's install, the only one that
		// sees TypeSafe pre-filled.
		const form = useAiProviderForm();
		expect(form.decisionForm.kind).toBe('typesafe');
		expect(form.decisionEnabled.value).toBe(false);

		form.form.apiKey = 'sk-language';
		await form.handleSave();

		expect(Object.keys(saveCalls[0]!)).not.toContain('decisionProviderKind');
	});

	it('hydrates a stored plane, and a stored language-backed one reads as off', () => {
		config.value = existingConfig({
			decisionProviderKind: 'typesafe',
			decisionModel: 'jev-1.13.0',
			decisionBaseUrl: 'https://ai-proxy.example.com',
			isDecisionFallbackEnabled: true,
			isDecisionKeySet: true,
			decisionKeyPreview: 'ts-…a1b2',
		});
		const form = useAiProviderForm();

		expect(form.decisionEnabled.value).toBe(true);
		expect(form.decisionForm.isFallbackEnabled).toBe(true);
		expect(form.decisionKeyPreview.value).toBe('ts-…a1b2');
		expect(form.decisionEndpoint.value).toBe('ai-proxy.example.com');
		// A stored `'llm'` resolves to exactly what an unconfigured install
		// resolves to, so it renders as off rather than as a configured plane.
		config.value = existingConfig({ decisionProviderKind: 'llm' });
		const second = useAiProviderForm();
		expect(second.decisionEnabled.value).toBe(false);
	});
});

describe('the consent gate', () => {
	it('refuses the whole save until the block has been answered', async () => {
		config.value = existingConfig();
		const form = useAiProviderForm();
		form.decisionEnabled.value = true;
		form.decisionForm.kind = 'typesafe';
		form.decisionForm.apiKey = 'ts-live-key';

		await form.handleSave();

		// Nothing was written — not the decision plane, and not the two cards
		// above it either. A half-applied save is what an operator cannot reason
		// about.
		expect(saveCalls).toHaveLength(0);
		expect(form.decisionError.value).toBe('shared.aiProviders.decision.validation.consentRequired');
	});

	it('sends the plane once consent is given, and forgets the key afterwards', async () => {
		config.value = existingConfig();
		const form = useAiProviderForm();
		form.decisionEnabled.value = true;
		form.decisionForm.kind = 'typesafe';
		form.decisionForm.apiKey = 'ts-live-key';
		form.decisionConsent.value = true;

		await form.handleSave();

		expect(saveCalls).toHaveLength(1);
		expect(saveCalls[0]).toMatchObject({
			decisionProviderKind: 'typesafe',
			decisionModel: 'jev-1.13.0',
			isDecisionFallbackEnabled: false,
			decisionApiKey: 'ts-live-key',
		});
		// Never keep a plaintext key in memory once it is persisted.
		expect(form.decisionForm.apiKey).toBe('');
	});

	it('does not re-ask an operator who already runs that vendor', async () => {
		config.value = existingConfig({
			decisionProviderKind: 'typesafe',
			isDecisionKeySet: true,
		});
		const form = useAiProviderForm();
		expect(form.decisionConsentOwed.value).toBe(false);

		form.decisionForm.modelChoice = 'jev-latest';
		await form.handleSave();

		expect(saveCalls[0]).toMatchObject({
			decisionProviderKind: 'typesafe',
			decisionModel: 'jev-latest',
		});
	});
});

describe('turning the plane off', () => {
	it('travels as an explicit language-backed kind, not as an omission', async () => {
		config.value = existingConfig({
			decisionProviderKind: 'typesafe',
			isDecisionKeySet: true,
		});
		const form = useAiProviderForm();
		expect(form.decisionEnabled.value).toBe(true);

		form.decisionEnabled.value = false;
		await form.handleSave();

		// An omitted kind would leave the vendor — and its stored key — exactly
		// where they were while the card claimed to be off.
		expect(saveCalls[0]).toMatchObject({ decisionProviderKind: 'llm' });
		expect(form.decisionForm.kind).toBe('llm');
	});
});

describe('the degraded state the card puts into words', () => {
	it('calls a stored TypeSafe plane with a key healthy, and thresholds live', () => {
		config.value = existingConfig({
			decisionProviderKind: 'typesafe',
			isDecisionKeySet: true,
		});
		const form = useAiProviderForm();

		expect(form.decisionDegradedReasons.value).toEqual([]);
		expect(form.decisionThresholdsInert.value).toBe(false);
	});

	it('says the language model is answering whenever the plane is not enabled', () => {
		config.value = existingConfig();
		const form = useAiProviderForm();

		expect(form.decisionDegradedReasons.value).toEqual(['languageBacked']);
		expect(form.decisionThresholdsInert.value).toBe(true);
	});

	it('stays healthy when the stored key tests clean', async () => {
		config.value = existingConfig({
			decisionProviderKind: 'typesafe',
			isDecisionKeySet: true,
		});
		const form = useAiProviderForm();

		await form.handleDecisionTest();

		expect(form.decisionTestState.value.status).toBe('ok');
		expect(form.decisionDegradedReasons.value).toEqual([]);
	});

	it('goes degraded and inert on a failed key test, in the words the backend sent', async () => {
		config.value = existingConfig({
			decisionProviderKind: 'typesafe',
			isDecisionKeySet: true,
		});
		testResult = { ok: false, error: 'The TypeSafe key was refused.' };
		const form = useAiProviderForm();

		await form.handleDecisionTest();

		expect(form.decisionTestState.value).toEqual({
			status: 'error',
			message: 'The TypeSafe key was refused.',
		});
		expect(form.decisionDegradedReasons.value).toEqual(['testFailed']);
		expect(form.decisionThresholdsInert.value).toBe(true);
	});
});
