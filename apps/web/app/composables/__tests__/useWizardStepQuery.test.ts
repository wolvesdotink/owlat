// @vitest-environment happy-dom
/**
 * THE STEP LIVES IN THE URL, SO THE BACK BUTTON CANNOT LIE.
 *
 * These run against a REAL vue-router (memory history) rather than a stubbed
 * `push`/`replace`: every property under test — that Back lands on the previous
 * step instead of leaving the wizard, that a correction does not leave a bogus
 * entry behind, that a reload of the same URL reopens the same step — is a
 * property of the history stack, and a spy on `push` proves none of them.
 *
 * `useWizard` reaches for the Nuxt auto-imports `useRoute`/`useRouter`; here
 * they are vue-router's own, so the composable talks to the mounted router.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import {
	createRouter,
	createMemoryHistory,
	useRoute as routerUseRoute,
	useRouter as routerUseRouter,
	type Router,
} from 'vue-router';
import { useWizard, type UseWizardOptions, type WizardStep } from '../useWizard';

beforeAll(() => {
	vi.stubGlobal('useRoute', routerUseRoute);
	vi.stubGlobal('useRouter', routerUseRouter);
});

type Step = 'setup' | 'content' | 'review';

const steps: WizardStep<Step>[] = [
	{ id: 'setup', label: 'Setup', number: 1 },
	{ id: 'content', label: 'Content', number: 2 },
	{ id: 'review', label: 'Review', number: 3 },
];

const Blank = defineComponent({ render: () => h('div') });

async function mountWizard(options: UseWizardOptions<Step>, initialUrl = '/wizard') {
	const router = createRouter({
		history: createMemoryHistory(),
		routes: [
			{ path: '/wizard', component: Blank },
			{ path: '/campaigns', component: Blank },
		],
	});
	// Arrive from somewhere: the entry BEFORE the wizard is what proves a URL
	// correction replaced its entry instead of pushing a second one.
	await router.push('/campaigns');
	await router.push(initialUrl);
	await router.isReady();

	let wizard!: ReturnType<typeof useWizard<Step>>;
	const Host = defineComponent({
		setup() {
			wizard = useWizard(steps, options);
			return () => h('div', wizard.currentStep.value);
		},
	});

	const wrapper = mount(Host, { global: { plugins: [router] } });
	await flushPromises();

	return { wizard, router: router as Router, wrapper };
}

/** Steps 1..`completed` are done; anything beyond is not. */
const completeThrough = (completed: number) => (stepId: Step) =>
	steps.findIndex((s) => s.id === stepId) < completed;

describe('useWizard step ↔ URL sync', () => {
	it('writes the opening step into the query without adding a history entry', async () => {
		const { wizard, router } = await mountWizard({ syncQuery: true });

		expect(wizard.currentStep.value).toBe('setup');
		expect(router.currentRoute.value.query['step']).toBe('setup');

		// The correction replaced the entry it arrived on, so Back leaves the
		// wizard rather than bouncing between two spellings of step one.
		router.back();
		await flushPromises();
		expect(router.currentRoute.value.path).toBe('/campaigns');
	});

	it('pushes one history entry per step, so Back is "previous step"', async () => {
		const { wizard, router } = await mountWizard({ syncQuery: true });

		wizard.goToNext();
		await flushPromises();
		expect(router.currentRoute.value.query['step']).toBe('content');
		expect(wizard.currentStep.value).toBe('content');

		wizard.goToNext();
		await flushPromises();
		expect(wizard.currentStep.value).toBe('review');

		router.back();
		await flushPromises();
		expect(router.currentRoute.value.query['step']).toBe('content');
		expect(wizard.currentStep.value).toBe('content');

		router.back();
		await flushPromises();
		expect(wizard.currentStep.value).toBe('setup');
		expect(router.currentRoute.value.path).toBe('/wizard');

		// Only then does Back leave the wizard.
		router.back();
		await flushPromises();
		expect(router.currentRoute.value.path).toBe('/campaigns');
	});

	it('reopens the step the URL names (a refresh resumes where the user was)', async () => {
		const { wizard, router } = await mountWizard(
			{ syncQuery: true, isStepComplete: completeThrough(2) },
			'/wizard?step=review'
		);

		expect(wizard.currentStep.value).toBe('review');
		expect(router.currentRoute.value.query['step']).toBe('review');
	});

	it('keeps the rest of the query (the draft id survives a step change)', async () => {
		const { wizard, router } = await mountWizard({ syncQuery: true }, '/wizard?id=cmp_84h2');

		wizard.goToNext();
		await flushPromises();

		expect(router.currentRoute.value.query).toEqual({ id: 'cmp_84h2', step: 'content' });
	});

	it('names the query parameter when asked', async () => {
		const { router } = await mountWizard({ syncQuery: 'wizardStep' });
		expect(router.currentRoute.value.query['wizardStep']).toBe('setup');
	});

	describe('deep-link validation', () => {
		it('sends an unknown step to the first incomplete one', async () => {
			const { wizard, router } = await mountWizard(
				{ syncQuery: true, isStepComplete: completeThrough(1) },
				'/wizard?step=nonsense'
			);

			expect(wizard.currentStep.value).toBe('content');
			expect(router.currentRoute.value.query['step']).toBe('content');
		});

		it('sends a not-yet-reachable step back to the first incomplete one', async () => {
			const { wizard, router } = await mountWizard(
				{ syncQuery: true, isStepComplete: completeThrough(0) },
				'/wizard?step=review'
			);

			expect(wizard.currentStep.value).toBe('setup');
			expect(router.currentRoute.value.query['step']).toBe('setup');
		});

		it('corrects in place, leaving no entry that Back would return to', async () => {
			const { router } = await mountWizard(
				{ syncQuery: true, isStepComplete: completeThrough(0) },
				'/wizard?step=review'
			);

			router.back();
			await flushPromises();

			// Back is not a trip through the rejected link.
			expect(router.currentRoute.value.path).toBe('/campaigns');
		});

		it('resumes at the first incomplete step when the URL names none', async () => {
			const { wizard } = await mountWizard({
				syncQuery: true,
				isStepComplete: completeThrough(1),
			});

			expect(wizard.currentStep.value).toBe('content');
		});

		it('leaves the URL alone until the state it validates against has loaded', async () => {
			const loaded = ref(false);
			const { wizard, router } = await mountWizard(
				{
					syncQuery: true,
					// Nothing is complete while the draft is still in flight.
					isStepComplete: (stepId) => loaded.value && completeThrough(2)(stepId),
					isReady: () => loaded.value,
				},
				'/wizard?step=review'
			);

			// A clamp here would have rewritten a perfectly good link to step 1.
			expect(wizard.currentStep.value).toBe('review');
			expect(router.currentRoute.value.query['step']).toBe('review');

			loaded.value = true;
			await flushPromises();

			expect(wizard.currentStep.value).toBe('review');
			expect(router.currentRoute.value.query['step']).toBe('review');
		});

		it('clamps once the loaded state proves the step was premature', async () => {
			const loaded = ref(false);
			const { wizard, router } = await mountWizard(
				{
					syncQuery: true,
					isStepComplete: (stepId) => loaded.value && completeThrough(1)(stepId),
					isReady: () => loaded.value,
				},
				'/wizard?step=review'
			);

			loaded.value = true;
			await flushPromises();

			expect(wizard.currentStep.value).toBe('content');
			expect(router.currentRoute.value.query['step']).toBe('content');
		});

		it('never bounces a step the user was just sent to by Next', async () => {
			// The server has not confirmed step 2's work yet — the completion flag
			// still reads false the moment "Next" fires.
			const { wizard, router } = await mountWizard(
				{ syncQuery: true, isStepComplete: completeThrough(1) },
				'/wizard?step=content'
			);

			wizard.goToNext();
			await flushPromises();

			expect(wizard.currentStep.value).toBe('review');
			expect(router.currentRoute.value.query['step']).toBe('review');
		});

		it('lets the user step back to an already completed step', async () => {
			const { wizard, router } = await mountWizard(
				{ syncQuery: true, isStepComplete: completeThrough(2) },
				'/wizard?step=review'
			);

			wizard.goToStep('setup');
			await flushPromises();

			expect(wizard.currentStep.value).toBe('setup');
			expect(router.currentRoute.value.query['step']).toBe('setup');
		});
	});

	it('leaves the URL untouched when the wizard opts out of syncing', async () => {
		const { wizard, router } = await mountWizard({});

		wizard.goToNext();
		await flushPromises();

		expect(wizard.currentStep.value).toBe('content');
		expect(router.currentRoute.value.query).toEqual({});
	});
});
