<script setup lang="ts">
/**
 * A list of items under its heading: "For you", "Waiting on others" or
 * "Unclear who should act" (plan §4.1).
 *
 * The empty "For you" says so only when the brief is complete AND every item
 * page is in: an incomplete brief never claims there is nothing to do (plan
 * §8). The heading counts come from the thread's maintained counters
 * (`total`), not from the items loaded so far; while more pages are on their
 * way, or the walk was cut, the list says so.
 */
import type { BriefItemView } from '../../../../api/convex/mail/interpret/briefShape';
import type { BriefAction } from '~/utils/threadBriefItems';
import type { BriefItemsState } from '~/utils/threadBriefPages';
import BriefItem from './BriefItem.vue';
import BriefSection from './BriefSection.vue';

const props = defineProps<{
	kind: 'forYou' | 'forTeam' | 'waiting' | 'unclear';
	items: readonly BriefItemView[];
	/** Show the empty state (For you only); `incomplete` picks its wording. */
	showEmpty?: boolean;
	incomplete?: boolean;
	selectable?: boolean;
	selected?: ReadonlySet<string>;
	compact?: boolean;
	/** Items an unsent draft covers. */
	addressed?: ReadonlySet<string>;
	hideActions?: boolean;
	/** Open items of this list per the maintained counters (the heading count). */
	total?: number;
	/** Whether every item page is in. */
	itemsState?: BriefItemsState;
}>();

const emit = defineEmits<{
	react: [item: BriefItemView, action: BriefAction];
	'toggle-select': [item: BriefItemView];
}>();

const { t } = useI18n();

const title = computed(() => t(`components.brief.items.${props.kind}`));
const openCount = computed(
	() => props.total ?? props.items.filter((i) => i.status === 'open').length
);
const loadedOpen = computed(() => props.items.filter((i) => i.status === 'open').length);
const state = computed<BriefItemsState>(() => props.itemsState ?? 'complete');
/** Open items the counters know of that are not on screen yet. */
const isShort = computed(() => state.value !== 'complete' && loadedOpen.value < openCount.value);
const note = computed(() =>
	props.kind === 'forYou' || props.kind === 'forTeam'
		? t('components.brief.items.openCount', { count: openCount.value }, openCount.value)
		: openCount.value > 0
			? String(openCount.value)
			: ''
);
</script>

<template>
	<BriefSection
		v-if="items.length > 0 || showEmpty || isShort"
		:title="title"
		:note="items.length > 0 || isShort ? note : undefined"
		:heading-id="`brief-${kind}`"
	>
		<ul v-if="items.length > 0" :data-testid="`brief-items-${kind}`">
			<BriefItem
				v-for="item in items"
				:key="item.id"
				:item="item"
				:selectable="selectable"
				:selected="selected?.has(item.id)"
				:compact="compact"
				:addressed-in-draft="addressed?.has(item.id)"
				:hide-actions="hideActions"
				@react="(action) => emit('react', item, action)"
				@toggle-select="emit('toggle-select', item)"
			/>
		</ul>
		<p
			v-if="isShort"
			class="text-sm text-text-secondary"
			role="status"
			:data-testid="`brief-items-${kind}-more`"
		>
			{{
				state === 'loading'
					? t('components.brief.items.loadingMore')
					: t('components.brief.items.truncated')
			}}
		</p>
		<p
			v-else-if="items.length === 0"
			class="text-sm text-text-secondary"
			:data-testid="`brief-items-${kind}-empty`"
		>
			{{
				incomplete
					? t('components.brief.items.emptyIncomplete')
					: kind === 'forTeam'
						? t('components.brief.items.emptyTeam')
						: t('components.brief.items.empty')
			}}
		</p>
	</BriefSection>
</template>
