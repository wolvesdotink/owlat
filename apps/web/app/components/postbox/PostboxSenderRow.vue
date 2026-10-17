<script setup lang="ts">
/**
 * One sender on the Senders page (SPEC §5): who it is, how much it sent in
 * about 90 days, how much of that was read (the bar), its kind, and the
 * Keep / Digest / Auto-archive / Unsubscribe control the arrival ladder obeys.
 *
 * Below the name: the unsubscribe result, the "drafts paused" marker lane
 * drafts writes (with Resume), and on the To review tab what the suggestion
 * would set. The row emits; the panel runs the server calls.
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
	<tr class="align-top">
		<td class="py-3 pr-3 min-w-0">
			<p class="text-sm font-medium text-text-primary truncate" :title="row.address">
				{{ name }}
			</p>
			<p v-if="row.displayName" class="text-xs text-text-tertiary truncate">{{ row.address }}</p>
			<p v-if="row.suggestion" class="text-xs text-brand mt-0.5">
				{{
					t('postbox.senders.suggested', {
						status: t(`postbox.senders.status.${suggestedStatus(row.suggestion)}`),
					})
				}}
			</p>
			<p v-if="resultKey" class="text-xs text-text-secondary mt-0.5">{{ t(resultKey) }}</p>
			<p
				v-if="row.autoDraftPausedAt !== undefined"
				class="text-xs text-text-secondary mt-0.5 flex items-center gap-1.5"
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
		<td class="py-3 pr-3 text-sm tabular-nums text-text-secondary">{{ row.delivered }}</td>
		<td class="py-3 pr-3">
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
				{{ row.opened }}
			</span>
		</td>
		<td class="py-3 pr-3 text-sm text-text-secondary">
			{{ row.kind ? t(`postbox.senders.kind.${row.kind}`) : t('postbox.senders.kind.unknown') }}
		</td>
		<td class="py-3">
			<UiSegmentedControl
				:model-value="row.status"
				:options="options"
				size="sm"
				fit="content"
				:aria-label="t('postbox.senders.controlLabel', { name })"
				@update:model-value="onStatus"
			/>
		</td>
	</tr>
</template>
