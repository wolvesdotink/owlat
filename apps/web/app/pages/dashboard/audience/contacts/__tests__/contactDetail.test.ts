// @vitest-environment happy-dom
/**
 * The contact page's labels (#804).
 *
 * - The double opt-in badge read "Confirmed confirmation": it is now one plain
 *   phrase per state, "Subscription confirmed".
 * - Custom properties are stored as strings, so a yes/no property read `true`
 *   and a date read `2026-11-09`.
 * - "Activity" and "Timeline" were two tabs for what sounds like one thing; the
 *   activity log now sits under the messages in a single Timeline tab.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import ContactDetail from '../[id].vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { installNuxtStubs, queryResult } from '~/__tests__/a11y';

const isAdmin = ref(true);
const activityTimelineGate = vi.fn();

const CONTACT = {
	_id: 'ct_1',
	email: 'marcus@example.com',
	firstName: 'Marcus',
	lastName: 'Oyelaran',
	doiStatus: 'confirmed',
	createdAt: Date.parse('2026-01-23T09:00:00Z'),
	updatedAt: Date.parse('2026-01-23T09:00:00Z'),
};

const PROPERTIES = [
	{ _id: 'pr_vip', label: 'VIP', type: 'boolean' },
	{ _id: 'pr_renewal', label: 'Renewal date', type: 'date' },
	{ _id: 'pr_city', label: 'City', type: 'string' },
];

const VALUES: Record<string, string> = {
	pr_vip: 'true',
	pr_renewal: '2026-11-09',
};

beforeEach(() => {
	isAdmin.value = true;
	activityTimelineGate.mockReset();
	installNuxtStubs({
		...i18nStubs,
		useRouteId: () => ref('ct_1'),
		useConvexQuery: () => queryResult(undefined),
		useTopicsList: () => ({ results: ref([]), isLoading: ref(false), status: ref('Exhausted') }),
		useBackendOperation: () => ({ run: vi.fn(), isLoading: ref(false) }),
		useToast: () => ({ showToast: vi.fn() }),
		useClickOutside: vi.fn(),
		usePermissions: () => ({
			canManageContacts: ref(true),
			canAnnotateContacts: ref(false),
			isAdmin,
		}),
		useActivityTimeline: (_id: unknown, enabled: () => boolean) => {
			activityTimelineGate.mockImplementation(enabled);
			return {
				accumulatedActivities: ref([]),
				activitiesLoading: ref(false),
				hasMoreActivities: ref(false),
				isLoadingMoreActivities: ref(false),
				loadMoreActivities: vi.fn(),
				getActivityIcon: () => 'lucide:activity',
				getActivityLabel: () => '',
				getActivityColor: () => '',
				getActivityDescription: () => '',
				formatActivityTime: () => '',
			};
		},
		useContactDetail: () => ({
			contact: ref(CONTACT),
			contactLoading: ref(false),
			properties: ref(PROPERTIES),
			isEditing: ref(false),
			isSaving: ref(false),
			isDeleting: ref(false),
			showDeleteConfirm: ref(false),
			saveError: ref(null),
			editForm: ref({}),
			propertyForm: ref({}),
			commonTimezones: ref([]),
			commonLanguages: ref([]),
			startEditing: vi.fn(),
			cancelEditing: vi.fn(),
			saveChanges: vi.fn(),
			confirmDelete: vi.fn(),
			resendDoiConfirmation: vi.fn(),
			isResendingDoi: ref(false),
			getTimezoneLabel: () => 'Not set',
			getLanguageLabel: () => 'Not set',
			getPropertyValue: (id: string) => VALUES[id] ?? null,
			// The real label map — the page must show it as-is, not wrap it.
			getDoiStatusLabel: (status?: string) =>
				status === 'confirmed' ? 'Subscription confirmed' : '',
			getDoiStatusColor: () => 'text-success',
			getDoiStatusIcon: () => 'lucide:check-circle',
		}),
		formatDateTime: () => 'Jan 23, 2026',
	});
});

const tabsStub = {
	props: ['modelValue', 'tabs'],
	emits: ['update:modelValue'],
	template:
		'<div role="tablist"><button v-for="tab in tabs" :key="tab.value" role="tab" @click="$emit(\'update:modelValue\', tab.value)">{{ tab.label }}</button></div>',
};

function mountPage() {
	return mount(ContactDetail, {
		global: {
			plugins: [createTestI18n()],
			stubs: {
				Icon: true,
				NuxtLink: { template: '<a><slot /></a>' },
				UiTabs: tabsStub,
				UiPageHeader: {
					props: ['title', 'description'],
					template: '<div><h1>{{ title }}</h1><slot name="meta" /><slot name="actions" /></div>',
				},
				UiButton: { template: '<button><slot /></button>' },
				UiIconBox: true,
				UiSpinner: true,
				UiTextarea: true,
				Teleport: true,
				ContactsSuppressionNotice: true,
				ContactsTimelineStatsCard: true,
				ContactsUnifiedTimelineTab: { template: '<section data-testid="messages" />' },
				ContactsContactKnowledgeTab: true,
				ContactsContactFilesTab: true,
				ContactsIdentitiesTab: true,
				ContactsRelationshipsTab: true,
			},
			mocks: { formatDateTime: () => 'Jan 23, 2026' },
		},
	});
}

const tabLabels = (wrapper: ReturnType<typeof mountPage>) =>
	wrapper.findAll('[role="tab"]').map((tab) => tab.text());

describe('contact page', () => {
	it('says "Subscription confirmed", not "Confirmed confirmation"', () => {
		const wrapper = mountPage();

		expect(wrapper.text()).toContain('Subscription confirmed');
		expect(wrapper.text()).not.toContain('confirmation');
		wrapper.unmount();
	});

	it('reads custom properties as Yes/No and a formatted date', () => {
		const wrapper = mountPage();

		const text = wrapper.text();
		expect(text).toContain('Yes');
		expect(text).not.toContain('true');
		expect(text).toContain('Nov 9, 2026');
		expect(text).not.toContain('2026-11-09');
		wrapper.unmount();
	});

	it('has one Timeline tab and no separate Activity tab', () => {
		const wrapper = mountPage();

		expect(tabLabels(wrapper)).toEqual([
			'Profile',
			'Timeline',
			'Knowledge',
			'Files',
			'Identities',
			'Relationships',
		]);
		wrapper.unmount();
	});

	it('shows the messages and the activity log together on the Timeline tab', async () => {
		const wrapper = mountPage();
		expect(activityTimelineGate()).toBe(false);

		const timelineTab = wrapper.findAll('[role="tab"]').find((tab) => tab.text() === 'Timeline');
		await timelineTab!.trigger('click');

		expect(wrapper.find('[data-testid="messages"]').exists()).toBe(true);
		expect(wrapper.text()).toContain('No activity yet');
		expect(activityTimelineGate()).toBe(true);
		wrapper.unmount();
	});

	it('gives members the same Timeline name', () => {
		isAdmin.value = false;
		const wrapper = mountPage();

		expect(tabLabels(wrapper)).toEqual(['Profile', 'Timeline']);
		wrapper.unmount();
	});
});
