<script setup lang="ts">
/**
 * One sender on the Senders page: who it is, how much it sent in
 * about 90 days, how much of that was read (the bar), its kind, and the
 * Keep / Digest / Auto-archive / Unsubscribe control the arrival ladder obeys.
 *
 * Below the name: the unsubscribe result, the "drafts paused" marker lane
 * drafts writes (with Resume), and on the To review tab what the suggestion
 * would set, with "Keep as is" to turn the suggestion down (a user Keep).
 * The row emits; the panel runs the server calls.
 */
import {
	SENDER_STATUSES,
	senderName,
	senderReadPercent,
	suggestedStatus,
	unsubscribeResultKey,
	type PostboxSenderRow,
	type PostboxSenderStatus,
} from '~/utils/postboxSenders';

const props = defineProps<{ row: PostboxSenderRow; busy?: boolean }>();

const emit = defineEmits<{
	setStatus: [status: PostboxSenderStatus];
	resume: [];
}>();

const { t } = useI18n();

const name = computed(() => senderName(props.row));
const readPercent = computed(() => senderReadPercent(props.row));
const resultKey = computed(() => unsubscribeResultKey(props.row));

const options = computed(() =>
	SENDER_STATUSES.map((status) => ({
		value: status,
		label: t(`postbox.senders.status.${status}`),
		disabled: props.busy,
	}))
);

function onStatus(value: string) {
	const status = SENDER_STATUSES.find((candidate) => candidate === value);
	if (status && status !== props.row.status) emit('setStatus', status);
}
</script>

<template>
	<!-- Below md the row is a stacked card (the table's cells become flex items):
	     name and address; "N mails · read X%", the bar and the kind on one line;
	     the control full width; then the suggestion with "Keep as is" and the
	     markers. The first cell is `display: contents` there so its lines can
	     take their place in that order. From md up it is the table row. -->
	<tr class="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-3 md:table-row md:py-0 md:align-top">
		<td class="contents md:table-cell md:py-3 md:pr-3 md:min-w-0">
			<p class="w-full text-sm font-medium text-text-primary truncate" :title="row.address">
				{{ name }}
			</p>
			<p v-if="row.displayName" class="w-full text-xs text-text-tertiary truncate">
				{{ row.address }}
			</p>
			<p
				v-if="row.suggestion"
				class="order-last md:order-none w-full text-xs text-brand md:mt-0.5 flex flex-wrap items-center gap-x-1.5"
			>
				{{
					t('postbox.senders.suggested', {
						status: t(`postbox.senders.status.${suggestedStatus(row.suggestion)}`),
					})
				}}
				<!-- Keep is already the selected segment, so the control cannot say
				     "I chose Keep": this records it, and the suggestion goes away. -->
				<button
					type="button"
					class="text-text-secondary font-medium whitespace-nowrap hover:underline disabled:opacity-50"
					:disabled="busy"
					:title="t('postbox.senders.keepAsIsTitle')"
					data-testid="sender-keep-as-is"
					@click="emit('setStatus', 'keep')"
				>
					{{ t('postbox.senders.keepAsIs') }}
				</button>
			</p>
			<p
				v-if="resultKey"
				class="order-last md:order-none w-full text-xs text-text-secondary md:mt-0.5"
			>
				{{ t(resultKey) }}
			</p>
			<p
				v-if="row.autoDraftPausedAt !== undefined"
				class="order-last md:order-none w-full text-xs text-text-secondary md:mt-0.5 flex items-center gap-1.5"
			>
				<Icon name="lucide:pause" class="w-3 h-3" aria-hidden="true" />
				{{ t('postbox.senders.draftsPaused') }}
				<button
					type="button"
					class="text-brand font-medium hover:underline disabled:opacity-50"
					:disabled="busy"
					@click="emit('resume')"
				>
					{{ t('postbox.senders.resume') }}
				</button>
			</p>
		</td>
		<td class="md:py-3 md:pr-3 text-xs md:text-sm tabular-nums text-text-secondary">
			<span class="hidden md:inline">{{ row.delivered }}</span>
			<span class="md:hidden whitespace-nowrap" data-testid="sender-phone-stats">
				{{
					t(
						'postbox.senders.phoneStats',
						{ count: row.delivered, percent: readPercent },
						row.delivered
					)
				}}
			</span>
		</td>
		<td class="md:py-3 md:pr-3">
			<span
				class="inline-flex items-center gap-2 text-sm tabular-nums text-text-secondary"
				:title="t('postbox.senders.readTitle', { opened: row.opened, delivered: row.delivered })"
			>
				<span
					class="relative inline-block w-14 h-1.5 rounded-full bg-bg-surface overflow-hidden"
					role="img"
					:aria-label="t('postbox.senders.readPercent', { percent: readPercent })"
				>
					<span class="absolute inset-y-0 left-0 bg-brand" :style="{ width: `${readPercent}%` }" />
				</span>
				<span class="hidden md:inline">{{ row.opened }}</span>
			</span>
		</td>
		<td class="md:py-3 md:pr-3 text-xs md:text-sm text-text-secondary">
			{{ row.kind ? t(`postbox.senders.kind.${row.kind}`) : t('postbox.senders.kind.unknown') }}
		</td>
		<td
			class="w-full max-w-full overflow-x-auto max-md:mt-1 md:w-auto md:max-w-none md:overflow-visible md:py-3"
		>
			<UiSegmentedControl
				:model-value="row.status"
				:options="options"
				size="sm"
				fit="content"
				class="max-md:w-full!"
				:aria-label="t('postbox.senders.controlLabel', { name })"
				@update:model-value="onStatus"
			/>
		</td>
	</tr>
</template>
