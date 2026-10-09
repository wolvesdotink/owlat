<script setup lang="ts">
/**
 * "Check this change" under a tracked item (review round 2 of the interpret
 * lane, F4): a later message seems to change the item (a new deadline, amount
 * or choice), but the claim could not be verified, so the item is unchanged
 * until someone confirms it. Shows EVERY change Confirm would apply (wording,
 * parties, who does it, due, amount, choices as old → new, and removals),
 * with the source marker, and Confirm (`confirmProposal`).
 *
 * A held transition (`transitions`: a later message may have closed or
 * answered the item, matched by wording only) reads "A later message may have
 * settled this" with the same marker and Confirm; it applies only on confirm,
 * and Undo reverses it. Used by the personal brief and the team strip.
 */
import type { BriefItemView } from '../../../../api/convex/mail/interpret/briefShape';
import { pendingChangeLines } from '~/utils/threadBriefPending';
import { pendingCiteRef } from '~/utils/threadBriefItems';
import EvidenceMarker from './EvidenceMarker.vue';

const props = defineProps<{
	itemId: string;
	update: NonNullable<BriefItemView['pendingUpdate']>;
	/** The item as it stands, for "old → new". */
	item?: BriefItemView;
	/** Offer Confirm (not in read-only lists). */
	canConfirm?: boolean;
}>();

const emit = defineEmits<{ confirm: [] }>();

const { t, locale } = useI18n();

/** Every change Confirm would apply: wording, parties, due, amount, choices, removals. */
const changes = computed(() =>
	pendingChangeLines(props.item ?? null, props.update, { t, locale: locale.value })
);
/** A later message may have closed or answered the item (held until confirmed). */
const isSettling = computed(() => (props.update.transitions?.length ?? 0) > 0);
</script>

<template>
	<p
		class="mt-1 flex flex-wrap items-center gap-x-1.5 rounded bg-warning-subtle px-2 py-1 text-xs text-warning"
		data-testid="brief-item-pending"
	>
		<span v-if="changes.length > 0" class="font-medium">{{
			t('components.brief.item.pendingChange')
		}}</span>
		<span v-for="(change, i) in changes" :key="i">{{ change }}</span>
		<span
			v-if="isSettling"
			:class="{ 'font-medium': changes.length === 0 }"
			data-testid="brief-item-pending-settled"
			>{{ t('components.brief.item.maybeSettled') }}</span
		>
		<EvidenceMarker
			v-if="update.evidence[0]"
			:evidence="update.evidence[0]"
			:cite-ref="pendingCiteRef(itemId)"
			:quote-index="0"
		/>
		<button
			v-if="canConfirm && (changes.length > 0 || isSettling)"
			type="button"
			class="ml-auto font-medium underline-offset-2 hover:underline"
			data-testid="brief-item-pending-confirm"
			@click="emit('confirm')"
		>
			{{
				changes.length > 0
					? t('components.brief.item.confirmChange')
					: t('components.brief.item.confirmSettled')
			}}
		</button>
	</p>
</template>
