// @vitest-environment happy-dom
/**
 * The wizard's Review step — the one screen in the product where a click sends
 * mail to thousands of strangers (UX plan T3).
 *
 * Three behaviours are pinned here because all three are invisible until they
 * go wrong:
 *  - confirmation SCALED to blast radius: a twelve-person list sends on one
 *    click, a real audience has to be confirmed by name and by number first,
 *    and an unresolved count counts as "big";
 *  - "send now" is a schedule one undo window out, never `campaigns.sendNow`,
 *    so the undo toast has a real scheduled campaign to call back;
 *  - the step lands on the campaign's REPORT, immediately — no toast-then-timer
 *    hop to the campaigns list, where the send you just fired isn't.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent, h, ref } from 'vue';
import type { Id } from '@owlat/api/dataModel';

import ReviewStep from '../steps/ReviewStep.vue';
import { useCapacityRefusal } from '~/composables/useCapacityRefusal';
import { useModal } from '~/composables/useModal';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';
import { SEND_UNDO_WINDOW_MS } from '~/lib/campaignSend';

const CAMPAIGN_ID = 'campaign_1' as Id<'campaigns'>;

/** Every mutation the step can reach, keyed by its English operation label. */
const scheduleRuns: Record<string, unknown>[] = [];
const pushed: string[] = [];
const toasts: string[] = [];
const armed: { campaignId: string; campaignName: string; sendAt: number }[] = [];

// A confirmation dialog that renders its copy and can be confirmed — the point
// of the threshold is WHICH numbers appear in it, so a bare `stubs: true`
// would audit nothing.
const confirmationDialogStub = defineComponent({
	props: {
		open: Boolean,
		title: String,
		description: String,
		confirmText: String,
		cancelText: String,
	},
	emits: ['update:open', 'confirm'],
	setup(props, { emit }) {
		return () =>
			props.open
				? h('div', { class: 'confirm-dialog' }, [
						h('p', { class: 'confirm-title' }, props.title),
						h('p', { class: 'confirm-description' }, props.description),
						h(
							'button',
							{ class: 'confirm-cancel', onClick: () => emit('update:open', false) },
							props.cancelText
						),
						h(
							'button',
							{ class: 'confirm-accept', onClick: () => emit('confirm') },
							props.confirmText
						),
					])
				: null;
	},
});

const passthroughStub = defineComponent({
	setup(_props, { slots }) {
		return () => h('div', slots.default?.());
	},
});

beforeEach(() => {
	scheduleRuns.length = 0;
	pushed.length = 0;
	toasts.length = 0;
	armed.length = 0;
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-03-10T09:00:00'));

	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useRouter', () => ({ push: (to: string) => pushed.push(to) }));
	vi.stubGlobal('useToast', () => ({ showToast: (message: string) => toasts.push(message) }));
	vi.stubGlobal('useConvex', () => null);
	// The real capacity-refusal claim: it is pure ref state, and stubbing it out
	// would quietly disable the one error path this screen renders itself.
	vi.stubGlobal('useCapacityRefusal', useCapacityRefusal);
	vi.stubGlobal('useModal', useModal);
	// The domain-verification and readiness queries: nothing blocks the send.
	vi.stubGlobal('useOrganizationQuery', () => ({ data: ref(undefined) }));
	vi.stubGlobal('useCampaignUndoSend', () => ({
		arm: (args: { campaignId: string; campaignName: string; sendAt: number }) => armed.push(args),
	}));
	vi.stubGlobal(
		'useBackendOperation',
		(_reference: unknown, options: { label: string | (() => string) }) => ({
			run: async (args: Record<string, unknown>) => {
				const label = typeof options.label === 'function' ? options.label() : options.label;
				if (label === 'Schedule campaign') scheduleRuns.push(args);
				return { ok: true, result: CAMPAIGN_ID };
			},
		})
	);
});

afterEach(() => {
	vi.useRealTimers();
	// Deliberately NOT `vi.unstubAllGlobals()`: the shared setup file installs
	// Vue's reactivity API (`ref`, `computed`, …) as globals for exactly these
	// SFC mounts, and clearing every stub takes those with it. Each case's
	// globals are replaced by the next `beforeEach`.
});

function mountStep(overrides: Partial<Record<string, unknown>> = {}) {
	return mount(ReviewStep, {
		props: {
			data: {
				campaignId: CAMPAIGN_ID,
				campaignName: 'Weekly digest #34',
				fromName: 'Ada',
				fromEmail: 'ada@example.com',
				replyTo: '',
				audienceDisplayText: 'Topic: Product news',
				audienceCount: 12,
				campaignSubject: 'What shipped this week',
				selectedTemplate: null,
				abTestEnabled: false,
				abTestType: 'subject',
				abVariantBSubject: '',
				abVariantBTemplateId: null,
				abSplitPercentage: 10,
				abWinnerCriteria: 'open_rate',
				abTestDuration: 4,
				templates: [],
				...overrides,
			},
		},
		global: {
			plugins: [createTestI18n()],
			stubs: {
				UiConfirmationDialog: confirmationDialogStub,
				UiErrorAlert: true,
				UiIconBox: true,
				CampaignsCapacitySchedulePanel: true,
				CampaignsSendReadinessNote: true,
				CampaignsTestEmailModal: true,
				Icon: true,
				I18nT: passthroughStub,
			},
		},
	});
}

/** The step's primary action, by its label rather than by position. */
async function clickSend(wrapper: ReturnType<typeof mountStep>) {
	const button = wrapper
		.findAll('button')
		.find(
			(candidate) =>
				candidate.text() === 'Send Campaign' || candidate.text() === 'Schedule Campaign'
		);
	expect(button).toBeDefined();
	await button!.trigger('click');
	await flushPromises();
}

describe('ReviewStep send confirmation threshold', () => {
	it('sends a small audience on one click, holding it one undo window out', async () => {
		const wrapper = mountStep({ audienceCount: 12 });

		await clickSend(wrapper);

		expect(wrapper.find('.confirm-dialog').exists()).toBe(false);
		expect(scheduleRuns).toEqual([
			{
				campaignId: CAMPAIGN_ID,
				scheduledAt: Date.now() + SEND_UNDO_WINDOW_MS,
				useRecipientTimezone: false,
			},
		]);
		expect(armed).toEqual([
			{
				campaignId: CAMPAIGN_ID,
				campaignName: 'Weekly digest #34',
				sendAt: Date.now() + SEND_UNDO_WINDOW_MS,
			},
		]);
	});

	it('asks first for an audience at the threshold, naming the campaign and the count', async () => {
		const wrapper = mountStep({ audienceCount: 12408 });

		await clickSend(wrapper);

		// Nothing has been scheduled: the dialog is the whole point.
		expect(scheduleRuns).toEqual([]);
		const dialog = wrapper.find('.confirm-dialog');
		expect(dialog.exists()).toBe(true);
		expect(dialog.find('.confirm-title').text()).toBe('Send to 12,408 recipients?');
		expect(dialog.find('.confirm-description').text()).toContain('Weekly digest #34');
		expectFullyLocalized(wrapper);

		await dialog.find('.confirm-accept').trigger('click');
		await flushPromises();

		expect(scheduleRuns).toHaveLength(1);
		expect(wrapper.find('.confirm-dialog').exists()).toBe(false);
	});

	it('sends nothing when the confirmation is dismissed', async () => {
		const wrapper = mountStep({ audienceCount: 50 });

		await clickSend(wrapper);
		expect(wrapper.find('.confirm-dialog').exists()).toBe(true);

		await wrapper.find('.confirm-cancel').trigger('click');
		await flushPromises();

		expect(scheduleRuns).toEqual([]);
		expect(armed).toEqual([]);
		expect(pushed).toEqual([]);
	});

	it('confirms when the audience count is unknown', async () => {
		const wrapper = mountStep({ audienceCount: undefined });

		await clickSend(wrapper);

		expect(scheduleRuns).toEqual([]);
		expect(wrapper.find('.confirm-dialog').exists()).toBe(true);
	});

	it('does not interrupt a scheduled send — a date is its own undo', async () => {
		const wrapper = mountStep({ audienceCount: 12408 });

		await wrapper.findAll('input[type="radio"]')[1]!.setValue();
		await wrapper.find('input[type="date"]').setValue('2026-03-11');
		await wrapper.find('input[type="time"]').setValue('09:30');

		await clickSend(wrapper);

		expect(wrapper.find('.confirm-dialog').exists()).toBe(false);
		expect(scheduleRuns).toHaveLength(1);
		expect(scheduleRuns[0]!['scheduledAt']).toBe(new Date('2026-03-11T09:30:00').getTime());
		// A future schedule is announced; an immediate send is not, because the
		// undo toast is already saying it.
		expect(toasts).toEqual(['Campaign scheduled successfully!']);
		expect(armed).toEqual([]);
	});
});

describe('ReviewStep post-send navigation', () => {
	it('lands on the campaign report, with no timer in between', async () => {
		const wrapper = mountStep({ audienceCount: 12 });

		await clickSend(wrapper);

		expect(pushed).toEqual([`/dashboard/campaigns/${CAMPAIGN_ID}/report`]);
		expect(wrapper.emitted('complete')).toHaveLength(1);
		// The old flow waited 1.5s before moving; nothing may depend on a timer.
		vi.advanceTimersByTime(5000);
		expect(pushed).toEqual([`/dashboard/campaigns/${CAMPAIGN_ID}/report`]);
	});

	it('stays put when the schedule mutation fails', async () => {
		vi.stubGlobal('useBackendOperation', () => ({ run: async () => ({ ok: false }) }));
		const wrapper = mountStep({ audienceCount: 12 });

		await clickSend(wrapper);

		expect(pushed).toEqual([]);
		expect(armed).toEqual([]);
		expect(wrapper.emitted('complete')).toBeUndefined();
	});
});

describe('ReviewStep layout', () => {
	it('puts the test send above the send controls', () => {
		const wrapper = mountStep();
		const headings = wrapper.findAll('h3').map((heading) => heading.text());

		expect(headings.indexOf('Send Test Email')).toBeGreaterThanOrEqual(0);
		expect(headings.indexOf('Send Test Email')).toBeLessThan(headings.indexOf('When to Send'));
	});
});
