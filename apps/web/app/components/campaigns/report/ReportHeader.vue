<script setup lang="ts">
// The campaign report's title block: Back, the name, which of the five states
// the send is in (badge and timing line), the recipient count once the send has
// started, the multi-day send plan and Duplicate.
import type { FunctionReturnType } from 'convex/server';
// TYPE-ONLY: the header needs the send plan's shape, never the client.
import type { api } from '@owlat/api';
import CampaignSendPlanLine from '~/components/campaigns/CampaignSendPlanLine.vue';
import { formatNumber } from '~/utils/formatters';
import {
	ArrowLeftIcon,
	CircleCheckIcon,
	CircleCloseIcon,
	ClockIcon,
	CopyIcon,
	FileTextIcon,
} from '@coolicons/vue';
import { SpinnerIcon } from '@owlat/ui/icons/SpinnerIcon';

const props = defineProps<{
	campaign: { name: string; sentAt?: number; scheduledAt?: number };
	reportStatus: 'draft' | 'scheduled' | 'sending' | 'sent' | 'cancelled';
	hasSendStarted: boolean;
	/** Everything dispatched to the provider. */
	sentCount: number;
	sendPlan:
		| FunctionReturnType<typeof api.campaigns.sendPlanQueries.getCampaignSendPlan>
		| undefined;
	isDuplicating: boolean;
}>();

const emit = defineEmits<{ duplicate: [] }>();

const { t } = useI18n();

const statusBadge = computed(() => {
	const prefix = 'dashboard.campaigns.detail.report.status';
	switch (props.reportStatus) {
		case 'sent':
			return {
				label: t('dashboard.campaigns.detail.report.sentBadge'),
				icon: CircleCheckIcon,
				tone: 'bg-success/10 text-success',
				spin: false,
			};
		case 'sending':
			return {
				label: t(`${prefix}.sending`),
				icon: SpinnerIcon,
				tone: 'bg-info/10 text-info',
				spin: true,
			};
		case 'scheduled':
			return {
				label: t(`${prefix}.scheduled`),
				icon: ClockIcon,
				tone: 'bg-info/10 text-info',
				spin: false,
			};
		case 'cancelled':
			return {
				label: t(`${prefix}.cancelled`),
				icon: CircleCloseIcon,
				tone: 'bg-error/10 text-error',
				spin: false,
			};
		default:
			return {
				label: t(`${prefix}.draft`),
				icon: FileTextIcon,
				tone: 'bg-bg-elevated text-text-secondary',
				spin: false,
			};
	}
});

/** The one timing line under the title — whichever instant this state has. */
const timingLine = computed(() => {
	const prefix = 'dashboard.campaigns.detail.report';
	switch (props.reportStatus) {
		case 'sent':
			return t(`${prefix}.sentAt`, { date: formatDateTime(props.campaign.sentAt) });
		case 'sending':
			return t(`${prefix}.startedAt`, { date: formatDateTime(props.campaign.sentAt) });
		case 'scheduled':
			return t(`${prefix}.scheduledFor`, { date: formatDateTime(props.campaign.scheduledAt) });
		case 'cancelled':
			return t(`${prefix}.cancelledLine`);
		default:
			return t(`${prefix}.notSentYet`);
	}
});
</script>

<template>
	<div class="mb-8">
		<NuxtLink
			to="/dashboard/campaigns"
			class="inline-flex items-center gap-2 text-text-secondary hover:text-text-primary text-sm mb-4 transition-colors duration-(--motion-fast)"
		>
			<ArrowLeftIcon class="w-4 h-4" />
			{{ t('dashboard.campaigns.detail.report.backToCampaigns') }}
		</NuxtLink>
		<UiPageHeader :title="campaign.name">
			<template #meta>
				<div class="text-text-secondary text-sm flex flex-wrap items-center gap-x-2 gap-y-1">
					<span
						:class="[
							'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium',
							statusBadge.tone,
						]"
					>
						<component
							:is="statusBadge.icon"
							:class="[
								'w-3 h-3',
								statusBadge.spin ? 'animate-spin motion-reduce:animate-none' : '',
							]"
							size="1em"
						/>
						{{ statusBadge.label }}
					</span>
					<span class="inline-flex items-center gap-1.5">
						<ClockIcon class="w-4 h-4" />
						{{ timingLine }}
					</span>
					<!-- A recipient count before the first message is dispatched is
					     just a zero pretending to be information. -->
					<template v-if="hasSendStarted">
						<span class="text-text-tertiary">·</span>
						<span class="tabular-nums">
							{{
								t('dashboard.campaigns.detail.report.recipients', {
									count: formatNumber(sentCount),
								})
							}}
						</span>
					</template>
				</div>
				<!--
					THE MULTI-DAY SEND PLAN, present from the moment the send starts. Renders nothing for an ordinary same-day send.
				-->
				<CampaignSendPlanLine :progress="sendPlan" class="mt-1" />
			</template>
			<template #actions>
				<UiButton
					variant="secondary"
					class="gap-2"
					:disabled="isDuplicating"
					@click="emit('duplicate')"
				>
					<SpinnerIcon v-if="isDuplicating" class="w-4 h-4" />
					<CopyIcon v-else class="w-4 h-4" />
					{{
						isDuplicating
							? t('dashboard.campaigns.detail.report.duplicating')
							: t('common.duplicate')
					}}
				</UiButton>
			</template>
		</UiPageHeader>
	</div>
</template>
