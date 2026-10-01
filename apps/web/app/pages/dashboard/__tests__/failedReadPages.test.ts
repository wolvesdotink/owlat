// @vitest-environment happy-dom
/**
 * A failed read on a top-level list or detail page is not an empty list and
 * not a missing record (#721). Each page below is mounted with every query it
 * makes failing: it must render the query boundary's error state, its Try
 * again must re-read, and its own empty / not-found copy must not appear.
 *
 * Pages whose read goes through a domain composable (a contact, a thread, a
 * chat room, the Postbox lists) are pinned next to that composable instead.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, ref, type Component } from 'vue';
import { installNuxtStubs, mountDashboardPage } from '~/__tests__/a11y';
import { i18nStubs } from '~/__tests__/i18n';
import { useAddDomain } from '~/composables/useAddDomain';
import { useAutomationBadges } from '~/composables/useAutomationBadges';
import { useBreadcrumbs } from '~/composables/useBreadcrumbs';
import { useCopyToClipboard } from '~/composables/useCopyToClipboard';
import { useKnowledgeGraph } from '~/composables/useKnowledgeGraph';
import { useMemberTable } from '~/composables/useMemberTable';
import { useConfirmModal, useModal } from '~/composables/useModal';
import { useDebouncedSearch } from '~/composables/useDebouncedSearch';
import { useFormSettings } from '~/composables/useFormSettings';
import { useSegmentFilters } from '~/composables/useSegmentFilters';
import { formatDate } from '~/utils/formatters';
import { useWebhookDeliveryLogs } from '~/composables/useWebhookDeliveryLogs';
import { useWebhookForm } from '~/composables/useWebhookForm';
import en from '../../../../i18n/locales/en.json';

const refetch = vi.fn();
const failure = () => new Error('[CONVEX Q(x:y)] [Request ID: 1] Server Error');

function failingQuery() {
	return {
		data: ref(undefined),
		isLoading: ref(false),
		isRefetching: ref(false),
		error: ref(failure()),
		refetch,
		reset: vi.fn(),
	};
}

function failingPage() {
	return {
		results: ref([]),
		status: ref('LoadingFirstPage'),
		isLoading: ref(false),
		isRefetching: ref(false),
		error: ref(failure()),
		refetch,
		loadMore: vi.fn(),
		reset: vi.fn(),
	};
}

/** The boundary's contract, without its copy: error → marker + retry, else the content. */
const QueryBoundaryStub = defineComponent({
	props: { error: { type: null, default: null } },
	emits: ['retry'],
	template: `
		<div v-if="error" data-testid="query-error">
			<button type="button" data-testid="query-retry" @click="$emit('retry')" />
		</div>
		<slot v-else />
	`,
});

function copy(key: string): string {
	const value = key
		.split('.')
		.reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], en);
	if (typeof value !== 'string') throw new Error(`No English copy at ${key}`);
	return value;
}

const mailbox = { _id: 'mb1', address: 'team@example.com' };

interface PageCase {
	name: string;
	load: () => Promise<{ default: Component }>;
	/** Copy the page shows for an empty list or a missing record. */
	absent: string[];
	stubs?: () => Record<string, unknown>;
}

const PAGES: PageCase[] = [
	{
		name: 'webhooks list',
		load: () => import('../admin/delivery/webhooks.vue'),
		absent: ['dashboard.admin.delivery.webhooks.empty.title'],
	},
	{
		name: 'sending domains list',
		load: () => import('../admin/delivery/domains.vue'),
		absent: [
			'dashboard.admin.delivery.domains.empty.title',
			'dashboard.admin.delivery.domains.noDomain.title',
		],
	},
	{
		name: 'channels list',
		load: () => import('../admin/instance/channels.vue'),
		absent: ['dashboard.admin.instance.channels.emptyTitle'],
	},
	{
		name: 'API keys list',
		load: () => import('../admin/team/api/index.vue'),
		absent: ['dashboard.admin.team.api.index.empty.title'],
	},
	{
		name: 'segment detail',
		load: () => import('../audience/segments/[id]/index.vue'),
		absent: ['dashboard.audience.segments.detail.index.notFound.title'],
	},
	{
		name: 'topic detail',
		load: () => import('../audience/topics/[id]/index.vue'),
		absent: ['dashboard.audience.topics.detail.index.notFound.title'],
	},
	{
		name: 'contact in a topic',
		load: () => import('../audience/topics/[id]/contacts/[contactId].vue'),
		absent: ['dashboard.audience.topics.detail.contacts.detail.notFound.title'],
	},
	{
		name: 'automation detail',
		load: () => import('../automations/[id]/index.vue'),
		absent: ['dashboard.automations.detail.index.notFoundTitle'],
	},
	{
		name: 'file detail',
		load: () => import('../files/[id].vue'),
		absent: ['dashboard.files.detail.notFound'],
	},
	{
		name: 'knowledge entry detail',
		load: () => import('../knowledge/[id].vue'),
		absent: ['dashboard.knowledge.detail.notFoundTitle'],
	},
	{
		name: 'transactional send detail',
		load: () => import('../send/transactional/[id]/sends/[sendId].vue'),
		absent: ['dashboard.send.transactional.detail.sends.detail.notFound.title'],
	},
	{
		name: 'operator console',
		load: () => import('../admin/operator/index.vue'),
		absent: ['dashboard.admin.operator.index.abuse.empty'],
	},
	{
		name: 'form endpoints list',
		load: () => import('../admin/instance/forms.vue'),
		absent: ['dashboard.admin.instance.forms.emptyTitle'],
	},
	{
		name: 'all inboxes',
		load: () => import('../inboxes.vue'),
		absent: ['dashboard.inboxes.empty'],
		stubs: () => ({
			useInboxes: () => ({
				inboxes: ref([]),
				ids: ref([]),
				byId: ref(new Map()),
				isLoading: ref(false),
				error: ref(failure()),
				refetch,
			}),
			useConvexQueryMap: () => new Map(),
		}),
	},
	{
		name: 'mail aliases',
		load: () => import('../preferences/aliases.vue'),
		absent: ['dashboard.preferences.aliases.empty'],
		stubs: () => ({
			usePostboxMailbox: () => ({
				currentMailbox: ref(mailbox),
				isLoading: ref(false),
				error: ref(null),
				refetch: vi.fn(),
			}),
		}),
	},
	{
		name: 'mail aliases without the mailbox list',
		load: () => import('../preferences/aliases.vue'),
		absent: ['dashboard.preferences.aliases.noMailbox'],
		stubs: () => ({
			usePostboxMailbox: () => ({
				currentMailbox: ref(null),
				isLoading: ref(false),
				error: ref(failure()),
				refetch,
			}),
		}),
	},
];

/** Feature components the pages render around the branch under test. */
const FEATURE_STUBS = Object.fromEntries(
	[
		'AudienceMemberTable',
		'ChannelsChannelConfigCard',
		'DashboardDetailSkeleton',
		'DashboardEmailSendTimeline',
		'DashboardListSkeleton',
		'DashboardSendStatusBadge',
		'DeliveryDomainDnsGuidance',
		'DeliveryRelayDomainStatus',
		'DeliverySendingDetails',
		'DomainsAddDomainForm',
		'DomainsRecordRow',
		'DomainsTrackingDomainsSection',
		'FilesContactPicker',
		'FilesFileUploadModal',
		'FilesThreadPicker',
		'FilesVersionHistory',
		'FormsFieldsEditor',
		'FormsSubmissionsPanel',
		'InboxChip',
		'KnowledgeEntryForm',
		'KnowledgeRelationsList',
		'ShellStatusPill',
		'UiBadge',
		'UiConfirmationDialog',
		'UiDropdownMenu',
		'UiDropdownMenuItem',
		'UiModal',
		'UiPageHeader',
		'UiProgressBar',
		'UiSegmentedControl',
		'UiSelect',
		'UiSkeleton',
		'UiSwitch',
		'UiTabs',
		'UiTextarea',
		'WebhooksWebhookDeliveryLogsModal',
		'WebhooksWebhookDeliveryLogsPanel',
		'WebhooksWebhookFormModal',
		'WebhooksWebhookRow',
	].map((name) => [name, true])
);

afterEach(() => {
	refetch.mockClear();
});

describe('failed reads on list and detail pages (#721)', () => {
	it.each(PAGES)('$name shows the error and Try again, not its empty state', async (page) => {
		installNuxtStubs({
			...i18nStubs,
			useAddDomain,
			useAutomationBadges,
			useBreadcrumbs,
			useCopyToClipboard,
			useKnowledgeGraph,
			useMemberTable,
			useModal,
			useConfirmModal,
			useDebouncedSearch,
			useFormSettings,
			useSegmentFilters,
			useWebhookDeliveryLogs,
			useWebhookForm,
			formatDate,
			// Inert: the real guard needs a router the pages are not mounted under.
			useUnsavedChanges: () => ({
				showDialog: ref(false),
				isSavingBeforeLeave: ref(false),
				confirmDiscard: vi.fn(),
				confirmSave: vi.fn(),
				cancelNavigation: vi.fn(),
				setHasChanges: vi.fn(),
			}),
			useTopicsList: () => ({ results: ref([]) }),
			useRouteId: () => ref('id1'),
			useConvexQuery: failingQuery,
			useOrganizationQuery: failingQuery,
			usePaginatedQuery: failingPage,
			useOrganizationPaginatedQuery: failingPage,
			...page.stubs?.(),
		});
		const { default: Page } = await page.load();
		const wrapper = mountDashboardPage(Page, {
			components: { UiQueryBoundary: QueryBoundaryStub },
			stubs: FEATURE_STUBS,
		});

		expect(wrapper.find('[data-testid="query-error"]').exists()).toBe(true);
		for (const key of page.absent) expect(wrapper.html()).not.toContain(copy(key));

		await wrapper.find('[data-testid="query-retry"]').trigger('click');
		expect(refetch).toHaveBeenCalled();
		wrapper.unmount();
	});
});
