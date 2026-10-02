// @vitest-environment happy-dom
/**
 * A failed read is not the default value (#1097). The controls and dashboards
 * below write only the one value the operator picks, so a failed read
 * overwrites nothing, but showing the default in its place states something
 * untrue: "Automatic" sealing, TLS required, a healthy agent with no queue,
 * "never checked" for updates, no deletion pending.
 *
 * Each one is mounted with every read failing. It must show the query
 * boundary's error with a working Try again, and none of its default state.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, ref, type Component } from 'vue';
import { installNuxtStubs, mountDashboardPage } from '~/__tests__/a11y';
import { i18nStubs } from '~/__tests__/i18n';
import { formatDate } from '~/utils/formatters';
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

const QueryBoundaryStub = defineComponent({
	props: {
		error: { type: null, default: null },
		loading: { type: Boolean, default: false },
	},
	emits: ['retry'],
	template: `
		<div v-if="error" data-testid="query-error">
			<button type="button" data-testid="query-retry" @click="$emit('retry')" />
		</div>
		<div v-else-if="loading" data-testid="query-loading" />
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

interface ControlCase {
	name: string;
	load: () => Promise<{ default: Component }>;
	props?: Record<string, unknown>;
	/** Copy of the default state, which must not appear. */
	absent?: string[];
	/** Elements of the default state, which must not render. */
	absentSelectors?: string[];
	/** Independent reads on the page, each with its own error. */
	errors?: number;
}

const CONTROLS: ControlCase[] = [
	{
		name: 'sealed mail policy',
		load: () => import('../admin/instance/sealed-mail.vue'),
		absentSelectors: ['[data-testid="seal-policy-auto"]'],
	},
	{
		name: 'writing voice',
		load: () => import('~/components/postbox/PostboxVoiceProfileCard.vue'),
		props: { mailboxId: 'mb1', address: 'team@example.com' },
		absent: [
			'components.postbox.postboxVoiceProfileCard.personalize',
			'components.postbox.postboxVoiceProfileCard.disabledHint',
		],
	},
	{
		name: 'account deletion state',
		load: () => import('../preferences/account.vue'),
		absent: [
			'dashboard.preferences.account.deletionPendingTitle',
			'dashboard.preferences.account.deleteAccountTitle',
		],
	},
	{
		name: 'inbound TLS required',
		load: () => import('~/components/delivery/InboundTlsRequirementCard.vue'),
		absentSelectors: ['[data-testid="inbound-tls-required"]'],
	},
	{
		name: 'MTA-STS mode',
		load: () => import('~/components/delivery/MtaStsModeCard.vue'),
		absent: ['components.delivery.mtaStsModeCard.descriptions.none'],
		absentSelectors: ['ui-segmented-control-stub'],
	},
	{
		name: 'body search indexing',
		load: () => import('~/components/settings/BodySearchIndexCard.vue'),
		absentSelectors: ['[data-testid="body-search-indexing"]'],
	},
	{
		name: 'raw-message retention',
		load: () => import('~/components/settings/InboundRetentionCard.vue'),
		absentSelectors: ['[data-testid="inbound-retention-days"]'],
	},
	{
		name: 'migration mode',
		load: () => import('~/components/settings/MigrationModeCard.vue'),
		props: { canManage: true },
		absentSelectors: ['ui-switch-stub'],
	},
	{
		name: 'ask-eagerness dial',
		load: () => import('~/components/autonomy/AskEagernessDial.vue'),
		absent: ['components.autonomy.askEagernessDial.options.balanced.label'],
	},
	{
		name: 'agent health',
		load: () => import('../admin/instance/agent-health.vue'),
		absentSelectors: ['agent-metric-card-stub', 'agent-circuit-breaker-status-stub'],
	},
	{
		name: 'system updates',
		load: () => import('../admin/system/index.vue'),
		absent: [
			'dashboard.admin.system.index.updates.neverChecked',
			'dashboard.admin.system.index.history.empty',
		],
		errors: 2,
	},
];

const FEATURE_STUBS = Object.fromEntries(
	[
		'AgentCircuitBreakerStatus',
		'AgentMetricCard',
		'AgentMetricChart',
		'AuthPasswordInput',
		'DashboardDetailSkeleton',
		'PostboxDailyBriefSettings',
		'PreferencesExportManifest',
		'PreferencesYourData',
		'ProfileSyncBanner',
		'SystemContainerHealthCard',
		'SystemLlmSpendCard',
		'SystemPortChecksCard',
		'SystemUpdateProgress',
		'SystemVersionCard',
		'UiConfirmationDialog',
		'UiInput',
		'UiModal',
		'UiPageHeader',
		'UiSegmentedControl',
		'UiSelect',
		'UiSkeleton',
		'UiSkeletonText',
		'UiSwitch',
		'UnsavedChangesDialog',
		'I18nT',
	].map((name) => [name, true])
);

afterEach(() => {
	refetch.mockClear();
});

describe('controls and dashboards after a failed read (#1097)', () => {
	it.each(CONTROLS)('$name shows the error, not its default state', async (control) => {
		installNuxtStubs({
			...i18nStubs,
			formatDate,
			useConvexQuery: failingQuery,
			useOrganizationQuery: failingQuery,
			usePostboxMailbox: () => ({
				currentMailbox: ref(null),
				isLoading: ref(false),
				error: ref(null),
				refetch: vi.fn(),
			}),
			useProfileSync: () => ({ trackFlagChange: vi.fn() }),
			useSystemUpdateRun: () => ({
				updateState: ref('idle'),
				updateSteps: ref(null),
				updateError: ref(null),
				updateWarning: ref(null),
				updateAttempt: ref(0),
				updateInProgress: ref(false),
				pendingTargetVersion: ref(null),
				startUpdate: vi.fn(),
				cancelConfirm: vi.fn(),
				confirmUpdate: vi.fn(),
				onUpdateComplete: vi.fn(),
				onUpdateStarted: vi.fn(),
				onUpdateFailed: vi.fn(),
			}),
			useUnsavedChanges: () => ({
				showDialog: ref(false),
				isSavingBeforeLeave: ref(false),
				confirmDiscard: vi.fn(),
				confirmSave: vi.fn(),
				cancelNavigation: vi.fn(),
				setHasChanges: vi.fn(),
			}),
		});
		const { default: Control } = await control.load();
		const wrapper = mountDashboardPage(
			defineComponent({
				components: { Control },
				setup: () => ({ props: control.props ?? {} }),
				template: '<Control v-bind="props" />',
			}),
			{ components: { UiQueryBoundary: QueryBoundaryStub }, stubs: FEATURE_STUBS }
		);

		const errors = wrapper.findAll('[data-testid="query-error"]');
		expect(errors.length).toBeGreaterThanOrEqual(control.errors ?? 1);
		for (const key of control.absent ?? []) expect(wrapper.text()).not.toContain(copy(key));
		for (const selector of control.absentSelectors ?? []) {
			expect(wrapper.find(selector).exists(), selector).toBe(false);
		}

		await errors[0]!.find('[data-testid="query-retry"]').trigger('click');
		expect(refetch).toHaveBeenCalled();
		wrapper.unmount();
	});
});
