<script setup lang="ts">
// The alerts above the campaign editor's form: a screening block that sent the
// campaign back to draft, a scheduled start that did not happen, the last
// save's error, what stops the campaign from going out, and the scheduled-send
// notice with Unschedule and Cancel (which says so when the start gate is
// holding a start past its time). Several roots, so each alert stays a
// direct child of the form's spaced column.
import {
	blockerFromStartRefusal,
	type SendBlocker,
	type StoredStartRefusal,
} from '~/lib/campaignRefusal';
import { activeStartHold, type StoredStartHold } from '~/utils/campaignStartHold';
import StartWaitingNote from '~/components/campaigns/StartWaitingNote.vue';
import { CircleWarningIcon, ClockIcon, ShieldWarningIcon } from '@coolicons/vue';

const props = defineProps<{
	contentBlockReason?: string;
	/** Why the last scheduled start did not happen; the campaign is a draft again. */
	startRefusal?: StoredStartRefusal | null;
	saveError: string | null | undefined;
	isScheduled: boolean;
	scheduledAt?: number;
	scheduledAtDisplay: string;
	isSaving: boolean;
	/** Why the campaign cannot go out as it stands, or `null`. */
	sendBlocker?: SendBlocker | null;
	/** The start gate's recorded wait, when it is holding this start. */
	startHold?: StoredStartHold | null;
}>();

const emit = defineEmits<{ unschedule: []; cancel: [] }>();

const { t, te, locale } = useI18n();

const startRefusalBlocker = computed(() =>
	props.startRefusal ? blockerFromStartRefusal(props.startRefusal, (key) => te(key)) : null
);
const waitingHold = computed(() =>
	props.isScheduled
		? activeStartHold({
				status: 'scheduled',
				scheduledAt: props.scheduledAt,
				startHold: props.startHold,
			})
		: null
);
const startRefusalDate = computed(() =>
	props.startRefusal ? new Date(props.startRefusal.scheduledAt).toLocaleString(locale.value) : ''
);
</script>

<template>
	<!-- Content Block Reason Alert (shown when campaign was blocked and reverted to draft) -->
	<div
		v-if="contentBlockReason"
		role="alert"
		class="p-4 bg-error/10 border border-error/20 rounded-lg flex items-start gap-3"
	>
		<ShieldWarningIcon class="w-5 h-5 text-error shrink-0 mt-0.5" />
		<div>
			<p class="text-sm font-medium text-text-primary">
				{{ t('dashboard.campaigns.detail.edit.contentBlocked.title') }}
			</p>
			<p class="text-sm text-text-secondary mt-1">
				{{ t('dashboard.campaigns.detail.edit.contentBlocked.description') }}
			</p>
			<p class="text-xs text-text-tertiary mt-1">
				{{ contentBlockReason }}
			</p>
		</div>
	</div>
	<!-- A scheduled start that did not happen: the stored refusal, in place. -->
	<div
		v-if="startRefusal && startRefusalBlocker"
		role="alert"
		class="p-4 bg-error/10 border border-error/20 rounded-lg flex items-start gap-3"
		data-testid="start-refused-notice"
	>
		<ClockIcon class="w-5 h-5 text-error shrink-0 mt-0.5" />
		<div class="min-w-0 flex-1 space-y-2">
			<p class="text-sm font-medium text-text-primary">
				{{ t('dashboard.campaigns.detail.edit.startRefused.title') }}
			</p>
			<p class="text-sm text-text-secondary">
				{{
					t('dashboard.campaigns.detail.edit.startRefused.description', { date: startRefusalDate })
				}}
			</p>
			<CampaignsSendBlockedNote :blocker="startRefusalBlocker" />
		</div>
	</div>
	<!-- Error Alert -->
	<div
		v-if="saveError"
		role="alert"
		class="p-4 bg-error/10 border border-error/20 rounded-lg flex items-start gap-3"
	>
		<CircleWarningIcon class="w-5 h-5 text-error shrink-0 mt-0.5" />
		<div>
			<p class="text-sm font-medium text-error">{{ t('common.error') }}</p>
			<p class="text-sm text-text-secondary">{{ saveError }}</p>
		</div>
	</div>

	<!-- Always in the DOM, so a blocker that appears or clears while the sender
	     is edited is announced. Empty, it takes no space in the spaced column. -->
	<div role="status" class="empty:hidden">
		<CampaignsSendBlockedNote v-if="sendBlocker" :blocker="sendBlocker" />
	</div>

	<!-- Scheduled Campaign Notice. Past its time and held by the start gate, it
	     says it is waiting, why, and until when; the status region is always in
	     the DOM so that change is announced. -->
	<div
		v-if="isScheduled && scheduledAt"
		class="p-4 border rounded-lg"
		:class="waitingHold ? 'bg-warning/10 border-warning/20' : 'bg-brand/10 border-brand/20'"
	>
		<div class="flex items-start gap-3">
			<ClockIcon
				class="w-5 h-5 shrink-0 mt-0.5"
				:class="waitingHold ? 'text-warning' : 'text-brand'"
			/>
			<div class="flex-1">
				<div role="status" data-testid="start-waiting" class="space-y-1 empty:hidden">
					<template v-if="waitingHold">
						<p class="text-sm font-medium text-text-primary">
							{{ t('shared.campaignStartHold.title') }}
						</p>
						<StartWaitingNote :hold="waitingHold" />
					</template>
				</div>
				<p v-if="!waitingHold" class="text-sm font-medium text-text-primary">
					{{ t('dashboard.campaigns.detail.edit.scheduledNotice.title') }}
				</p>
				<I18nT
					v-if="!waitingHold"
					keypath="dashboard.campaigns.detail.edit.scheduledNotice.description"
					tag="p"
					class="text-sm text-text-secondary mt-1"
					scope="global"
				>
					<template #date>
						<span class="font-medium">{{ scheduledAtDisplay }}</span>
					</template>
				</I18nT>
				<!-- Unschedule is the reversible way out; Cancel is terminal and asks first (the page confirms). -->
				<div class="flex flex-wrap gap-2 mt-3">
					<UiButton variant="secondary" size="sm" :disabled="isSaving" @click="emit('unschedule')">
						{{ t('dashboard.campaigns.detail.edit.scheduledNotice.unschedule') }}
					</UiButton>
					<UiButton variant="danger-ghost" size="sm" :disabled="isSaving" @click="emit('cancel')">
						{{ t('dashboard.campaigns.detail.edit.scheduledNotice.cancelCampaign') }}
					</UiButton>
				</div>
			</div>
		</div>
	</div>
</template>
