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

/**
 * The pre-send checks' state, replaced per case. The checks themselves are
 * pinned in `lib/presendChecks/__tests__`; here only what the step does with
 * them matters: the panel shows, "Show me" opens the editor on the Block, and
 * unreviewed warnings turn the send button into "Send anyway".
 */
const presend = {
	checks: ref<unknown[]>([]),
	summary: ref({ warnings: 0, blocking: 0, pending: 0, signature: '' }),
	isChecking: ref(false),
	run: vi.fn(),
};

const presendPanelStub = defineComponent({
	props: { acknowledged: Boolean },
	emits: ['acknowledge', 'showBlock', 'retry'],
	setup(props, { emit }) {
		return () =>
			h('div', { class: 'presend-panel', 'data-acknowledged': String(props.acknowledged) }, [
				h('button', { class: 'presend-ack', onClick: () => emit('acknowledge') }, 'ack'),
				h('button', { class: 'presend-show', onClick: () => emit('showBlock', 'block-7') }, 'show'),
			]);
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
	presend.checks.value = [];
	presend.summary.value = { warnings: 0, blocking: 0, pending: 0, signature: '' };
	presend.run.mockReset();
	vi.stubGlobal('usePresendChecks', () => presend);
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

function mountStep(
	overrides: Partial<Record<string, unknown>> = {},
	extraProps: Record<string, unknown> = {}
) {
	return mount(ReviewStep, {
		props: {
			...extraProps,
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
				CampaignsEmailBodyPreview: true,
				CampaignsPresendChecksPanel: presendPanelStub,
				CampaignsSendTimingOptions: true,
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
				candidate.text() === 'Send campaign' || candidate.text() === 'Schedule campaign'
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

	it('confirms a lower-bound count however small, and names it as "at least" (#916)', async () => {
		// A first background count still running: 24 is what it has seen so far,
		// not the audience size.
		const wrapper = mountStep({ audienceCount: 24, audienceCountAtLeast: true });
		// The capacity note plans against the size, so it gets no number at all.
		const note = wrapper.find('campaigns-send-readiness-note-stub');
		expect(note.exists()).toBe(true);
		expect(note.attributes('audience-size')).toBeUndefined();

		await clickSend(wrapper);

		expect(scheduleRuns).toEqual([]);
		const dialog = wrapper.find('.confirm-dialog');
		expect(dialog.exists()).toBe(true);
		expect(dialog.find('.confirm-title').text()).toBe('Send to 24+ recipients?');
	});

	it('hands an exact count to the capacity note', () => {
		const wrapper = mountStep({ audienceCount: 12408 });
		expect(wrapper.find('campaigns-send-readiness-note-stub').attributes('audience-size')).toBe(
			'12408'
		);
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
		// One instant for everyone: no local-time hour, optimization off.
		expect(scheduleRuns[0]).toMatchObject({
			useRecipientTimezone: false,
			sendTimeOptimization: null,
		});
	});

	it('schedules "Optimized per contact" with its window, comparison group and start time', async () => {
		const wrapper = mountStep(
			{ audienceCount: 12408 },
			{
				initialSchedule: {
					date: '2026-03-11',
					time: '09:30',
					recipientTimezone: false,
					optimization: { windowHours: 12, holdoutPercent: 5 },
				},
			}
		);
		expect(wrapper.find('campaigns-send-timing-options-stub').attributes('start-at')).toBe(
			String(new Date('2026-03-11T09:30:00').getTime())
		);

		await clickSend(wrapper);

		expect(scheduleRuns).toHaveLength(1);
		expect(scheduleRuns[0]).toMatchObject({
			scheduledAt: new Date('2026-03-11T09:30:00').getTime(),
			useRecipientTimezone: false,
			scheduledHour: 9,
			scheduledMinute: 30,
			sendTimeOptimization: { windowHours: 12, holdoutPercent: 5 },
		});
		expect(toasts).toEqual(['Campaign scheduled. Each contact gets it at their usual hour.']);
	});

	it('offers optimization only outside an A/B test', () => {
		const wrapper = mountStep(
			{ abTestEnabled: true },
			{
				initialSchedule: { date: '2026-03-11', time: '09:30', recipientTimezone: false },
			}
		);
		expect(wrapper.find('campaigns-send-timing-options-stub').attributes('is-ab-test')).toBe(
			'true'
		);
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

		expect(headings.indexOf('Send test email')).toBeGreaterThanOrEqual(0);
		expect(headings.indexOf('Send test email')).toBeLessThan(headings.indexOf('When to send'));
	});
});

describe('ReviewStep email body (#1048)', () => {
	const template = { _id: 'tpl_1' as Id<'emailTemplates'>, name: 'Digest', subject: 'Hi' };

	function sendButton(wrapper: ReturnType<typeof mountStep>) {
		return wrapper.findAll('button').find((candidate) => candidate.text() === 'Send campaign')!;
	}

	it('blocks the send while the email body is empty, through the send-blocked path', async () => {
		const wrapper = mountStep({ selectedTemplate: template, emailBodyHtml: null });

		expect(wrapper.text()).toContain('Email body is empty. Design the email before sending it.');
		expect(wrapper.find('[data-testid="review-empty-body"]').exists()).toBe(true);
		expect(wrapper.find('campaigns-email-body-preview-stub').exists()).toBe(false);
		expect(sendButton(wrapper).attributes('disabled')).toBeDefined();

		await clickSend(wrapper);
		expect(scheduleRuns).toEqual([]);
	});

	it('previews a real body and lets the send through', async () => {
		const wrapper = mountStep({
			selectedTemplate: template,
			emailBodyHtml: '<p>What shipped</p>',
		});

		const preview = wrapper.find('campaigns-email-body-preview-stub');
		expect(preview.exists()).toBe(true);
		expect(preview.attributes('html')).toBe('<p>What shipped</p>');
		expect(wrapper.text()).not.toContain('Email body is empty');
		// The old "edit it later" line is gone: the edit is right here.
		expect(wrapper.text()).not.toContain('after the campaign is created');
		expectFullyLocalized(wrapper);

		await clickSend(wrapper);
		expect(scheduleRuns).toHaveLength(1);
	});

	it('does not block on a body it has not loaded yet', () => {
		const wrapper = mountStep({ selectedTemplate: template });
		expect(wrapper.text()).not.toContain('Email body is empty');
		expect(sendButton(wrapper).attributes('disabled')).toBeUndefined();
	});

	it('hands a pending schedule to Edit email, and restores one it is given back', async () => {
		const wrapper = mountStep({ selectedTemplate: template, emailBodyHtml: null });

		await wrapper.findAll('input[type="radio"]')[1]!.setValue();
		await wrapper.find('input[type="date"]').setValue('2026-03-11');
		await wrapper.find('input[type="time"]').setValue('09:30');
		await wrapper.find('[data-testid="review-edit-email"]').trigger('click');

		const schedule = { date: '2026-03-11', time: '09:30', recipientTimezone: false };
		expect(wrapper.emitted('editEmail')).toEqual([[schedule]]);

		const restored = mountStep(
			{ selectedTemplate: template, emailBodyHtml: '<p>Hi</p>' },
			{ initialSchedule: schedule }
		);
		expect((restored.findAll('input[type="radio"]')[1]!.element as HTMLInputElement).checked).toBe(
			true
		);
		expect((restored.find('input[type="date"]').element as HTMLInputElement).value).toBe(
			'2026-03-11'
		);
		expect((restored.find('input[type="time"]').element as HTMLInputElement).value).toBe('09:30');
	});

	it('sends no schedule along for an immediate send', async () => {
		const wrapper = mountStep({ selectedTemplate: template, emailBodyHtml: '<p>Hi</p>' });
		await wrapper.find('[data-testid="review-edit-email"]').trigger('click');
		expect(wrapper.emitted('editEmail')).toEqual([[null]]);
	});
});

describe('ReviewStep pre-send checks', () => {
	const template = { _id: 'tpl_1' as Id<'emailTemplates'>, name: 'Digest', subject: 'Hi' };

	function primaryButton(wrapper: ReturnType<typeof mountStep>) {
		return wrapper.findAll('button').at(-1)!;
	}

	it('runs the checks once the email body is known, and not for an empty one', () => {
		mountStep({ selectedTemplate: template, emailBodyHtml: null });
		expect(presend.run).not.toHaveBeenCalled();

		const wrapper = mountStep({ selectedTemplate: template, emailBodyHtml: '<p>Hi</p>' });
		expect(wrapper.find('.presend-panel').exists()).toBe(true);
		expect(presend.run).toHaveBeenCalledTimes(1);
	});

	it('says "Send anyway" until the warnings are reviewed, and still sends', async () => {
		presend.summary.value = { warnings: 2, blocking: 0, pending: 0, signature: 'size:|links:"x"' };
		const wrapper = mountStep({ selectedTemplate: template, emailBodyHtml: '<p>Hi</p>' });

		expect(primaryButton(wrapper).text()).toBe('Send anyway');
		await wrapper.find('.presend-ack').trigger('click');
		expect(primaryButton(wrapper).text()).toBe('Send campaign');
		expect(wrapper.find('.presend-panel').attributes('data-acknowledged')).toBe('true');

		// A new warning makes the review stale again.
		presend.summary.value = { warnings: 3, blocking: 0, pending: 0, signature: 'other' };
		await flushPromises();
		expect(primaryButton(wrapper).text()).toBe('Send anyway');

		await primaryButton(wrapper).trigger('click');
		await flushPromises();
		expect(scheduleRuns).toHaveLength(1);
	});

	it('says "Schedule anyway" for a scheduled send with open warnings', async () => {
		presend.summary.value = { warnings: 1, blocking: 0, pending: 0, signature: 'x' };
		const wrapper = mountStep({ selectedTemplate: template, emailBodyHtml: '<p>Hi</p>' });
		await wrapper.findAll('input[type="radio"]')[1]!.setValue();
		expect(primaryButton(wrapper).text()).toBe('Schedule anyway');
	});

	it('opens the editor on the Block behind a finding', async () => {
		const wrapper = mountStep({ selectedTemplate: template, emailBodyHtml: '<p>Hi</p>' });
		await wrapper.find('.presend-show').trigger('click');
		expect(wrapper.emitted('editEmail')).toEqual([[null, 'block-7']]);
	});
});
