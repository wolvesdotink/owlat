<script setup lang="ts">
/**
 * Shown on the edit route for a campaign that has left draft/scheduled (sending,
 * sent or stopped). Editing is over, so the state points at what the operator can
 * still do: read the report, or duplicate the campaign to send a new version.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

const props = defineProps<{
	campaignId: Id<'campaigns'>;
	status: string;
}>();

const emit = defineEmits<{ back: [] }>();

const { t } = useI18n();
const router = useRouter();
const { showToast } = useToast();

const K = 'dashboard.campaigns.detail.edit.locked';

const description = computed(() => {
	if (props.status === 'sending') return t(`${K}.sending`);
	if (props.status === 'cancelled') return t(`${K}.cancelled`);
	return t(`${K}.sent`);
});

const { run: duplicateCampaign } = useBackendOperation(api.campaigns.campaigns.duplicate, {
	label: () => t('dashboard.campaigns.detail.report.duplicateOperation'),
});
const isDuplicating = ref(false);
async function handleDuplicate() {
	if (isDuplicating.value) return;
	isDuplicating.value = true;
	const created = await duplicateCampaign({ campaignId: props.campaignId });
	if (!created.ok) {
		isDuplicating.value = false;
		return;
	}
	showToast(t('dashboard.campaigns.detail.report.toasts.duplicated'));
	router.push(`/dashboard/campaigns/${created.result}/edit`);
}
</script>

<template>
	<div class="max-w-4xl mx-auto px-6 py-16 text-center">
		<UiIconBox icon="lucide:lock" size="xl" variant="surface" rounded="full" class="mb-4 mx-auto" />
		<p class="text-text-primary font-medium">
			{{ t('dashboard.campaigns.detail.edit.cannotEditTitle') }}
		</p>
		<p class="text-sm text-text-secondary mt-1">{{ description }}</p>
		<div class="mt-6 flex flex-wrap items-center justify-center gap-3">
			<UiButton :to="`/dashboard/campaigns/${campaignId}/report`">
				<template #iconLeft><Icon name="lucide:bar-chart-3" class="w-4 h-4" /></template>
				{{ t(`${K}.viewReport`) }}
			</UiButton>
			<UiButton variant="secondary" :loading="isDuplicating" @click="handleDuplicate">
				<template v-if="!isDuplicating" #iconLeft>
					<Icon name="lucide:copy" class="w-4 h-4" />
				</template>
				{{ t('common.duplicate') }}
			</UiButton>
			<UiButton variant="ghost" @click="emit('back')">
				{{ t('dashboard.campaigns.detail.edit.backToCampaigns') }}
			</UiButton>
		</div>
	</div>
</template>
