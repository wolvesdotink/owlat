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
const AiEmbeddingRebuildStaged = (await import('../AiEmbeddingRebuildStaged.vue')).default;

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
				SettingsAiEmbeddingRebuildStaged: AiEmbeddingRebuildStaged,
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
						'<div v-if="open" data-testid="dialog"><p>{{ title }}</p><p>{{ description }}</p><button data-testid="dialog-confirm" @click="$emit(\'confirm\')">{{ confirmText }}</button><button data-testid="dialog-dismiss" @click="$emit(\'update:open\', false)">x</button></div>',
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
			'Up to 279 items are sent to OpenAI (hosted)'
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
			isPaidEmbeddingAvailable: true,
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
		expect(w.get('[data-testid="dialog"]').text()).toContain('Activation validates again first');
		await w.get('[data-testid="dialog-confirm"]').trigger('click');
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

	describe('Sol round 5', () => {
		const stagedSpace = () =>
			space({
				_id: 'sp_staged' as never,
				model: 'text-embedding-3-large',
				state: 'staged',
				slot: 'secondary',
			});
		const rebuild = (over: Parameters<typeof job>[0] = {}) =>
			job({ kind: 'rebuild', targetSpaceId: 'sp_staged' as never, ...over });

		it('F1: a settings change under the form takes the confirmation back', async () => {
			const base = embeddingStatus({ active: null });
			status.value = { ...base, configured: { ...base.configured!, isActive: false } };
			const w = mountCard();
			const form = w.get('[data-testid="ai-embedding-attest-form"]');
			await form.get('textarea').setValue('Used since setup.');
			await form.get('[data-testid="checkbox"]').setValue(true);
			const submit = w.get('[data-testid="ai-embedding-attest-submit"]');
			expect(submit.attributes('disabled')).toBeUndefined();
			// Another admin selects a different model; the subscription delivers it.
			status.value = {
				...status.value!,
				configured: { ...status.value!.configured!, model: 'text-embedding-3-large' },
			};
			await flushPromises();
			expect(submit.attributes('disabled')).toBeDefined();
			expect((form.get('[data-testid="checkbox"]').element as HTMLInputElement).checked).toBe(
				false
			);
			// The width suggestion follows the new model (no known width for it).
			expect((form.findAll('input').at(-2)!.element as HTMLInputElement).value).toBe('');
			await form.trigger('submit');
			expect(spaces.attest).not.toHaveBeenCalled();
		});

		it('F1: editing the period takes the confirmation back too', async () => {
			const w = mountCard();
			const form = w.get('[data-testid="ai-embedding-attest-form"]');
			await form.get('textarea').setValue('Used since setup.');
			await form.get('[data-testid="checkbox"]').setValue(true);
			await form
				.findAll('input')
				.find((input) => input.attributes('type') !== 'checkbox')!
				.setValue('2026-09-30');
			expect(
				w.get('[data-testid="ai-embedding-attest-submit"]').attributes('disabled')
			).toBeDefined();
		});

		it('F2: rows without any vector still make a re-embed startable', () => {
			const counted = embeddingStatus({ isPaidEmbeddingAvailable: true });
			counted.coverage = {
				...counted.coverage!,
				knowledgeEntries: { active: 9, unknown: 0, inactive: 0, unembedded: 2 },
				semanticFiles: { active: 3, unknown: 0, inactive: 0, unembedded: 0 },
			};
			status.value = counted;
			const start = mountCard().get('[data-testid="ai-embedding-reembed-start"]');
			expect(start.text()).toBe('Re-embed up to 2 items');
			expect(start.attributes('disabled')).toBeUndefined();
		});

		it.each([
			['budget', 'Paused: the AI spend budget is used up for now.'],
			['provider_unavailable', 'Paused: the embedding provider could not be reached.'],
		] as const)('F3: a rebuild paused for %s resumes, paid and confirmed', async (reason, line) => {
			const paused = rebuild({ status: 'paused', pausedReason: reason });
			status.value = embeddingStatus({ staged: stagedSpace(), jobs: [paused] });
			const blocked = mountCard();
			expect(blocked.get('[data-testid="ai-embedding-rebuild-staged"]').text()).toContain(line);
			expect(
				blocked.get('[data-testid="ai-embedding-rebuild-resume"]').attributes('disabled')
			).toBeDefined();
			expect(blocked.get('[data-testid="ai-embedding-rebuild-blocker"]').text()).toContain(
				'spend admission'
			);

			status.value = { ...status.value!, isPaidEmbeddingAvailable: true };
			const w = mountCard();
			await w.get('[data-testid="ai-embedding-rebuild-resume"]').trigger('click');
			expect(spaces.resume).not.toHaveBeenCalled();
			await w.get('[data-testid="dialog-confirm"]').trigger('click');
			expect(spaces.resume).toHaveBeenCalledWith(paused);
		});

		it('F3: a free paused rebuild resumes at once', async () => {
			const paused = rebuild({
				status: 'paused',
				pausedReason: 'provider_unavailable',
				isPaid: false,
			});
			status.value = embeddingStatus({ staged: stagedSpace(), jobs: [paused] });
			await mountCard().get('[data-testid="ai-embedding-rebuild-resume"]').trigger('click');
			expect(spaces.resume).toHaveBeenCalledWith(paused);
		});

		it('F4: a public compatible endpoint is paid, refused without admission, confirmed with it', async () => {
			const base = embeddingStatus({
				active: space({ provider: 'openaiCompatible', model: 'nomic-embed-text', dimensions: 768 }),
			});
			const configured = {
				...base.configured!,
				provider: 'openaiCompatible' as const,
				endpoint: 'https://embeddings.example.com',
				model: 'nomic-embed-text',
				isLocal: false,
			};
			status.value = { ...base, configured };
			const blocked = mountCard();
			const form = blocked.get('[data-testid="ai-embedding-rebuild-form"]');
			expect(form.text()).toContain('Paid: every item is sent to the provider');
			expect(
				blocked.get('[data-testid="ai-embedding-rebuild-start"]').attributes('disabled')
			).toBeDefined();
			expect(blocked.text()).toContain('your embedding model is hosted'.replace('your', 'Your'));

			status.value = { ...base, configured, isPaidEmbeddingAvailable: true };
			const w = mountCard();
			await w.get('[data-testid="ai-embedding-reembed-start"]').trigger('click');
			expect(spaces.startReembed).not.toHaveBeenCalled();
			expect(w.get('[data-testid="dialog"]').text()).toContain('Up to 279 items');
		});

		it('F5: validate, activate and embed changes wait for admission and confirm paid work', async () => {
			const staged = stagedSpace();
			status.value = embeddingStatus({ staged, jobs: [rebuild({ status: 'completed' })] });
			const blocked = mountCard();
			for (const id of ['validate', 'activate', 'catch-up']) {
				expect(
					blocked.get(`[data-testid="ai-embedding-rebuild-${id}"]`).attributes('disabled')
				).toBeDefined();
			}
			expect(blocked.get('[data-testid="ai-embedding-rebuild-blocker"]').text()).toContain(
				'spend admission'
			);

			status.value = { ...status.value!, isPaidEmbeddingAvailable: true };
			const w = mountCard();
			await w.get('[data-testid="ai-embedding-rebuild-validate"]').trigger('click');
			expect(w.get('[data-testid="dialog"]').text()).toContain(
				'Validation embeds a few sample items'
			);
			await w.get('[data-testid="dialog-confirm"]').trigger('click');
			await flushPromises();
			expect(spaces.validate).toHaveBeenCalledTimes(1);
			await w.get('[data-testid="ai-embedding-rebuild-catch-up"]').trigger('click');
			expect(spaces.catchUp).not.toHaveBeenCalled();
			await w.get('[data-testid="dialog-confirm"]').trigger('click');
			expect(spaces.catchUp).toHaveBeenCalledTimes(1);
		});

		it('F5: a free staged rebuild validates and activates at once', async () => {
			status.value = embeddingStatus({
				staged: stagedSpace(),
				jobs: [rebuild({ status: 'completed', isPaid: false })],
			});
			const w = mountCard();
			await w.get('[data-testid="ai-embedding-rebuild-activate"]').trigger('click');
			expect(spaces.activate).toHaveBeenCalledTimes(1);
			expect(w.find('[data-testid="dialog"]').exists()).toBe(false);
		});

		it('F5: a paid paused re-embed waits for admission before it resumes', () => {
			status.value = embeddingStatus({ jobs: [job({ status: 'paused', pausedReason: 'budget' })] });
			const w = mountCard();
			expect(
				w.get('[data-testid="ai-embedding-reembed-resume"]').attributes('disabled')
			).toBeDefined();
			expect(w.get('[data-testid="ai-embedding-reembed-resume-blocker"]').text()).toContain(
				'spend admission'
			);
		});

		it('F6: no attestation form for a configured space in the secondary column', () => {
			status.value = embeddingStatus({ active: space({ slot: 'secondary' }) });
			const w = mountCard();
			expect(w.find('[data-testid="ai-embedding-attest-form"]').exists()).toBe(false);
			expect(w.get('[data-testid="ai-embedding-attest-blocked"]').text()).toContain(
				'Re-embed them instead.'
			);
		});

		it('F7: cancelling a rebuild is confirmed, and dismissing keeps it', async () => {
			status.value = embeddingStatus({ staged: stagedSpace(), jobs: [rebuild()] });
			const w = mountCard();
			await w.get('[data-testid="ai-embedding-rebuild-cancel"]').trigger('click');
			expect(w.get('[data-testid="dialog"]').text()).toContain("its run can't be resumed");
			await w.get('[data-testid="dialog-dismiss"]').trigger('click');
			expect(w.find('[data-testid="dialog"]').exists()).toBe(false);
			expect(spaces.cancelRebuild).not.toHaveBeenCalled();
			await w.get('[data-testid="ai-embedding-rebuild-cancel"]').trigger('click');
			await w.get('[data-testid="dialog-confirm"]').trigger('click');
			expect(spaces.cancelRebuild).toHaveBeenCalledTimes(1);
		});

		it('F9: rollback says what happens to newer items, local and hosted', async () => {
			const previous = space({
				_id: 'sp_prev' as never,
				model: 'text-embedding-ada-002',
				state: 'retired',
			});
			status.value = embeddingStatus({ rollbackTo: previous });
			const hosted = mountCard();
			await hosted.get('[data-testid="ai-embedding-rollback"] button').trigger('click');
			expect(hosted.get('[data-testid="dialog"]').text()).toContain('until you start a re-embed');

			const local = embeddingStatus({
				active: space({ provider: 'local', model: 'nomic-embed-text' }),
				rollbackTo: space({
					_id: 'sp_prev' as never,
					provider: 'local',
					model: 'mxbai-embed-large',
					state: 'retired',
				}),
			});
			local.configured = {
				...local.configured!,
				provider: 'local',
				model: 'nomic-embed-text',
				isLocal: true,
			};
			status.value = local;
			const w = mountCard();
			await w.get('[data-testid="ai-embedding-rollback"] button').trigger('click');
			expect(w.get('[data-testid="dialog"]').text()).toContain(
				're-embedded on their own, for free'
			);
		});
	});
});
