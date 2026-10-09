// @vitest-environment happy-dom
/**
 * Answer mode's response plan on screen (plan §6):
 *   - `m/`: the brief's selected items show a stance picker (Accept / Decline /
 *     Defer / Ask for a decision, Answer / Decline / Defer for a file request),
 *     the draft's coverage marks an item "Addressed in draft" (never "Done")
 *     or "File missing", and the checkboxes are the plan's selection;
 *   - the file-claim banner names the draft's own words and picks a file;
 *   - `t/`: the composer-side panel lists the reply's items with the same
 *     picker, folds to "Your reply covers · N of M selected".
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { computed, defineComponent, h, ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import type { ResponseStance } from '@owlat/shared/threadBrief';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { briefView, item } from '~/utils/__tests__/threadBriefFixtures';
import type { ResponsePlan } from '~/composables/useResponsePlan';
import AnswerPlanBanner from '../AnswerPlanBanner.vue';
import AnswerTeamPlan from '../AnswerTeamPlan.vue';

const view = ref<unknown>(undefined);
vi.mock('~/composables/useThreadBrief', async () => {
	const { computed } = await import('vue');
	return {
		useThreadBrief: () => ({
			view,
			brief: computed(() => {
				const v = view.value as { mode?: string } | undefined;
				return v === undefined ? undefined : v?.mode === 'brief' ? v : null;
			}),
		}),
	};
});

beforeAll(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useFeatureFlag', () => ({ isEnabled: () => true }));
});

const { default: AnswerBriefCard } = await import('../AnswerBriefCard.vue');

const Plain = defineComponent({ setup: () => () => h('span') });
const ButtonStub = defineComponent({
	emits: ['click'],
	setup:
		(_p, { slots, emit }) =>
		() =>
			h('button', { onClick: () => emit('click') }, slots['default']?.()),
});

/** A plan as useResponsePlan hands it out, with the state a test sets. */
function fakePlan(
	over: { addressed?: string[]; fileMissing?: string[]; missingFiles?: string[] } = {}
) {
	const stances = ref(new Map<string, ResponseStance>());
	const setStance = vi.fn((id: string, stance: ResponseStance) => {
		stances.value = new Map(stances.value).set(id, stance);
	});
	const selected = ref<string[]>(['i_quote', 'i_contract']);
	return {
		view: {
			stanceOf: (id: string) => stances.value.get(id) ?? 'answer',
			setStance,
			addressed: computed(() => over.addressed ?? []),
			fileMissing: computed(() => new Set(over.fileMissing ?? [])),
		},
		selected,
		setSelected: vi.fn((ids: string[]) => (selected.value = ids)),
		missingFiles: ref(over.missingFiles ?? []),
		items: ref(over.items ?? []),
		statusNote: ref(undefined),
		checkCoverage: vi.fn(),
		recheck: vi.fn(),
	} as unknown as ResponsePlan & { view: { setStance: ReturnType<typeof vi.fn> } };
}

function mountCard(plan: ResponsePlan) {
	return mount(AnswerBriefCard, {
		props: {
			threadId: 't1',
			shown: 'summary',
			layout: 'split',
			messages: [],
			canAttach: true,
			plan,
		},
		global: {
			plugins: [createTestI18n()],
			components: { UiSkeleton: Plain, UiAvatar: Plain, PostboxOverflowMenu: Plain },
		},
	});
}

describe('the plan in the brief (m/)', () => {
	it('gives each selected item its stances, by kind of ask', async () => {
		view.value = briefView();
		const w = mountCard(fakePlan());
		await flushPromises();
		const pickers = w.findAll('[data-testid="brief-item-plan"]');
		expect(pickers).toHaveLength(2);
		expect(pickers[0]!.findAll('[role="radio"]').map((b) => b.text())).toEqual([
			'Accept',
			'Decline',
			'Defer',
			'Ask',
		]);
		expect(pickers[1]!.findAll('[role="radio"]').map((b) => b.text())).toEqual([
			'Answer',
			'Decline',
			'Defer',
		]);
		// The default answers without committing: no accept-type choice is made for it.
		expect(pickers[0]!.find('[aria-checked="true"]').exists()).toBe(false);
		expect(pickers[1]!.get('[aria-checked="true"]').attributes('data-stance')).toBe('answer');
	});

	it('hands a chosen stance to the plan', async () => {
		view.value = briefView();
		const plan = fakePlan();
		const w = mountCard(plan);
		await flushPromises();
		await w.get('[data-testid="brief-item-plan"] [data-stance="accept"]').trigger('click');
		expect(plan.view.setStance).toHaveBeenCalledWith('i_quote', 'accept');
		expect(
			w.get('[data-testid="brief-item-plan"] [aria-checked="true"]').attributes('data-stance')
		).toBe('accept');
	});

	it('marks what the draft addresses, and a file it claims and lacks', async () => {
		view.value = briefView();
		const w = mountCard(
			fakePlan({ addressed: ['i_quote', 'i_contract'], fileMissing: ['i_contract'] })
		);
		await flushPromises();
		const items = w.findAll('[data-testid="brief-item"]');
		expect(items[0]!.attributes('data-state')).toBe('addressedInDraft');
		expect(items[0]!.text()).toContain('Addressed in draft');
		expect(items[0]!.text()).not.toContain('Done');
		expect(items[1]!.get('[data-testid="brief-item-file-missing"]').text()).toBe('File missing');
	});

	it('is the plan’s selection: unchecking skips the item, which loses its picker', async () => {
		view.value = briefView();
		const plan = fakePlan();
		const w = mountCard(plan);
		await flushPromises();
		await w.findAll('[data-testid="brief-item-select"]')[1]!.trigger('change');
		expect(plan.setSelected).toHaveBeenCalledWith(['i_quote']);
		await flushPromises();
		expect(w.findAll('[data-testid="brief-item-plan"]')).toHaveLength(1);
	});
});

describe('AnswerPlanBanner', () => {
	it('names the draft’s claim and picks a file', async () => {
		const w = mount(AnswerPlanBanner, {
			props: { claims: ['I’ve attached the signed contract.'], canAttach: true },
			global: { plugins: [createTestI18n()], components: { UiButton: ButtonStub } },
		});
		expect(w.text()).toContain('One thing before sending.');
		expect(w.text()).toContain('The draft says “I’ve attached the signed contract.”');
		const input = w.get('input[type="file"]');
		const file = new File(['x'], 'contract.pdf');
		Object.defineProperty(input.element, 'files', { value: [file] });
		await input.trigger('change');
		expect(w.emitted('files')).toEqual([[[file]]]);
	});

	it('shows nothing without a claim, and no picker where nothing can be attached', () => {
		const none = mount(AnswerPlanBanner, {
			props: { claims: [], canAttach: true },
			global: { plugins: [createTestI18n()], components: { UiButton: ButtonStub } },
		});
		expect(none.find('[data-testid="answer-plan-file-claim"]').exists()).toBe(false);
		const locked = mount(AnswerPlanBanner, {
			props: { claims: ['Attached is the invoice.'], canAttach: false },
			global: { plugins: [createTestI18n()], components: { UiButton: ButtonStub } },
		});
		expect(locked.find('[data-testid="answer-plan-pick-file"]').exists()).toBe(false);
	});
});

describe('AnswerTeamPlan (t/)', () => {
	const items = [
		item({ id: 'i_quote', text: 'Refund €129.00', intent: 'decision', facets: ['payment'] }),
		item({ id: 'i_contract', text: 'Send the invoice', facets: ['file'] }),
	];

	it('lists the reply’s items with their stances and counts the selection', async () => {
		const plan = fakePlan({ missingFiles: ['Attached is the invoice.'], items });
		const w = mount(AnswerTeamPlan, {
			props: { plan, canAttach: true },
			global: {
				plugins: [createTestI18n()],
				components: { UiButton: ButtonStub, PostboxOverflowMenu: Plain },
				stubs: { Icon: true },
			},
		});
		expect(w.get('[data-testid="answer-team-plan-toggle"]').text()).toContain(
			'Your reply covers2 of 2 selected'
		);
		expect(w.findAll('[data-testid="brief-item-plan"]')).toHaveLength(2);
		expect(w.text()).toContain('One thing before sending.');
		await w.findAll('[data-testid="brief-item-select"]')[0]!.trigger('change');
		expect(plan.setSelected).toHaveBeenCalledWith(['i_contract']);
		await w.get('[data-testid="answer-team-plan-toggle"]').trigger('click');
		expect(w.find('[data-testid="brief-item-plan"]').exists()).toBe(false);
	});
});
