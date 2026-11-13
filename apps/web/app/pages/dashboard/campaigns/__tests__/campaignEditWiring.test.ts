/**
 * The campaign editor drives its form through the cards it renders: the
 * details, content and schedule inputs write into the form's state, the
 * notices and the action row reach the form's handlers, the sender picker in
 * the details card is the one every save validates through, the warm-up
 * card reads the sending posture, and what stops the campaign from going out
 * shows before the click and beside the buttons after a refusal.
 * `useCampaignForm` is replaced by plain refs so each case can see exactly what
 * the page wrote and called.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { defineComponent, h, ref, type Ref } from 'vue';
import { getFunctionName, type FunctionReference } from 'convex/server';
import CampaignEditPage from '../[id]/edit.vue';
import { installNuxtStubs, mountDashboardPage, queryResult } from '~/__tests__/a11y';
import { i18nStubs } from '~/__tests__/i18n';
import { useCampaignABTest } from '~/composables/useCampaignABTest';
import SendBlockedNote from '~/components/campaigns/SendBlockedNote.vue';
import type { CampaignRefusal } from '~/lib/campaignRefusal';

type Form = ReturnType<typeof makeForm>;

function makeForm(campaign: Record<string, unknown> | null) {
	return {
		campaignData: ref(campaign),
		campaignLoading: ref(false),
		campaignError: ref(null),
		refetchCampaign: vi.fn(),
		emailTemplates: ref([]),
		campaignAudience: {
			audienceType: ref('topic'),
			selectedTopicId: ref(null),
			selectedSegmentId: ref(null),
			topics: ref([]),
			segments: ref([]),
			audienceLoadFailed: ref(false),
			retryAudienceLists: vi.fn(),
		},
		audienceCount: ref({ total: 1300, eligible: 1284, completeness: 'exact' }),
		audience: ref({ kind: 'topic', topicId: 'topic_1' }),
		campaignName: ref('Spring launch'),
		fromName: ref('Owlat'),
		fromEmail: ref('news@owlat.example'),
		replyTo: ref(''),
		selectedTemplateId: ref('tpl_1'),
		campaignSubject: ref('Hello spring'),
		archiveEnabled: ref(false),
		scheduledDate: ref(''),
		scheduledTime: ref(''),
		scheduledStartAt: ref<number | null>(null),
		sendTiming: ref({ mode: 'instant', windowHours: 24, holdoutPercent: 10 }),
		selectedTemplate: ref<Record<string, unknown> | null>({
			_id: 'tpl_1',
			name: 'Spring email',
			subject: 'Spring is here',
		}),
		isScheduled: ref(campaign?.['status'] === 'scheduled'),
		isDraft: ref(campaign?.['status'] === 'draft'),
		canEdit: ref(campaign?.['status'] === 'draft' || campaign?.['status'] === 'scheduled'),
		templateLanguages: ref([]),
		errors: ref<Record<string, string>>({}),
		isSaving: ref(false),
		saveError: ref<string | null>(null),
		showUnsavedChangesDialog: ref(false),
		isSavingBeforeLeave: ref(false),
		hasUnsavedChanges: ref(false),
		confirmDiscard: vi.fn(),
		confirmSave: vi.fn(),
		cancelNavigation: vi.fn(),
		onSenderPreselected: vi.fn(),
		handleSave: vi.fn(() => Promise.resolve(true)),
		handleSendNow: vi.fn(() => Promise.resolve()),
		handleSchedule: vi.fn(),
		handleUnschedule: vi.fn(),
		handleCancel: vi.fn(),
		handleBack: vi.fn(),
		capacitySchedule: ref(null),
		dismissCapacitySchedule: vi.fn(),
		sendRefusal: ref<CampaignRefusal | null>(null),
		formatDate: (date: string, time: string) => `on ${date} at ${time}`,
		getMinScheduleDate: () => '2026-03-10',
		getLanguageLabel: (code: string) => code,
	};
}

let form: Form;
let senderPickerRef: Ref<unknown> | null;
let warming: Record<string, unknown> | null;
let estimate: Record<string, unknown> | null;
let readiness: Record<string, unknown> | undefined;
let deliveryConfigured: boolean | undefined;
let isAdmin: boolean;

const senderPickerStub = defineComponent({
	name: 'CampaignsStepsSetupSenderPicker',
	setup(_props, { expose }) {
		expose({ validate: () => null, isReady: true });
		return () => h('div', { 'data-testid': 'sender-picker' });
	},
});

const confirmationStub = defineComponent({
	props: { open: Boolean, description: String, confirmText: String },
	emits: ['update:open', 'confirm'],
	setup(props, { emit }) {
		return () =>
			props.open
				? h('div', { 'data-testid': 'send-confirm' }, [
						h('p', props.description),
						h('button', { 'data-testid': 'send-confirm-ok', onClick: () => emit('confirm') }),
					])
				: null;
	},
});

const unsavedStub = defineComponent({
	props: { show: Boolean },
	emits: ['close', 'discard', 'save'],
	setup(props) {
		return () => (props.show ? h('div', { 'data-testid': 'unsaved-dialog' }) : null);
	},
});

function mountPage(campaign: Record<string, unknown> | null, patch: Partial<Form> = {}) {
	form = { ...makeForm(campaign), ...patch };
	installNuxtStubs({
		...i18nStubs,
		useRouteId: () => ref('campaign_1'),
		useCampaignABTest,
		useCampaignForm: (_id: unknown, _abTest: unknown, pickerRef: Ref<unknown>) => {
			senderPickerRef = pickerRef;
			return form;
		},
		useDesktopContext: () => ({ isDesktop: ref(false) }),
		usePermissions: () => ({ isAdmin: ref(isAdmin) }),
		useOrganizationQuery: (reference: FunctionReference<'query'>) => {
			const name = getFunctionName(reference);
			if (name === 'campaigns/sendingReadiness:getSendingReadiness') {
				return queryResult(readiness);
			}
			if (name === 'campaigns/preflight:getCampaignDeliveryConfigured') {
				return queryResult(deliveryConfigured);
			}
			if (name === 'analytics/reputationQueries:getSendingOverview') {
				return queryResult(warming ? { warming } : null);
			}
			if (name === 'analytics/reputationQueries:getCampaignSendEstimate') {
				return queryResult(estimate);
			}
			return queryResult(undefined);
		},
	});
	return mountDashboardPage(CampaignEditPage, {
		components: { CampaignsSendBlockedNote: SendBlockedNote },
		stubs: {
			UiQueryBoundary: { template: '<div><slot /></div>' },
			UiPageHeader: {
				props: ['title', 'description'],
				template:
					'<header><h1>{{ title }}</h1><p>{{ description }}</p><slot name="meta" /></header>',
			},
			UiButton: {
				props: ['disabled'],
				emits: ['click'],
				template:
					'<button :disabled="disabled" @click="$emit(\'click\', $event)"><slot /></button>',
			},
			NuxtLink: {
				props: ['to'],
				emits: ['click'],
				// No href: a real click would make happy-dom fetch the page.
				template: '<a :data-to="to" @click="$emit(\'click\', $event)"><slot /></a>',
			},
			UiSwitch: true,
			UiConfirmationDialog: confirmationStub,
			UiUnsavedChangesDialog: unsavedStub,
			CampaignsStepsSetupSenderPicker: senderPickerStub,
			CampaignsStepsSetupAudiencePicker: true,
			CampaignsABTestConfig: true,
			CampaignsSendTimingOptions: true,
			CampaignsCapacitySchedulePanel: true,
			CampaignsSendReadinessNote: true,
			CampaignsTestEmailModal: true,
			CampaignsCampaignCancelIntentDialog: true,
			CampaignsCampaignEditLocked: true,
		},
	});
}

const button = (wrapper: ReturnType<typeof mountPage>, text: string) => {
	const found = wrapper.findAll('button').find((b) => b.text().trim() === text);
	if (!found) throw new Error(`no "${text}" button`);
	return found;
};

beforeEach(() => {
	senderPickerRef = null;
	warming = null;
	estimate = null;
	readiness = undefined;
	deliveryConfigured = undefined;
	isAdmin = true;
});

describe('campaign editor wiring', () => {
	it('writes the details and content inputs into the form, and keeps the picker ref', async () => {
		const wrapper = mountPage({ _id: 'campaign_1', name: 'Spring launch', status: 'draft' });

		expect(wrapper.text()).toContain('Draft');
		await wrapper.find('#campaignName').setValue('Summer launch');
		await wrapper.find('#replyTo').setValue('team@owlat.example');
		await wrapper.find('#subject').setValue('Hello summer');
		expect(form.campaignName.value).toBe('Summer launch');
		expect(form.replyTo.value).toBe('team@owlat.example');
		expect(form.campaignSubject.value).toBe('Hello summer');

		// The picker renders inside the details card, and the page's ref (the one
		// every save validates through) points at it.
		expect(wrapper.find('[data-testid="sender-picker"]').exists()).toBe(true);
		expect((senderPickerRef?.value as { isReady?: boolean } | null)?.isReady).toBe(true);

		form.errors.value = {
			campaignName: 'Name it',
			content: 'Pick an email',
			subject: 'Add a subject',
		};
		await flushPromises();
		expect(wrapper.text()).toContain('Name it');
		expect(wrapper.text()).toContain('Pick an email');
		expect(wrapper.text()).toContain('Add a subject');
	});

	it('opens the linked email straight away, or asks first when the form has edits', async () => {
		const wrapper = mountPage({ _id: 'campaign_1', name: 'Spring launch', status: 'draft' });
		const link = wrapper.find('a[data-to="/dashboard/send/emails/tpl_1/edit"]');
		expect(link.text()).toContain('Edit email');

		await link.trigger('click');
		expect(wrapper.find('[data-testid="unsaved-dialog"]').exists()).toBe(false);

		form.hasUnsavedChanges.value = true;
		await link.trigger('click');
		expect(wrapper.find('[data-testid="unsaved-dialog"]').exists()).toBe(true);
	});

	it('schedules from the date and time inputs, with a preview of the start', async () => {
		const wrapper = mountPage({ _id: 'campaign_1', name: 'Spring launch', status: 'draft' });
		expect(button(wrapper, 'Schedule').attributes('disabled')).toBeDefined();

		await wrapper.find('#scheduleDate').setValue('2026-03-20');
		await wrapper.find('#scheduleTime').setValue('09:30');
		expect(form.scheduledDate.value).toBe('2026-03-20');
		expect(form.scheduledTime.value).toBe('09:30');
		expect(wrapper.text()).toContain('on 2026-03-20 at 09:30');

		await button(wrapper, 'Schedule').trigger('click');
		expect(form.handleSchedule).toHaveBeenCalledOnce();
	});

	it('saves, cancels, and sends only after the confirmation', async () => {
		const wrapper = mountPage({ _id: 'campaign_1', name: 'Spring launch', status: 'draft' });

		await button(wrapper, 'Save draft').trigger('click');
		expect(form.handleSave).toHaveBeenCalledOnce();
		await button(wrapper, 'Cancel').trigger('click');
		expect(form.handleBack).toHaveBeenCalledOnce();

		await button(wrapper, 'Send now').trigger('click');
		const confirm = wrapper.find('[data-testid="send-confirm"]');
		expect(confirm.text()).toContain('1,284');
		expect(form.handleSendNow).not.toHaveBeenCalled();
		await wrapper.find('[data-testid="send-confirm-ok"]').trigger('click');
		await flushPromises();
		expect(form.handleSendNow).toHaveBeenCalledOnce();
		expect(wrapper.find('[data-testid="send-confirm"]').exists()).toBe(false);
	});

	it('shows the scheduled notice and the save error, and wires Unschedule and Cancel', async () => {
		const wrapper = mountPage(
			{
				_id: 'campaign_1',
				name: 'Spring launch',
				status: 'scheduled',
				scheduledAt: new Date('2026-03-20T09:30:00').getTime(),
				contentBlockReason: 'Blocked link found',
			},
			{ saveError: ref('Could not save') }
		);

		const text = wrapper.text();
		expect(text).toContain('Reschedule campaign');
		expect(text).toContain('Blocked link found');
		expect(text).toContain('Could not save');
		expect(button(wrapper, 'Reschedule').exists()).toBe(true);
		expect(wrapper.findAll('button').some((b) => b.text().trim() === 'Save draft')).toBe(false);

		await button(wrapper, 'Unschedule to edit').trigger('click');
		expect(form.handleUnschedule).toHaveBeenCalledOnce();
	});

	it('cancels a scheduled campaign only after the confirmation says yes', async () => {
		let answer = false;
		const confirm = vi.fn(async () => answer);
		vi.stubGlobal('useConfirm', () => confirm);
		const wrapper = mountPage({
			_id: 'campaign_1',
			name: 'Spring launch',
			status: 'scheduled',
			scheduledAt: new Date('2026-03-20T09:30:00').getTime(),
		});

		await button(wrapper, 'Cancel campaign').trigger('click');
		await flushPromises();
		expect(confirm).toHaveBeenCalledWith(
			expect.objectContaining({ title: 'Cancel this scheduled campaign?', variant: 'danger' })
		);
		expect(form.handleCancel).not.toHaveBeenCalled();

		answer = true;
		await button(wrapper, 'Cancel campaign').trigger('click');
		await flushPromises();
		expect(form.handleCancel).toHaveBeenCalledOnce();
	});

	it('shows the warm-up progress, today’s capacity and a multi-day estimate', () => {
		warming = {
			phase: 'warming',
			// The furthest-along IP is the day the delivery hub quotes.
			ips: [{ currentDay: 4 }, { currentDay: 12 }],
			// The roll-up counts every pool IP; the send gate does not.
			totalDailyCap: 5000,
			totalSentToday: 1200,
		};
		readiness = { capped: true, today: 2100, growsTo: null, growsAt: null };
		estimate = {
			estimatedDays: 3,
			isTruncated: false,
			isFullyWarmed: false,
			message: 'Backend English the card must not show.',
		};
		const wrapper = mountPage({ _id: 'campaign_1', name: 'Spring launch', status: 'draft' });

		const text = wrapper.text();
		expect(text).toContain('IP warmup status');
		expect(text).toContain('Day 12 of 30');
		expect(wrapper.find('[data-testid="warmup-remaining-today"]').text()).toBe('2,100 emails');
		expect(text).not.toContain('3,800');
		expect(text).toContain('Estimated send time: ~3 days');
		expect(text).toContain('This campaign has 1,284 recipients');
		expect(text).not.toContain('Backend English');
	});

	it('announces the schedule a refused send came back with, but not the preview', async () => {
		warming = { phase: 'warming', ips: [{ currentDay: 3 }], totalDailyCap: 500, totalSentToday: 0 };
		const plan = {
			days: 3,
			slices: [100, 200, 300],
			finishesAt: Date.UTC(2026, 2, 13),
			covered: 600,
			truncated: false,
			audienceUnderCounted: false,
		};
		const wrapper = mountPage(
			{ _id: 'campaign_1', name: 'Spring launch', status: 'draft' },
			{ capacitySchedule: ref(plan) as Form['capacitySchedule'] }
		);
		expect(wrapper.find('campaigns-capacity-schedule-panel-stub').attributes('role')).toBe('alert');
	});

	it('quotes no remaining figure the send gate does not stand behind', () => {
		warming = { phase: 'warming', ips: [{ currentDay: 3 }], totalDailyCap: 500, totalSentToday: 0 };
		readiness = { capped: false, reason: 'not_own_mta' };
		const wrapper = mountPage({ _id: 'campaign_1', name: 'Spring launch', status: 'draft' });
		expect(wrapper.find('[data-testid="warmup-remaining-today"]').exists()).toBe(false);
	});

	it('shows a halted warm-up as halted, with the way to the delivery hub', () => {
		warming = { phase: 'plateau', ips: [{ currentDay: 9 }], totalDailyCap: 900, totalSentToday: 0 };
		readiness = { capped: true, today: 900, growsTo: null, growsAt: null };
		estimate = { estimatedDays: 3, isTruncated: false, isFullyWarmed: false, message: '' };
		const wrapper = mountPage({ _id: 'campaign_1', name: 'Spring launch', status: 'draft' });

		const halted = wrapper.find('[data-testid="warmup-halted"]');
		expect(halted.text()).toContain('Warm-up paused — sending is temporarily held.');
		expect(halted.find('a').attributes('data-to')).toBe('/dashboard/admin/delivery');
		expect(wrapper.text()).not.toContain('Day 9 of 30');
		expect(wrapper.find('[data-testid="warmup-estimate"]').exists()).toBe(false);
	});

	it('gives a member the halted sentence without a link they cannot open', () => {
		isAdmin = false;
		warming = { phase: 'plateau', ips: [{ currentDay: 9 }], totalDailyCap: 900, totalSentToday: 0 };
		const wrapper = mountPage({ _id: 'campaign_1', name: 'Spring launch', status: 'draft' });
		const halted = wrapper.find('[data-testid="warmup-halted"]');
		expect(halted.text()).toContain('Warm-up paused');
		expect(halted.find('a').exists()).toBe(false);
	});

	it('says before the click that sending is not set up, and links to the fix', () => {
		deliveryConfigured = true;
		const ready = mountPage({ _id: 'campaign_1', name: 'Spring launch', status: 'draft' });
		expect(ready.find('[data-testid="send-blocked-note"]').exists()).toBe(false);

		deliveryConfigured = false;
		const blocked = mountPage({ _id: 'campaign_1', name: 'Spring launch', status: 'draft' });
		const note = blocked.find('[role="status"] [data-testid="send-blocked-note"]');
		expect(note.text()).toContain('Sending is not set up yet');
		expect(note.find('a').attributes('data-to')).toBe('/dashboard/admin/delivery/transport');
		expect(note.find('a').text()).toBe('Set up sending');
	});

	it('renders a refused send beside the buttons, in the reader’s words', async () => {
		const wrapper = mountPage({ _id: 'campaign_1', name: 'Spring launch', status: 'draft' });
		expect(wrapper.find('[role="alert"][data-testid="send-blocked-note"]').exists()).toBe(false);

		form.sendRefusal.value = {
			reason: 'sender_not_allowed',
			messageKey: 'shared.campaignRefusal.senderNotAllowed',
			params: { email: 'news@owlat.example' },
			message: 'Cannot send campaign: "news@owlat.example" is not an approved campaign sender.',
		};
		await flushPromises();

		const note = wrapper.find('[role="alert"][data-testid="send-blocked-note"]');
		expect(note.text()).toContain('"news@owlat.example" is not an approved campaign sender.');
		expect(note.find('a').attributes('data-to')).toBe('/dashboard/admin/team/senders');
	});

	it('tells a member to ask an admin instead of linking to an admin page', () => {
		isAdmin = false;
		deliveryConfigured = false;
		const wrapper = mountPage({ _id: 'campaign_1', name: 'Spring launch', status: 'draft' });
		const note = wrapper.find('[data-testid="send-blocked-note"]');
		expect(note.text()).toContain('Sending is not set up yet');
		expect(note.text()).toContain('Ask an admin of this workspace to fix this.');
		expect(note.find('a').exists()).toBe(false);
	});

	it('says a graduated pool is fully warmed', () => {
		warming = { phase: 'graduated', ips: [], totalDailyCap: 0, totalSentToday: 0 };
		const wrapper = mountPage({ _id: 'campaign_1', name: 'Spring launch', status: 'draft' });
		expect(wrapper.text()).toContain('Fully warmed');
	});

	it('holds a campaign under review with its reason and a way back', async () => {
		const wrapper = mountPage({
			_id: 'campaign_1',
			name: 'Spring launch',
			status: 'pending_review',
			contentBlockReason: 'Audience grew past the approved size',
		});

		expect(wrapper.text()).toContain('Under review');
		expect(wrapper.text()).toContain('Audience grew past the approved size');
		expect(wrapper.find('#campaignName').exists()).toBe(false);
		await button(wrapper, 'Back to campaigns').trigger('click');
		expect(form.handleBack).toHaveBeenCalledOnce();
	});
});
