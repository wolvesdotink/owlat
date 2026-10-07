<script setup lang="ts">
/**
 * "Check this change" under a tracked item (review round 2 of the interpret
 * lane, F4): a later message seems to change the item (a new deadline, amount
 * or choice), but the claim could not be verified, so the item is unchanged
 * until someone confirms it. Shows the proposed values with their source
 * marker, and Confirm (the `confirmProposal` reaction, which applies them).
 */
import type { BriefItemView } from '../../../../api/convex/mail/interpret/briefShape';
import { briefDueDate } from '~/utils/threadBriefContext';
import { pendingCiteRef } from '~/utils/threadBriefItems';
import EvidenceMarker from './EvidenceMarker.vue';

const props = defineProps<{
	itemId: string;
	update: NonNullable<BriefItemView['pendingUpdate']>;
	/** Offer Confirm (not in read-only lists). */
	canConfirm?: boolean;
}>();

const emit = defineEmits<{ confirm: [] }>();

const { t, locale } = useI18n();

const changes = computed(() => {
	const out: string[] = [];
	const due = props.update.due;
	if (due) {
		const date = due.at !== undefined ? briefDueDate(due.at, locale.value) : due.phrase;
		out.push(t('components.brief.item.due', { date }));
	}
	const amount = props.update.amount;
	if (amount) {
		out.push(
			new Intl.NumberFormat(locale.value, { style: 'currency', currency: amount.currency }).format(
				amount.value
			)
		);
	}
	if (props.update.options?.length) {
		out.push(
			t('components.brief.item.pendingOptions', { options: props.update.options.join(' / ') })
		);
	}
	return out;
});
</script>

<template>
	<p
		class="mt-1 flex flex-wrap items-center gap-x-1.5 rounded bg-warning-subtle px-2 py-1 text-xs text-warning"
		data-testid="brief-item-pending"
	>
		<span class="font-medium">{{ t('components.brief.item.pendingChange') }}</span>
		<span v-for="(change, i) in changes" :key="i">{{ change }}</span>
		<EvidenceMarker
			v-if="update.evidence[0]"
			:evidence="update.evidence[0]"
			:cite-ref="pendingCiteRef(itemId)"
			:quote-index="0"
		/>
		<button
			v-if="canConfirm"
			type="button"
			class="ml-auto font-medium underline-offset-2 hover:underline"
			data-testid="brief-item-pending-confirm"
			@click="emit('confirm')"
		>
			{{ t('components.brief.item.confirmChange') }}
		</button>
	</p>
</template>
