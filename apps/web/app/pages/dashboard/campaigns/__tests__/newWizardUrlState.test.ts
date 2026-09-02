// @vitest-environment happy-dom
/**
 * THE CAMPAIGN WIZARD'S STATE IS THE URL.
 *
 * Step and draft id both live in the query, so Back means "previous step", a
 * refresh reopens the same screen with the same draft, and the link is
 * shareable. The page is mounted against a REAL vue-router (memory history):
 * the redirects under test are navigations, and a spy on `push` would prove
 * nothing about where the user ends up.
 *
 * The step components are left unresolved on purpose — this asserts the page's
 * own wiring (which step is live, what the URL says, whether leaving is
 * guarded), and each step carries its own suite.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import {
	createRouter,
	createMemoryHistory,
	RouterView,
	useRoute as routerUseRoute,
	useRouter as routerUseRouter,
} from 'vue-router';
import { installNuxtStubs, paginatedResult, queryResult } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { useUnsavedChanges } from '~/composables/useUnsavedChanges';
import { useWizard } from '~/composables/useWizard';
import CampaignsNew from '../new.vue';

type Campaign = { _id: string; name?: string; emailTemplateId?: string } | undefined;

/** The persisted draft `?id=` resolves to; `undefined` stands for "still loading". */
const campaign = ref<Campaign>(undefined);

const Blank = defineComponent({ render: () => h('div') });

/** Visible stand-ins for the step components, so "which step is live" is assertable. */
const stepStubs = {
	CampaignsStepsSetupStep: defineComponent({
		emits: ['submit', 'cancel'],
		render: () => h('div', { class: 'step-setup' }),
	}),
	CampaignsStepsContentStep: defineComponent({
		emits: ['submit', 'back'],
		render: () => h('div', { class: 'step-content' }),
	}),
	CampaignsStepsReviewStep: defineComponent({
		emits: ['back', 'editStep', 'complete'],
		render: () => h('div', { class: 'step-review' }),
	}),
	UiStepIndicator: Blank,
	UiConfirmationDialog: defineComponent({
		props: { open: Boolean },
		emits: ['confirm', 'update:open'],
		render(this: { open: boolean }) {
			return this.open ? h('div', { class: 'leave-dialog' }) : null;
		},
	}),
	Icon: Blank,
};

beforeEach(() => {
	campaign.value = undefined;
	installNuxtStubs({
		...i18nStubs,
		// The page's own router, not a spy: the assertions are about the URL.
		useRoute: routerUseRoute,
		useRouter: routerUseRouter,
		useWizard,
		useUnsavedChanges,
		useConvexQuery: (_query: unknown, args: unknown) => {
			// Only the campaign query is arg-driven here; the recipient count and
			// the rest can answer empty.
			const resolved = typeof args === 'function' ? (args as () => unknown)() : args;
			const wantsCampaign =
				typeof resolved === 'object' && resolved !== null && 'campaignId' in resolved;
			return wantsCampaign ? queryResult(campaign.value) : queryResult(undefined);
		},
		useOrganizationQuery: () => queryResult(undefined),
		usePaginatedQuery: () => paginatedResult([]),
	});
});

/**
 * Mounted THROUGH a `<RouterView>`, not directly: the wizard's leave guard is
 * an `onBeforeRouteLeave`, which vue-router only registers for a component the
 * router itself rendered.
 */
async function mountWizard(url: string) {
	const router = createRouter({
		history: createMemoryHistory(),
		routes: [
			{ path: '/dashboard/campaigns', component: Blank },
			{ path: '/dashboard/campaigns/new', component: CampaignsNew },
		],
	});
	await router.push('/dashboard/campaigns');
	await router.push(url);
	await router.isReady();

	const Host = defineComponent({ render: () => h(RouterView) });
	const wrapper = mount(Host, {
		global: { plugins: [router, createTestI18n()], stubs: stepStubs },
	});
	await flushPromises();

	return { wrapper, router };
}

describe('campaign wizard URL state', () => {
	it('names the opening step in the query', async () => {
		const { wrapper, router } = await mountWizard('/dashboard/campaigns/new');

		expect(router.currentRoute.value.query['step']).toBe('setup');
		expect(wrapper.find('.step-setup').exists()).toBe(true);
	});

	it('reopens the step and the draft the URL carries', async () => {
		campaign.value = { _id: 'cmp1', name: 'Weekly digest' };
		const { wrapper, router } = await mountWizard('/dashboard/campaigns/new?id=cmp1&step=content');

		expect(router.currentRoute.value.query).toEqual({ id: 'cmp1', step: 'content' });
		expect(wrapper.find('.step-content').exists()).toBe(true);
	});

	it('sends a step the draft has not reached back to the first incomplete one', async () => {
		campaign.value = { _id: 'cmp1', name: 'Weekly digest' };
		const { wrapper, router } = await mountWizard('/dashboard/campaigns/new?id=cmp1&step=review');

		// Nothing has been attached on Content yet, so Review is not reachable.
		expect(router.currentRoute.value.query['step']).toBe('content');
		expect(wrapper.find('.step-content').exists()).toBe(true);
	});

	it('honours Review once the campaign carries its email', async () => {
		campaign.value = { _id: 'cmp1', name: 'Weekly digest', emailTemplateId: 'tpl1' };
		const { wrapper, router } = await mountWizard('/dashboard/campaigns/new?id=cmp1&step=review');

		expect(router.currentRoute.value.query['step']).toBe('review');
		expect(wrapper.find('.step-review').exists()).toBe(true);
	});

	it('drops a step that no draft backs at all', async () => {
		const { router } = await mountWizard('/dashboard/campaigns/new?step=review');

		expect(router.currentRoute.value.query['step']).toBe('setup');
	});

	it('keeps the draft id when the step advances', async () => {
		campaign.value = { _id: 'cmp1', name: 'Weekly digest' };
		const { wrapper, router } = await mountWizard('/dashboard/campaigns/new?id=cmp1&step=setup');

		await wrapper.findComponent(stepStubs.CampaignsStepsSetupStep).vm.$emit('submit', 'cmp1');
		await flushPromises();

		expect(router.currentRoute.value.query).toEqual({ id: 'cmp1', step: 'content' });
	});

	describe('leaving mid-wizard', () => {
		it('asks before discarding a draft instead of navigating away', async () => {
			campaign.value = { _id: 'cmp1', name: 'Weekly digest' };
			const { wrapper, router } = await mountWizard('/dashboard/campaigns/new?id=cmp1&step=setup');

			await wrapper.find('button[aria-label]').trigger('click');
			await flushPromises();

			expect(wrapper.find('.leave-dialog').exists()).toBe(true);
			expect(router.currentRoute.value.path).toBe('/dashboard/campaigns/new');
		});

		it('leaves once the prompt is confirmed', async () => {
			campaign.value = { _id: 'cmp1', name: 'Weekly digest' };
			const { wrapper, router } = await mountWizard('/dashboard/campaigns/new?id=cmp1&step=setup');

			await wrapper.find('button[aria-label]').trigger('click');
			await flushPromises();
			await wrapper.findComponent(stepStubs.UiConfirmationDialog).vm.$emit('confirm');
			await flushPromises();

			expect(router.currentRoute.value.path).toBe('/dashboard/campaigns');
		});

		it('does not ask when there is nothing to lose', async () => {
			const { wrapper, router } = await mountWizard('/dashboard/campaigns/new');

			await wrapper.find('button[aria-label]').trigger('click');
			await flushPromises();

			expect(wrapper.find('.leave-dialog').exists()).toBe(false);
			expect(router.currentRoute.value.path).toBe('/dashboard/campaigns');
		});
	});
});
