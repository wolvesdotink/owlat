// @vitest-environment happy-dom
/**
 * The embedding search section (U1): the search state and coverage, a
 * re-embed that is free and direct for a local embedder, paid and confirmed
 * for a hosted one, and refused with a reason until spend admission exists;
 * the attestation, worded as the admin's own statement and sent only once
 * confirmed; and the staged rebuild's validate and activate.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';
import { embeddingStatus, job, space } from '~/utils/__tests__/embeddingStatusFixtures';
import type { EmbeddingStatus } from '~/utils/embeddingSpaces';

const status = ref<EmbeddingStatus | null>(null);
const validation = ref<unknown>(null);
const spaces = {
	status,
	isLoading: ref(false),
	error: ref(null),
	refetch: vi.fn(),
	isBusy: ref(false),
	validation,
	refresh: vi.fn(async () => true),
	startReembed: vi.fn(async () => true),
	resume: vi.fn(async () => true),
	cancel: vi.fn(async () => true),
	attest: vi.fn(async () => true),
	revoke: vi.fn(async () => true),
	startRebuild: vi.fn(async () => true),
	validate: vi.fn(async () => true),
	activate: vi.fn(async () => true),
	catchUp: vi.fn(async () => true),
	cancelRebuild: vi.fn(async () => true),
	rollback: vi.fn(async () => true),
};
vi.mock('~/composables/useEmbeddingSpaces', () => ({ useEmbeddingSpaces: () => spaces }));

const AiEmbeddingSpaceCard = (await import('../AiEmbeddingSpaceCard.vue')).default;
const AiEmbeddingAttestation = (await import('../AiEmbeddingAttestation.vue')).default;
const AiEmbeddingRebuild = (await import('../AiEmbeddingRebuild.vue')).default;

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

beforeEach(() => {
	for (const fn of Object.values(spaces)) {
		if (typeof fn === 'function' && 'mockClear' in fn) fn.mockClear();
	}
	validation.value = null;
	status.value = embeddingStatus();
});

const slot = { template: '<div><slot /></div>' };
function mountCard() {
	return mount(AiEmbeddingSpaceCard, {
		global: {
			plugins: [createTestI18n()],
			components: {
				SettingsAiEmbeddingAttestation: AiEmbeddingAttestation,
				SettingsAiEmbeddingRebuild: AiEmbeddingRebuild,
			},
			stubs: {
				UiCard: slot,
				UiQueryBoundary: slot,
				UiSkeleton: true,
				Icon: true,
				UiButton: {
					props: ['disabled', 'type'],
					emits: ['click'],
					template:
						'<button :type="type ?? \'button\'" :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
				},
				UiSelect: {
					props: ['modelValue', 'options', 'label'],
					emits: ['update:modelValue'],
					template:
						'<label>{{ label }}<select :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value)"><option v-for="o in options" :key="o.value" :value="o.value">{{ o.label }}</option></select></label>',
				},
				UiInput: {
					props: ['modelValue', 'label', 'error', 'helpText'],
					emits: ['update:modelValue'],
					template:
						'<label>{{ label }}<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" /><span>{{ helpText }}</span><span v-if="error">{{ error }}</span></label>',
				},
				UiTextarea: {
					props: ['modelValue', 'label', 'placeholder'],
					emits: ['update:modelValue'],
					template:
						'<label>{{ label }}<textarea :placeholder="placeholder" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" /></label>',
				},
				UiCheckbox: {
					props: ['modelValue', 'label'],
					emits: ['update:modelValue'],
					template:
						'<label><input type="checkbox" data-testid="checkbox" :checked="modelValue" @change="$emit(\'update:modelValue\', $event.target.checked)" />{{ label }}</label>',
				},
				UiConfirmationDialog: {
					props: ['open', 'title', 'description', 'confirmText'],
					emits: ['confirm', 'update:open'],
					template:
						'<div v-if="open" data-testid="dialog"><p>{{ title }}</p><p>{{ description }}</p><button data-testid="dialog-confirm" @click="$emit(\'confirm\')">{{ confirmText }}</button></div>',
				},
				SettingsAiModelPicker: { props: ['label'], template: '<div>{{ label }}</div>' },
			},
		},
	});
}

const local = () => {
	const base = embeddingStatus();
	return {
		...base,
		configured: { ...base.configured!, provider: 'local' as const, isLocal: true },
		active: space({ provider: 'local', model: 'nomic-embed-text', dimensions: 768 }),
	};
};

describe('AiEmbeddingSpaceCard', () => {
	it('shows what vector search uses and how much of the corpus it reaches', () => {
		const w = mountCard();
		expect(w.get('[data-testid="ai-embedding-search-state"]').text()).toContain(
			'Vector search uses text-embedding-3-small'
		);
		expect(w.text()).toContain('OpenAI (hosted), 1536 dimensions');
		const knowledge = w.get('[data-testid="ai-embedding-coverage-knowledgeEntries"]');
		expect(knowledge.findAll('td').map((cell) => cell.text())).toEqual(['12', '230', '4', '3']);
		expectFullyLocalized(w);
	});

	it('says when a switch has not landed its first vector yet', () => {
		const base = embeddingStatus();
		status.value = {
			...base,
			configured: { ...base.configured!, model: 'text-embedding-3-large', isActive: false },
		};
		const state = mountCard().get('[data-testid="ai-embedding-search-state"]');
		expect(state.attributes('data-state')).toBe('switching');
		expect(state.text()).toContain('Switching to text-embedding-3-large');
	});

	it('refuses a paid re-embed with its reason until spend admission exists', () => {
		const w = mountCard();
		expect(
			w.get('[data-testid="ai-embedding-reembed-start"]').attributes('disabled')
		).toBeDefined();
		expect(w.get('[data-testid="ai-embedding-reembed-blocker"]').text()).toContain(
			'spend admission'
		);
	});

	it('confirms a paid re-embed before it starts', async () => {
		status.value = embeddingStatus({ isPaidEmbeddingAvailable: true });
		const w = mountCard();
		await w.get('[data-testid="ai-embedding-reembed-start"]').trigger('click');
		expect(spaces.startReembed).not.toHaveBeenCalled();
		expect(w.get('[data-testid="dialog"]').text()).toContain(
			'About 275 items are sent to OpenAI (hosted)'
		);
		await w.get('[data-testid="dialog-confirm"]').trigger('click');
		expect(spaces.startReembed).toHaveBeenCalledTimes(1);
	});

	it('starts a free local re-embed directly, and offers no attestation', async () => {
		status.value = local();
		const w = mountCard();
		expect(w.text()).toContain('re-embedding is free');
		await w.get('[data-testid="ai-embedding-reembed-start"]').trigger('click');
		expect(spaces.startReembed).toHaveBeenCalledTimes(1);
		expect(w.find('[data-testid="ai-embedding-attest-form"]').exists()).toBe(false);
	});

	it('shows a running job with its progress, and cancels it', async () => {
		const running = job();
		status.value = embeddingStatus({ jobs: [running] });
		const w = mountCard();
		const card = w.get('[data-testid="ai-embedding-reembed-job"]');
		expect(card.text()).toContain('40 embedded, 64 checked so far (Knowledge)');
		await card.findAll('button').at(-1)!.trigger('click');
		expect(spaces.cancel).toHaveBeenCalledWith(running);
	});

	it('records an attestation only once it is confirmed and has a basis', async () => {
		const w = mountCard();
		const form = w.get('[data-testid="ai-embedding-attest-form"]');
		expect(form.text()).toContain('271 items have vectors with no recorded model');
		const submit = w.get('[data-testid="ai-embedding-attest-submit"]');
		expect(submit.attributes('disabled')).toBeDefined();
		await form.get('textarea').setValue('This deployment has used it since setup.');
		expect(submit.attributes('disabled')).toBeDefined();
		await form.get('[data-testid="checkbox"]').setValue(true);
		expect(submit.attributes('disabled')).toBeUndefined();
		await form.trigger('submit');
		await flushPromises();
		expect(spaces.attest).toHaveBeenCalledWith({
			spaceId: 'sp_active',
			source: 'attestation',
			cohort: { tables: ['knowledgeEntries', 'semanticFiles'], writtenUntil: expect.any(Number) },
			statement: 'This deployment has used it since setup.',
		});
	});

	it('validates and activates a filled staged rebuild', async () => {
		const staged = space({
			_id: 'sp_staged' as never,
			model: 'text-embedding-3-large',
			state: 'staged',
		});
		status.value = embeddingStatus({
			staged,
			canStageRebuild: false,
			jobs: [job({ kind: 'rebuild', targetSpaceId: 'sp_staged' as never, status: 'completed' })],
		});
		validation.value = { spaceId: 'sp_staged', sampled: 5, passed: 5, isPassing: true };
		const w = mountCard();
		const section = w.get('[data-testid="ai-embedding-rebuild-staged"]');
		expect(section.text()).toContain('Building text-embedding-3-large');
		expect(w.get('[data-testid="ai-embedding-rebuild-validation"]').text()).toBe(
			'5 of 5 sampled items found themselves with the new model.'
		);
		await w.get('[data-testid="ai-embedding-rebuild-activate"]').trigger('click');
		expect(spaces.activate).toHaveBeenCalledTimes(1);
	});

	it('waits for the rebuild to fill before it can activate', () => {
		const staged = space({ _id: 'sp_staged' as never, state: 'staged' });
		status.value = embeddingStatus({
			staged,
			jobs: [job({ kind: 'rebuild', targetSpaceId: 'sp_staged' as never })],
		});
		expect(
			mountCard().get('[data-testid="ai-embedding-rebuild-activate"]').attributes('disabled')
		).toBeDefined();
	});
});
