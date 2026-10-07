<script setup lang="ts">
/**
 * The actions of a shared (team) mailbox thread, for Answer mode (SPEC §7):
 * what is open for the team, what the other side owes, and what nobody owns
 * yet. Never a summary: no "Latest update", no "Where things stand"; the
 * originals stay the conversation beside it. The web-team lane replaces this
 * with the team stream and its pinned "Open for the team" strip.
 *
 * Read-only like the personal brief in Answer mode: the checkboxes are the
 * items the reply should cover (`v-model:selected`).
 */
import { provide } from 'vue';
import type {
	BriefItemView,
	TeamOpenItemsView,
} from '../../../../api/convex/mail/interpret/briefShape';
import { BRIEF_CONTEXT, type BriefSource } from '~/utils/threadBriefContext';
import { isBriefComplete } from '~/utils/threadBriefBanners';
import { nextCursorOf } from '~/utils/threadBriefPages';
import BriefIncomplete from './BriefIncomplete.vue';
import BriefItems from './BriefItems.vue';

const props = withDefaults(
	defineProps<{
		view: TeamOpenItemsView;
		sourceOf?: (messageId: string) => BriefSource | undefined;
		selected?: readonly string[];
	}>(),
	{ sourceOf: () => undefined, selected: () => [] }
);

const emit = defineEmits<{
	cite: [ref: string, quoteIndex: number];
	'update:selected': [ids: string[]];
}>();

provide(BRIEF_CONTEXT, {
	sourceOf: (id) => props.sourceOf(id),
	cite: (ref, quoteIndex) => emit('cite', ref, quoteIndex),
});

const selectedSet = computed(() => new Set(props.selected));
const hasBody = computed(() => props.view.completeness !== 'none');
/** Only the first item page is read here: more pages mean the lists are cut. */
const itemsState = computed(() => (nextCursorOf(props.view) ? 'truncated' : 'complete'));

function toggle(item: BriefItemView) {
	const next = new Set(selectedSet.value);
	if (next.has(item.id)) next.delete(item.id);
	else next.add(item.id);
	emit('update:selected', [...next]);
}
</script>

<template>
	<div
		class="rounded-xl border border-border-subtle bg-bg-elevated px-4 py-4 sm:px-[18px]"
		data-testid="brief-team-actions"
	>
		<BriefIncomplete :brief="view" :class="{ 'mb-4': hasBody }" />
		<template v-if="hasBody">
			<BriefItems
				kind="forTeam"
				:total="view.counts.forTeam"
				:items-state="itemsState"
				:items="view.forTeam"
				show-empty
				:incomplete="!isBriefComplete(view)"
				selectable
				:selected="selectedSet"
				hide-actions
				@toggle-select="toggle"
			/>
			<BriefItems
				kind="waiting"
				:items="view.waitingOnOthers"
				:total="view.counts.waitingOnOthers"
				:items-state="itemsState"
				hide-actions
			/>
			<BriefItems
				kind="unclear"
				:items="view.unclear"
				:total="view.counts.unclear"
				:items-state="itemsState"
				selectable
				:selected="selectedSet"
				hide-actions
				@toggle-select="toggle"
			/>
		</template>
	</div>
</template>
