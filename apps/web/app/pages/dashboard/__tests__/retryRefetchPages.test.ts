// @vitest-environment happy-dom
/**
 * Try again re-reads the failed query instead of reloading the app (#1098).
 *
 * These pages bound their read's `:error` to `UiQueryBoundary` but left
 * `@retry` unwired, so Try again fell back to `window.location.reload()`.
 * Each is mounted with every read failing: the boundary must show its
 * error, and its retry must reach the read's `refetch`. The source rule that
 * keeps new boundaries in line is `app/__tests__/queryBoundaryRetry.lint.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computed, defineComponent, ref, type Component } from 'vue';
import { installNuxtStubs, mountDashboardPage } from '~/__tests__/a11y';
import { i18nStubs } from '~/__tests__/i18n';
import { usePostboxListKeyboard } from '~/composables/postbox/usePostboxListKeyboard';
import { usePostboxOptimisticHide } from '~/composables/postbox/usePostboxOptimisticHide';
import { useAccumulatedCursorList } from '~/composables/useAccumulatedCursorList';
import { useAiProviderForm } from '~/composables/useAiProviderForm';
import { useAuditLogPresentation } from '~/composables/useAuditLogPresentation';
import { useCampaignABTest } from '~/composables/useCampaignABTest';
import { useCampaignAudience } from '~/composables/useCampaignAudience';
import { useCampaignForm } from '~/composables/useCampaignForm';
import { useCampaignUndoSend } from '~/composables/useCampaignUndoSend';
import { useChannelInbox } from '~/composables/useChannelInbox';
import { useClickOutsideSelector } from '~/composables/useClickOutside';
import { useCopyToClipboard } from '~/composables/useCopyToClipboard';
import { useDesktopUpdatePolicy } from '~/composables/useDesktopUpdatePolicy';
import { useFormModal } from '~/composables/useFormModal';
import { useFormValidation } from '~/composables/useFormValidation';
import { useInbox } from '~/composables/useInbox';
import { useInboxAssigneePresence } from '~/composables/useInboxAssigneePresence';
import { useInboxTriage } from '~/composables/useInboxTriage';
import { useConfirmModal, useModal } from '~/composables/useModal';

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

interface PageCase {
	name: string;
	load: () => Promise<{ default: Component }>;
}

const PAGES: PageCase[] = [
	{ name: 'backups', load: () => import('../admin/backups.vue') },
	{ name: 'channel activity', load: () => import('../admin/delivery/activity.vue') },
	{ name: 'AI provider', load: () => import('../admin/instance/ai-provider.vue') },
	{ name: 'desktop updates', load: () => import('../admin/instance/desktop-updates.vue') },
	{ name: 'ramp cells', load: () => import('../admin/delivery/advanced/cells.vue') },
	{ name: 'ramp controls', load: () => import('../admin/delivery/advanced/controls.vue') },
	{ name: 'ramp independence', load: () => import('../admin/delivery/advanced/independence.vue') },
	{ name: 'ramp measurement', load: () => import('../admin/delivery/advanced/measurement.vue') },
	{ name: 'deliverability', load: () => import('../admin/delivery/deliverability.vue') },
	{ name: 'failed deliveries', load: () => import('../admin/delivery/failed.vue') },
	{ name: 'quarantine', load: () => import('../admin/delivery/quarantine.vue') },
	{ name: 'plugin settings list', load: () => import('../admin/instance/plugins/index.vue') },
	{ name: 'plugin settings', load: () => import('../admin/instance/plugins/[id].vue') },
	{ name: 'feature flags', load: () => import('../admin/instance/features.vue') },
	{ name: 'general settings', load: () => import('../admin/instance/general.vue') },
	{ name: 'contact properties', load: () => import('../admin/instance/properties.vue') },
	{ name: 'audit log', load: () => import('../admin/team/audit.vue') },
	{ name: 'connected apps', load: () => import('../admin/team/connected-apps/index.vue') },
	{ name: 'code tasks', load: () => import('../inbox/code-tasks.vue') },
	{ name: 'team inbox', load: () => import('../inbox/index.vue') },
	{ name: 'campaign editor', load: () => import('../campaigns/[id]/edit.vue') },
	{ name: 'updates', load: () => import('../inbox/updates.vue') },
	{ name: 'add account', load: () => import('../preferences/add-account.vue') },
];

/** Feature components the pages render around the boundary under test. */
const FEATURE_STUBS = Object.fromEntries(
	[
		'BackupCommandRow',
		'CampaignsABTestConfig',
		'CampaignsCampaignEditLocked',
		'CampaignsCapacitySchedulePanel',
		'CampaignsSendReadinessNote',
		'CampaignsStepsSetupAudiencePicker',
		'CampaignsStepsSetupSenderPicker',
		'CampaignsTestEmailModal',
		'CodeTasksCodeTaskCard',
		'DashboardAuditLogList',
		'DashboardDetailSkeleton',
		'DashboardListSkeleton',
		'DeliveryDeliverabilityChecklistGroups',
		'DeliveryDeliverabilityIpv6Setup',
		'DeliveryDeliverabilityLoopbackCard',
		'DeliveryDeliverabilityNextActionCard',
		'DeliveryDeliverabilityRegressionAlerts',
		'DeliveryEnvSetupSteps',
		'DeliveryIndependenceTrendChart',
		'DeliveryMeasurementCellCard',
		'DeliveryMeasurementGateList',
		'DeliveryRampCellControls',
		'DeliveryRampCellsGrid',
		'DeliveryRampConfirmDialog',
		'DeliveryRampDecisionTimeline',
		'DeliveryRampDecreaseNotices',
		'DeliveryRampNarrativeCard',
		'DeliveryRampPresetPicker',
		'DeliveryReferenceRelayNotice',
		'InboxActivityEmptyState',
		'InboxFilterPills',
		'InboxQuarantineReason',
		'InboxThreadRow',
		'PostboxMailboxConnectForm',
		'PostboxSnoozeDialog',
		'PostboxTeamMemberPicker',
		'PostboxThreadListSkeleton',
		'SettingsAiDecisionCard',
		'SettingsAiKeyField',
		'SettingsAiModelPicker',
		'SettingsBodySearchIndexCard',
		'SettingsConnectedWorkspaces',
		'SettingsInboundRetentionCard',
		'SettingsMigrationModeCard',
		'SettingsWorkspaceDangerZone',
		'SettingsWorkspaceLogoCard',
		'UiAvatar',
		'UiBadge',
		'UiCard',
		'UiConfirmationDialog',
		'UiDisclosure',
		'UiIconBox',
		'UiInput',
		'UiModal',
		'UiPageHeader',
		'UiSelect',
		'UiSkeleton',
		'UiSkeletonText',
		'UiSwitch',
	].map((name) => [name, true])
);

afterEach(() => {
	refetch.mockClear();
});

describe('Try again on a failed read refetches it (#1098)', () => {
	it.each(PAGES)('$name wires Try again to the read', async (page) => {
		installNuxtStubs({
			...i18nStubs,
			// The real composables the pages read through; their queries hit the
			// failing stubs below.
			useAccumulatedCursorList,
			useAiProviderForm,
			useAuditLogPresentation,
			useCampaignABTest,
			useCampaignAudience,
			useCampaignForm,
			useCampaignUndoSend,
			useChannelInbox,
			useClickOutsideSelector,
			useConfirmModal,
			useCopyToClipboard,
			useDesktopUpdatePolicy,
			useFormModal,
			useFormValidation,
			useInbox,
			useInboxAssigneePresence,
			useInboxTriage,
			useModal,
			usePostboxListKeyboard,
			usePostboxOptimisticHide,
			// Every read fails; the rest is inert.
			useConvexQuery: failingQuery,
			useOrganizationQuery: failingQuery,
			useOrganizationPaginatedQuery: () => ({
				results: ref([]),
				status: ref('Exhausted'),
				isLoading: ref(false),
				error: ref(null),
				loadMore: vi.fn(),
			}),
			useTopicsList: () => ({ results: ref([]) }),
			useDesktopContext: () => ({ isDesktop: ref(false) }),
			useLocalStorage: (_key: string, fallback: unknown) => ({ data: ref(fallback), set: vi.fn() }),
			useOrganization: () => ({
				organization: ref(null),
				update: vi.fn(),
				members: ref([]),
				fetchMembers: vi.fn(),
				isLoadingMembers: ref(false),
			}),
			// Inert: the real guard needs a router the pages are not mounted under.
			useUnsavedChanges: () => ({
				showDialog: ref(false),
				isSavingBeforeLeave: ref(false),
				confirmDiscard: vi.fn(),
				confirmSave: vi.fn(),
				cancelNavigation: vi.fn(),
				setHasChanges: vi.fn(),
			}),
			useRouteId: () => computed(() => 'id1'),
		});
		const { default: Page } = await page.load();
		const wrapper = mountDashboardPage(Page, {
			components: { UiQueryBoundary: QueryBoundaryStub },
			stubs: FEATURE_STUBS,
		});

		expect(wrapper.find('[data-testid="query-error"]').exists()).toBe(true);
		await wrapper.find('[data-testid="query-retry"]').trigger('click');
		expect(refetch).toHaveBeenCalled();
		wrapper.unmount();
	});
});
