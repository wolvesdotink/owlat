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
import { ConvexError } from 'convex/values';
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

type Campaign =
	| {
			_id: string;
			name?: string;
			fromName?: string;
			fromEmail?: string;
			emailTemplateId?: string;
			emailTemplate?: { _id: string; name: string; subject: string; htmlContent?: string } | null;
	  }
	| undefined;

/** The persisted draft `?id=` resolves to; `undefined` stands for "still loading". */
const campaign = ref<Campaign>(undefined);
/** The campaign read's error: set after mount, the way a live subscription fails. */
let campaignError = ref<Error | null>(null);

const Blank = defineComponent({ render: () => h('div') });

const template = { _id: 'tpl1', name: 'Weekly digest email', subject: 'This week' };
const draft = {
	_id: 'cmp1',
	name: 'Weekly digest',
	fromName: 'Ada',
	fromEmail: 'ada@example.com',
	emailTemplateId: 'tpl1',
};

/** Visible stand-ins for the step components, so "which step is live" is assertable. */
const stepStubs = {
	CampaignsStepsSetupStep: defineComponent({
		emits: ['submit', 'cancel'],
		render: () => h('div', { class: 'step-setup' }),
	}),
	CampaignsStepsContentStep: defineComponent({
		emits: ['submit', 'back', 'compose'],
		render: () => h('div', { class: 'step-content' }),
	}),
	CampaignsStepsReviewStep: defineComponent({
		props: { data: Object, initialSchedule: Object },
		emits: ['back', 'editStep', 'complete', 'editEmail'],
		render: () => h('div', { class: 'step-review' }),
	}),
	UiStepIndicator: defineComponent({
		props: { getStepStatus: Function },
		render: () => h('div'),
	}),
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
	// A fresh ref per test: an earlier test's wizard must not see this one's failure.
	campaignError = ref<Error | null>(null);
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
			if (!wantsCampaign) return queryResult(undefined);
			return { ...queryResult(campaign.value), error: campaignError };
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
			{ path: '/dashboard/send/emails/:id/edit', component: Blank },
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
		campaign.value = { ...draft, emailTemplate: { ...template, htmlContent: '<p>Hi</p>' } };
		const { wrapper, router } = await mountWizard('/dashboard/campaigns/new?id=cmp1&step=review');

		expect(router.currentRoute.value.query['step']).toBe('review');
		expect(wrapper.find('.step-review').exists()).toBe(true);
	});

	it('does not count an attached but empty email as finished content (#1048)', async () => {
		campaign.value = { ...draft, emailTemplate: template };
		const { wrapper, router } = await mountWizard('/dashboard/campaigns/new?id=cmp1&step=review');

		expect(router.currentRoute.value.query['step']).toBe('content');
		expect(wrapper.find('.step-content').exists()).toBe(true);
	});

	describe('the email editor round trip (#1048)', () => {
		const reviewProps = (wrapper: Awaited<ReturnType<typeof mountWizard>>['wrapper']) =>
			wrapper.findComponent(stepStubs.CampaignsStepsReviewStep).props() as {
				data: Record<string, unknown>;
				initialSchedule: unknown;
			};

		it('opens a newly created email in the editor and comes back to Review intact', async () => {
			campaign.value = { _id: 'cmp1', name: 'Weekly digest', fromName: 'Ada' };
			const { wrapper, router } = await mountWizard(
				'/dashboard/campaigns/new?id=cmp1&step=content'
			);

			// ContentStep created and attached tpl1.
			campaign.value = { ...draft, emailTemplate: template };
			await wrapper.findComponent(stepStubs.CampaignsStepsContentStep).vm.$emit('compose', 'tpl1');
			await flushPromises();

			// Straight into the editor: the draft is persisted, so nothing asks first.
			expect(wrapper.find('.leave-dialog').exists()).toBe(false);
			const editor = router.currentRoute.value;
			expect(editor.path).toBe('/dashboard/send/emails/tpl1/edit');
			expect(editor.query['returnTo']).toBe('/dashboard/campaigns/new?id=cmp1&step=review');

			// The author designs and saves the body, then follows "Back to campaign".
			campaign.value = { ...draft, emailTemplate: { ...template, htmlContent: '<p>Hi</p>' } };
			await router.push(editor.query['returnTo'] as string);
			await flushPromises();

			expect(router.currentRoute.value.query).toEqual({ id: 'cmp1', step: 'review' });
			const { data, initialSchedule } = reviewProps(wrapper);
			expect(data).toMatchObject({
				campaignId: 'cmp1',
				campaignName: 'Weekly digest',
				fromName: 'Ada',
				fromEmail: 'ada@example.com',
				emailBodyHtml: '<p>Hi</p>',
			});
			expect(initialSchedule).toBeNull();
		});

		it('lets an existing but empty email reach Review only as a blocked send', async () => {
			campaign.value = { ...draft, emailTemplate: template };
			const { wrapper, router } = await mountWizard(
				'/dashboard/campaigns/new?id=cmp1&step=content'
			);

			await wrapper.findComponent(stepStubs.CampaignsStepsContentStep).vm.$emit('submit');
			await flushPromises();

			expect(router.currentRoute.value.query['step']).toBe('review');
			// `null` is the Review step's "Email body is empty" blocker.
			expect(reviewProps(wrapper).data['emailBodyHtml']).toBeNull();
			// …and the indicator does not tick Content off while the email is empty.
			const status = wrapper.findComponent(stepStubs.UiStepIndicator).props('getStepStatus') as (
				step: string
			) => string;
			expect(status('setup')).toBe('completed');
			expect(status('content')).toBe('upcoming');
		});

		it('keeps a pending schedule through Edit email', async () => {
			campaign.value = { ...draft, emailTemplate: { ...template, htmlContent: '<p>Hi</p>' } };
			const { wrapper, router } = await mountWizard('/dashboard/campaigns/new?id=cmp1&step=review');
			const status = wrapper.findComponent(stepStubs.UiStepIndicator).props('getStepStatus') as (
				step: string
			) => string;
			expect(status('content')).toBe('completed');

			const schedule = { date: '2026-10-05', time: '09:30', recipientTimezone: true };
			await wrapper
				.findComponent(stepStubs.CampaignsStepsReviewStep)
				.vm.$emit('editEmail', schedule);
			await flushPromises();

			expect(wrapper.find('.leave-dialog').exists()).toBe(false);
			expect(router.currentRoute.value.path).toBe('/dashboard/send/emails/tpl1/edit');

			await router.push(router.currentRoute.value.query['returnTo'] as string);
			await flushPromises();

			expect(router.currentRoute.value.query).toMatchObject({ id: 'cmp1', step: 'review' });
			expect(reviewProps(wrapper).initialSchedule).toEqual(schedule);
		});
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

	describe('when the draft read fails', () => {
		async function failRead(error: Error) {
			campaign.value = { _id: 'cmp1', name: 'Weekly digest' };
			// Setup, so dropping the id does not also move the step under test.
			const { router } = await mountWizard('/dashboard/campaigns/new?id=cmp1&step=setup');
			campaignError.value = error;
			await flushPromises();
			return router.currentRoute.value.query;
		}

		it.each([
			[
				'a function timeout',
				new Error('[CONVEX Q(campaigns/campaigns:getWithRelations)] Function execution timed out'),
			],
			['a subscription timeout', new Error('Convex query subscription timed out')],
			['a redacted server error', new Error('[Request ID: 1] Server Error')],
		])('keeps the draft id after %s (#818)', async (_label, error) => {
			const query = await failRead(error);

			expect(query['id']).toBe('cmp1');
		});

		it.each([
			['not found', new ConvexError({ code: 'not_found', message: 'Campaign not found' })],
			['forbidden', new ConvexError({ code: 'forbidden', message: 'Not your campaign' })],
			[
				'an argument validation failure',
				new Error('ArgumentValidationError: Value does not match validator. Path: .campaignId'),
			],
		])('drops a draft id the backend answered with %s', async (_label, error) => {
			const query = await failRead(error);

			expect(query['id']).toBeUndefined();
		});
	});
});
