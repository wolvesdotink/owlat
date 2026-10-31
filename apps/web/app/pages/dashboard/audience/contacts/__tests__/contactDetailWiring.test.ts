/**
 * The contact page, through its pieces: the header's actions, the details
 * and custom-property cards writing into the page's edit draft, the topics
 * card, the activity log and the delete dialog. The pieces only render and
 * emit; the page and its composables own the state and the writes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { getFunctionName } from 'convex/server';
import { ref } from 'vue';
import ContactDetail from '../[id].vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { installNuxtStubs, queryResult } from '~/__tests__/a11y';

const CONTACT = {
	_id: 'ct_1',
	email: 'marcus@example.com',
	firstName: 'Marcus',
	lastName: 'Oyelaran',
	doiStatus: 'confirmed',
	source: 'form',
	createdAt: Date.parse('2026-01-23T09:00:00Z'),
	updatedAt: Date.parse('2026-01-23T09:00:00Z'),
};

const TOPICS = [
	{ _id: 'tp_news', name: 'Newsletter' },
	{ _id: 'tp_beta', name: 'Beta program' },
];

const isEditing = ref(false);
const showDeleteConfirm = ref(false);
const editForm = ref({ email: '', firstName: '', lastName: '', timezone: '', language: '' });
const propertyForm = ref<Record<string, string>>({});
const handlers = {
	startEditing: vi.fn(),
	saveChanges: vi.fn(),
	confirmDelete: vi.fn(),
	loadMoreActivities: vi.fn(),
};
const ops: Record<string, ReturnType<typeof vi.fn>> = {};

beforeEach(() => {
	isEditing.value = false;
	showDeleteConfirm.value = false;
	editForm.value = { email: '', firstName: '', lastName: '', timezone: '', language: '' };
	propertyForm.value = {};
	for (const handler of Object.values(handlers)) handler.mockReset();
	for (const key of Object.keys(ops)) delete ops[key];
	installNuxtStubs({
		...i18nStubs,
		useRouteId: () => ref('ct_1'),
		useConvexQuery: (fn: unknown) =>
			queryResult(
				getFunctionName(fn as never) === 'topics/topics:getTopicsForContact'
					? [TOPICS[0]]
					: undefined
			),
		useTopicsList: () => ({
			results: ref(TOPICS),
			isLoading: ref(false),
			status: ref('Exhausted'),
		}),
		useBackendOperation: (_fn: unknown, options: { label: () => string }) => {
			const run = vi.fn(async () => ({ ok: true }));
			ops[options.label()] = run;
			return { run, isLoading: ref(false) };
		},
		useToast: () => ({ showToast: vi.fn() }),
		useClickOutside: vi.fn(),
		usePermissions: () => ({
			canManageContacts: ref(true),
			canAnnotateContacts: ref(false),
			isAdmin: ref(true),
		}),
		useActivityTimeline: () => ({
			accumulatedActivities: ref([
				{ _id: 'a1', activityType: 'opened', occurredAt: 1 },
				{ _id: 'a2', activityType: 'clicked', occurredAt: 2 },
			]),
			activitiesLoading: ref(false),
			hasMoreActivities: ref(true),
			isLoadingMoreActivities: ref(false),
			loadMoreActivities: handlers.loadMoreActivities,
			getActivityIcon: () => 'lucide:activity',
			getActivityLabel: (type: string) => `Activity ${type}`,
			getActivityColor: () => '',
			getActivityDescription: () => '',
			formatActivityTime: () => 'just now',
		}),
		useContactDetail: () => ({
			contact: ref(CONTACT),
			contactLoading: ref(false),
			contactError: ref(null),
			refetchContact: vi.fn(),
			properties: ref([{ _id: 'pr_vip', label: 'VIP', type: 'boolean' }]),
			isEditing,
			isSaving: ref(false),
			isDeleting: ref(false),
			showDeleteConfirm,
			saveError: ref(null),
			editForm,
			propertyForm,
			commonTimezones: ref([{ value: 'Europe/Berlin', label: 'Berlin' }]),
			commonLanguages: ref([{ value: 'de', label: 'German' }]),
			startEditing: handlers.startEditing,
			cancelEditing: vi.fn(),
			saveChanges: handlers.saveChanges,
			confirmDelete: handlers.confirmDelete,
			resendDoiConfirmation: vi.fn(),
			isResendingDoi: ref(false),
			getTimezoneLabel: () => 'Not set',
			getLanguageLabel: () => 'Not set',
			getPropertyValue: () => null,
			getDoiStatusLabel: () => 'Subscription confirmed',
			getDoiStatusColor: () => 'text-success',
			getDoiStatusIcon: () => 'lucide:check-circle',
		}),
		formatDateTime: () => 'Jan 23, 2026',
	});
});

function mountPage() {
	return mount(ContactDetail, {
		attachTo: document.body,
		global: {
			plugins: [createTestI18n()],
			stubs: {
				Icon: true,
				NuxtLink: { template: '<a><slot /></a>' },
				UiTabs: {
					props: ['modelValue', 'tabs'],
					emits: ['update:modelValue'],
					template:
						'<div role="tablist"><button v-for="tab in tabs" :key="tab.value" role="tab" @click="$emit(\'update:modelValue\', tab.value)">{{ tab.label }}</button></div>',
				},
				UiPageHeader: {
					props: ['title', 'description'],
					template: '<div><h1>{{ title }}</h1><slot name="meta" /><slot name="actions" /></div>',
				},
				UiButton: { template: '<button v-bind="$attrs"><slot /></button>', inheritAttrs: false },
				UiTooltip: { template: '<span><slot /></span>' },
				UiIconBox: true,
				UiSpinner: true,
				DashboardDetailSkeleton: true,
				UiTextarea: true,
				Teleport: true,
				ContactsSuppressionNotice: true,
				ContactsTimelineStatsCard: true,
				ContactsUnifiedTimelineTab: true,
				ContactsContactKnowledgeTab: true,
				ContactsContactFilesTab: true,
				ContactsIdentitiesTab: true,
				ContactsRelationshipsTab: true,
			},
			mocks: { formatDateTime: () => 'Jan 23, 2026' },
		},
	});
}

const button = (wrapper: ReturnType<typeof mountPage>, label: string) =>
	wrapper.findAll('button').find((candidate) => candidate.text().trim() === label);

describe('contact page pieces', () => {
	it('starts editing from the header, and the inputs write into the page draft', async () => {
		const wrapper = mountPage();
		await button(wrapper, 'Edit')!.trigger('click');
		expect(handlers.startEditing).toHaveBeenCalledTimes(1);

		isEditing.value = true;
		await flushPromises();
		await wrapper.get('input[type="email"]').setValue('m.oyelaran@example.com');
		await wrapper.findAll('select')[0]!.setValue('Europe/Berlin');
		await wrapper.findAll('select')[2]!.setValue('true');
		expect(editForm.value.email).toBe('m.oyelaran@example.com');
		expect(editForm.value.timezone).toBe('Europe/Berlin');
		expect(propertyForm.value['pr_vip']).toBe('true');

		await button(wrapper, 'Save changes')!.trigger('click');
		expect(handlers.saveChanges).toHaveBeenCalledTimes(1);
		wrapper.unmount();
	});

	it('adds the contact to a topic it is not in, and removes it from one it is', async () => {
		const wrapper = mountPage();
		expect(wrapper.text()).toContain('Newsletter');
		await button(wrapper, 'Add to topic')!.trigger('click');
		await button(wrapper, 'Beta program')!.trigger('click');
		await flushPromises();
		expect(ops['Add to topic']).toHaveBeenCalledWith({ topicId: 'tp_beta', contactId: 'ct_1' });
		expect(button(wrapper, 'Beta program')).toBeUndefined();

		await wrapper.get('button[aria-label="Remove from topic"]').trigger('click');
		await flushPromises();
		expect(ops['Remove from topic']).toHaveBeenCalledWith({
			topicId: 'tp_news',
			contactId: 'ct_1',
		});
		wrapper.unmount();
	});

	it('lists the activity log on the Timeline tab and loads more', async () => {
		const wrapper = mountPage();
		const timeline = wrapper.findAll('[role="tab"]').find((tab) => tab.text() === 'Timeline');
		await timeline!.trigger('click');
		expect(wrapper.text()).toContain('Activity opened');
		expect(wrapper.text()).toContain('Activity clicked');
		await button(wrapper, 'Load more')!.trigger('click');
		expect(handlers.loadMoreActivities).toHaveBeenCalledTimes(1);
		wrapper.unmount();
	});

	it('confirms a delete in the dialog, naming the address', async () => {
		const wrapper = mountPage();
		await wrapper.get('button[aria-label="Delete"]').trigger('click');
		expect(showDeleteConfirm.value).toBe(true);
		await flushPromises();
		expect(wrapper.text()).toContain('marcus@example.com');

		const dialogButtons = wrapper.findAll('.max-w-md button');
		await dialogButtons.find((b) => b.text().trim() === 'Cancel')!.trigger('click');
		expect(showDeleteConfirm.value).toBe(false);

		showDeleteConfirm.value = true;
		await flushPromises();
		await wrapper
			.findAll('.max-w-md button')
			.find((b) => b.text().trim() === 'Delete contact')!
			.trigger('click');
		expect(handlers.confirmDelete).toHaveBeenCalledTimes(1);
		wrapper.unmount();
	});
});
