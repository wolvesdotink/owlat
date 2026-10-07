<script setup lang="ts">
/**
 * One item of the brief (plan §5): a ring that says its state, the text, a
 * line with the due date (in red), what kind of ask it is and its source
 * marker, then ONE primary reaction and a ⋯ menu with the rest.
 *
 * None of the reactions sends anything: replying ones open Answer mode, the
 * others are the viewer's statements about the item (Mark done, Stop
 * tracking), and those can be undone. The component only emits; the host
 * runs them.
 *
 * `selectable` (Answer mode) swaps the ring for a checkbox: the items the
 * reply should cover. An unconfirmed proposal ("Check this") offers Track
 * instead of a reaction: it is not tracked until someone confirms it.
 */
import type { BriefItemView } from '../../../../api/convex/mail/interpret/briefShape';
import { itemStateKey } from '@owlat/shared/threadBriefRules';
import {
	briefRing,
	canUndo,
	menuReactions,
	showsStateChip,
	type BriefAction,
} from '~/utils/threadBriefItems';
import { briefDueDate } from '~/utils/threadBriefContext';
import EvidenceMarker from './EvidenceMarker.vue';

const props = defineProps<{
	item: BriefItemView;
	selectable?: boolean;
	selected?: boolean;
	/** Phone: the primary reaction moves into the ⋯ menu. */
	compact?: boolean;
	/** An unsent draft covers it (from the draft's response plan). */
	addressedInDraft?: boolean;
	/** Read-only (Answer mode): no reactions. */
	hideActions?: boolean;
}>();

const emit = defineEmits<{
	react: [action: BriefAction];
	'toggle-select': [];
}>();

const { t, locale } = useI18n();

const stateKey = computed(() =>
	props.addressedInDraft && props.item.status === 'open'
		? itemStateKey(props.item, { addressedInDraft: true })
		: props.item.stateKey
);
const ring = computed(() => briefRing(props.item, stateKey.value));
const isProposal = computed(() => props.item.verify === 'proposal');
const isOpen = computed(() => props.item.status === 'open');
const due = computed(() =>
	props.item.due?.at !== undefined ? briefDueDate(props.item.due.at, locale.value) : null
);
const kinds = computed(() =>
	[
		t(`components.brief.intent.${props.item.intent}`),
		...props.item.facets.map((f) => t(`components.brief.facet.${f}`)),
	].join(' · ')
);
const menu = computed<BriefAction[]>(() => {
	if (!isOpen.value) return canUndo(stateKey.value) ? ['undo'] : [];
	const rest: BriefAction[] = menuReactions(props.item);
	if (props.compact && !isProposal.value) rest.unshift(props.item.primaryReaction);
	return rest;
});
const primary = computed<BriefAction | null>(() => {
	if (!isOpen.value) return null;
	return isProposal.value ? 'confirmProposal' : props.item.primaryReaction;
});

function actionLabel(action: BriefAction): string {
	if (action === 'undo') return t('components.brief.item.undo');
	if (action === 'confirmProposal') return t('components.brief.item.track');
	return t(`components.brief.reaction.${action}`);
}

const RING_CLASS: Record<ReturnType<typeof briefRing>, string> = {
	open: 'border-border-strong',
	waiting: 'border-dashed border-border-strong',
	proposal: 'border-dotted border-border-strong',
	half: 'border-warning brief-ring-half',
	done: 'border-success bg-success',
	declined: 'border-text-tertiary brief-ring-declined',
	replaced: 'border-text-tertiary bg-bg-surface',
};
</script>

<template>
	<li
		class="grid grid-cols-[18px_minmax(0,1fr)_auto] items-start gap-2.5 border-t border-border-subtle py-2 first:border-t-0 first:pt-0.5"
		:class="{ 'opacity-70': !isOpen }"
		data-testid="brief-item"
		:data-state="stateKey"
	>
		<input
			v-if="selectable"
			type="checkbox"
			class="mt-0.5 size-4 rounded border-border-default text-brand focus:ring-brand"
			:checked="selected"
			:aria-label="t('components.brief.item.select', { item: item.text })"
			data-testid="brief-item-select"
			@change="emit('toggle-select')"
		/>
		<span
			v-else
			class="mt-0.5 size-[15px] rounded-full border-[1.5px]"
			:class="RING_CLASS[ring]"
			aria-hidden="true"
			data-testid="brief-item-ring"
			:data-ring="ring"
		/>
		<div class="min-w-0">
			<p class="text-sm text-text-primary">
				{{ isProposal ? `${t('components.brief.item.checkThis')} ${item.text}` : item.text }}
			</p>
			<p class="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-text-tertiary">
				<span v-if="due && isOpen" class="font-medium text-error">{{
					t('components.brief.item.due', { date: due })
				}}</span>
				<span v-if="isProposal">{{ t('components.brief.item.proposal') }}</span>
				<span v-else>{{ kinds }}</span>
				<span
					v-if="showsStateChip(stateKey)"
					class="rounded-full bg-bg-surface px-1.5 text-2xs font-medium text-text-secondary"
					data-testid="brief-item-state"
					>{{ t(`components.brief.state.${stateKey}`) }}</span
				>
				<span v-if="item.isReviewNeeded" class="text-warning">{{
					t('components.brief.item.review')
				}}</span>
				<span v-if="item.possibleDuplicateOfId">{{ t('components.brief.item.duplicate') }}</span>
				<span v-if="item.isNew" class="font-medium text-brand">{{
					t('components.brief.item.new')
				}}</span>
				<EvidenceMarker
					v-if="item.evidence[0]"
					:evidence="item.evidence[0]"
					:cite-ref="item.id"
					:quote-index="0"
				/>
			</p>
		</div>
		<div v-if="!selectable && !hideActions" class="flex items-center gap-1.5">
			<UiButton
				v-if="primary && !compact"
				size="sm"
				variant="ghost"
				data-testid="brief-item-primary"
				@click="emit('react', primary)"
			>
				{{ actionLabel(primary) }}
			</UiButton>
			<PostboxOverflowMenu
				v-if="menu.length > 0"
				:label="t('components.brief.item.menu', { item: item.text })"
			>
				<template #default="{ close }">
					<button
						v-for="action in menu"
						:key="action"
						type="button"
						role="menuitem"
						class="flex w-full items-center px-3 py-1.5 text-left text-sm whitespace-nowrap text-text-primary hover:bg-bg-surface"
						:data-action="action"
						@click="
							emit('react', action);
							close();
						"
					>
						{{ actionLabel(action) }}
					</button>
					<p v-if="isOpen" class="max-w-56 px-3 pb-1.5 pt-1 text-2xs text-text-tertiary">
						{{ t('components.brief.item.menuHint') }}
					</p>
				</template>
			</PostboxOverflowMenu>
		</div>
	</li>
</template>

<style scoped>
.brief-ring-half {
	background: linear-gradient(90deg, var(--color-warning) 50%, transparent 50%);
}
.brief-ring-declined {
	background: linear-gradient(
		135deg,
		transparent 45%,
		var(--color-text-tertiary) 45%,
		var(--color-text-tertiary) 55%,
		transparent 55%
	);
}
</style>
