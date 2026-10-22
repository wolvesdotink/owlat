<script setup lang="ts">
/**
 * Recently deleted: the campaigns, automations and email templates deleted in
 * the last 30 days, each with Restore. A delete in the lists is immediate (its
 * toast offers Undo for a few seconds); this page is where it can still be
 * taken back afterwards. The daily purge removes an item for good 30 days
 * after its delete.
 *
 * One tab per kind the viewer may restore: restoring needs the permission the
 * delete needed (`campaigns:manage`, `automations:manage`, `templates:manage`)
 * and the kind's feature where it has one. Templates need no feature, so the
 * page opts out of the `/dashboard/marketing` path gate (`campaigns`) and
 * gates each tab itself.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { formatRelativeTime } from '~/utils/formatters';

const { t } = useI18n();

useHead({ title: () => t('dashboard.marketing.deleted.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	publicFeature: true,
});

type Kind = 'campaigns' | 'automations' | 'templates';

interface DeletedRow {
	_id: string;
	name: string;
	deletedAt: number;
	purgeAt: number;
}

const route = useRoute();
const router = useRouter();
const { isEnabled } = useFeatureFlag();
const { can } = usePermissions();
const { hasActiveOrganization } = useOrganizationContext();
const { showToast } = useToast();

const kinds = computed<Kind[]>(() =>
	(
		[
			['campaigns', isEnabled('campaigns') && can('campaigns:manage')],
			['automations', isEnabled('automations') && can('automations:manage')],
			['templates', can('templates:manage')],
		] as const
	)
		.filter(([, allowed]) => allowed)
		.map(([kind]) => kind)
);

// ?type= keeps the tab shareable; an unknown or unavailable one falls back to
// the first tab the viewer has.
const kind = computed<Kind | undefined>(() => {
	const wanted = route.query['type'];
	return kinds.value.find((k) => k === wanted) ?? kinds.value[0];
});
function selectKind(next: string) {
	router.replace({ query: { ...route.query, type: next } });
}

const tabs = computed(() =>
	kinds.value.map((value) => ({ value, label: t(`dashboard.marketing.deleted.tabs.${value}`) }))
);

const PAGE_SIZE = 50;
const only = (wanted: Kind) => () => (kind.value === wanted ? {} : undefined);
const campaigns = useOrganizationPaginatedQuery(
	api.campaigns.deletion.listDeleted,
	only('campaigns'),
	{ initialNumItems: PAGE_SIZE }
);
const automations = useOrganizationPaginatedQuery(
	api.automations.deletion.listDeleted,
	only('automations'),
	{ initialNumItems: PAGE_SIZE }
);
const templates = useOrganizationPaginatedQuery(
	api.emailTemplates.deletion.listDeleted,
	only('templates'),
	{ initialNumItems: PAGE_SIZE }
);
const active = computed(() =>
	kind.value === 'automations' ? automations : kind.value === 'templates' ? templates : campaigns
);

const rows = computed<DeletedRow[]>(() => active.value.results.value);
const showSkeleton = computed(() => active.value.isLoading.value && rows.value.length === 0);
const canLoadMore = computed(() => active.value.status.value === 'CanLoadMore');
const isLoadingMore = computed(() => active.value.status.value === 'LoadingMore');

const { run: restoreCampaign } = useBackendOperation(api.campaigns.campaigns.restore, {
	label: () => t('dashboard.marketing.deleted.restoreOperation'),
});
const { run: restoreAutomation } = useBackendOperation(api.automations.automations.restore, {
	label: () => t('dashboard.marketing.deleted.restoreOperation'),
});
const { run: restoreTemplate } = useBackendOperation(api.emailTemplates.emails.restore, {
	label: () => t('dashboard.marketing.deleted.restoreOperation'),
});

// A row's Restore is in flight: its button spins and ignores a second press.
const restoring = ref<string | null>(null);

async function restore(row: DeletedRow) {
	if (restoring.value || !kind.value) return;
	restoring.value = row._id;
	try {
		const result =
			kind.value === 'campaigns'
				? await restoreCampaign({ campaignId: row._id as Id<'campaigns'> })
				: kind.value === 'automations'
					? await restoreAutomation({ automationId: row._id as Id<'automations'> })
					: await restoreTemplate({ templateId: row._id as Id<'emailTemplates'> });
		if (result.ok) showToast(t('dashboard.marketing.deleted.restored', { name: row.name }));
	} finally {
		restoring.value = null;
	}
}

function meta(row: DeletedRow): string {
	return t('dashboard.marketing.deleted.meta', {
		deleted: formatRelativeTime(row.deletedAt),
		purge: formatRelativeTime(row.purgeAt),
	});
}
</script>

<template>
	<div class="mx-auto w-full max-w-page p-6 lg:p-8">
		<UiPageHeader
			:title="t('dashboard.marketing.deleted.title')"
			:description="t('dashboard.marketing.deleted.subtitle')"
			class="mb-6"
		/>

		<UiCard v-if="!hasActiveOrganization || !kind" padding="none" overflow="hidden">
			<UiEmptyState
				icon="lucide:trash-2"
				:title="t('dashboard.marketing.deleted.unavailable.title')"
				:description="t('dashboard.marketing.deleted.unavailable.description')"
			/>
		</UiCard>

		<template v-else>
			<div v-if="tabs.length > 1" class="mb-4 max-w-full overflow-x-auto">
				<UiSegmentedControl
					:model-value="kind"
					:options="tabs"
					:aria-label="t('dashboard.marketing.deleted.tabsLabel')"
					fit="content"
					class="min-w-max"
					@update:model-value="selectKind($event as string)"
				/>
			</div>
			<p v-if="kind === 'campaigns'" class="mb-4 text-sm text-text-secondary">
				{{ t('dashboard.marketing.deleted.campaignsNote') }}
			</p>

			<UiQueryBoundary
				:loading="showSkeleton"
				:error="active.error.value"
				:error-title="t('dashboard.marketing.deleted.errorTitle')"
				:loading-label="t('common.loading')"
				@retry="active.refetch()"
			>
				<UiCard v-if="rows.length === 0" padding="none" overflow="hidden">
					<UiEmptyState
						icon="lucide:trash-2"
						:title="t('dashboard.marketing.deleted.empty.title')"
						:description="t('dashboard.marketing.deleted.empty.description')"
					/>
				</UiCard>

				<UiCard v-else padding="none" overflow="hidden">
					<ul class="divide-y divide-border-subtle">
						<li
							v-for="row in rows"
							:key="row._id"
							class="flex items-center gap-4 px-6 py-4"
							data-testid="recently-deleted-row"
						>
							<div class="min-w-0 flex-1">
								<p class="truncate font-medium text-text-primary">{{ row.name }}</p>
								<p class="text-sm text-text-tertiary">{{ meta(row) }}</p>
							</div>
							<UiButton
								variant="secondary"
								size="sm"
								:loading="restoring === row._id"
								:disabled="restoring !== null && restoring !== row._id"
								:aria-label="t('dashboard.marketing.deleted.restoreNamed', { name: row.name })"
								@click="restore(row)"
							>
								<template #iconLeft><Icon name="lucide:undo-2" class="h-4 w-4" /></template>
								{{ t('dashboard.marketing.deleted.restore') }}
							</UiButton>
						</li>
					</ul>
					<div
						v-if="canLoadMore || isLoadingMore"
						class="flex justify-center border-t border-border-subtle px-6 py-4"
					>
						<UiButton
							variant="secondary"
							:loading="isLoadingMore"
							@click="active.loadMore(PAGE_SIZE)"
						>
							{{ t('dashboard.marketing.deleted.loadMore') }}
						</UiButton>
					</div>
				</UiCard>
			</UiQueryBoundary>
		</template>
	</div>
</template>
