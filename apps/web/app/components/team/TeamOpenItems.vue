<script setup lang="ts">
/**
 * "Open for the team", pinned above the team stream (plan §4.3): the actions
 * the customer's emails ask of the team, each with its owner, Claim and the
 * reactions. What the customer owes and what nobody can tell who owns stay
 * visible below, with that uncertainty said.
 *
 * It never claims "nothing to do" while the emails are not fully read: the
 * brief's own incomplete banner says so instead. With no interpretation at
 * all (AI off) the strip stays out of the way. On a phone the lists fold into
 * "2 open for the team" behind a disclosure.
 */
import type {
	BriefItemView,
	TeamOpenItemsView,
} from '../../../../api/convex/mail/interpret/briefShape';
import { provide } from 'vue';
import { isBriefComplete } from '~/utils/threadBriefBanners';
import { BRIEF_CONTEXT, type BriefSource } from '~/utils/threadBriefContext';
import { nextCursorOf } from '~/utils/threadBriefPages';
import { canUndoItem } from '~/utils/threadBriefItems';
import BriefIncomplete from '~/components/brief/BriefIncomplete.vue';
import TeamOpenItem, { type TeamItemAction, type TeamMember } from './TeamOpenItem.vue';

const props = withDefaults(
	defineProps<{
		view: TeamOpenItemsView | null | undefined;
		viewerId: string | null;
		members: readonly TeamMember[];
		noteCounts?: ReadonlyMap<string, number>;
		hideActions?: boolean;
		/** Who sent a message of the thread and when (the source markers). */
		sourceOf?: (messageId: string) => BriefSource | undefined;
	}>(),
	{ noteCounts: () => new Map(), hideActions: false, sourceOf: () => undefined }
);

const emit = defineEmits<{
	act: [item: BriefItemView, action: TeamItemAction];
	assign: [item: BriefItemView, userId: string | null];
	/** A source marker was clicked: show where the line comes from. */
	cite: [ref: string, quoteIndex: number];
}>();

provide(BRIEF_CONTEXT, {
	sourceOf: (id) => props.sourceOf(id),
	cite: (ref, quoteIndex) => emit('cite', ref, quoteIndex),
});

const { t } = useI18n();
const open = ref(false);

const forTeam = computed(() => props.view?.forTeam.filter((i) => i.status === 'open') ?? []);
const unclear = computed(() => props.view?.unclear.filter((i) => i.status === 'open') ?? []);
const waiting = computed(
	() => props.view?.waitingOnOthers.filter((i) => i.status === 'open') ?? []
);
/** Actions closed by a confirmation or a "done" the viewer can still take back. */
const recentlyClosed = computed(() =>
	[
		...(props.view?.forTeam ?? []),
		...(props.view?.unclear ?? []),
		...(props.view?.waitingOnOthers ?? []),
	].filter((i) => i.status !== 'open' && canUndoItem(i, i.stateKey))
);
const openCount = computed(() => props.view?.counts.forTeam ?? forTeam.value.length);
const isComplete = computed(() => !!props.view && isBriefComplete(props.view));
const isCut = computed(() => !!props.view && nextCursorOf(props.view) !== null);
const isShown = computed(() => {
	const v = props.view;
	if (!v) return false;
	return (
		v.completeness !== 'none' ||
		forTeam.value.length + unclear.value.length + waiting.value.length > 0 ||
		recentlyClosed.value.length > 0
	);
});
</script>

<template>
	<section
		v-if="isShown && view"
		class="rounded-(--radius-card) border border-border-subtle bg-bg-soft px-4 py-3"
		:aria-label="t('components.team.items.title')"
		data-testid="team-open-items"
	>
		<button
			type="button"
			class="flex w-full items-center gap-2 text-left sm:pointer-events-none"
			:aria-expanded="open"
			data-testid="team-open-items-toggle"
			@click="open = !open"
		>
			<h2 class="text-xs font-medium text-text-secondary">
				<span class="hidden uppercase tracking-wide sm:inline">{{
					t('components.team.items.title')
				}}</span>
				<span class="text-sm text-text-primary sm:hidden">{{
					t('components.team.items.phoneSummary', { count: openCount }, openCount)
				}}</span>
			</h2>
			<span
				class="ml-auto hidden text-xs text-text-tertiary sm:inline"
				data-testid="team-open-items-count"
				>{{ t('components.team.items.openCount', { count: openCount }, openCount) }}</span
			>
			<Icon
				name="lucide:chevron-down"
				class="ml-auto size-4 text-text-tertiary transition-transform sm:hidden"
				:class="{ 'rotate-180': open }"
				aria-hidden="true"
			/>
		</button>

		<div :class="{ 'hidden sm:block': !open }" class="mt-2">
			<BriefIncomplete v-if="!isComplete" :brief="view" class="mb-2" />
			<p
				v-if="isCut"
				role="status"
				class="mb-2 rounded-lg bg-bg-surface px-3 py-2 text-xs text-text-secondary"
			>
				{{ t('components.brief.items.pagesTruncated') }}
			</p>
			<ul v-if="forTeam.length > 0">
				<TeamOpenItem
					v-for="item in forTeam"
					:key="item.id"
					:item="item"
					:viewer-id="viewerId"
					:members="members"
					:note-count="noteCounts.get(item.id) ?? 0"
					:hide-actions="hideActions"
					@act="(action) => emit('act', item, action)"
					@assign="(userId) => emit('assign', item, userId)"
				/>
			</ul>
			<p
				v-else-if="isComplete && !isCut"
				class="text-sm text-text-tertiary"
				data-testid="team-open-items-empty"
			>
				{{ t('components.team.items.empty') }}
			</p>

			<template v-if="unclear.length > 0">
				<h3 class="mt-3 text-xs font-medium text-text-secondary">
					{{ t('components.team.items.unclearTitle') }}
				</h3>
				<ul data-testid="team-open-items-unclear">
					<TeamOpenItem
						v-for="item in unclear"
						:key="item.id"
						:item="item"
						:viewer-id="viewerId"
						:members="members"
						:note-count="noteCounts.get(item.id) ?? 0"
						:hide-actions="hideActions"
						@act="(action) => emit('act', item, action)"
						@assign="(userId) => emit('assign', item, userId)"
					/>
				</ul>
			</template>
			<template v-if="recentlyClosed.length > 0">
				<h3 class="mt-3 text-xs font-medium text-text-secondary">
					{{ t('components.team.items.closedTitle') }}
				</h3>
				<ul data-testid="team-open-items-closed">
					<TeamOpenItem
						v-for="item in recentlyClosed"
						:key="item.id"
						:item="item"
						:viewer-id="viewerId"
						:members="members"
						:hide-actions="hideActions"
						@act="(action) => emit('act', item, action)"
					/>
				</ul>
			</template>
			<template v-if="waiting.length > 0">
				<h3 class="mt-3 text-xs font-medium text-text-secondary">
					{{ t('components.team.items.waitingTitle') }}
				</h3>
				<ul data-testid="team-open-items-waiting">
					<TeamOpenItem
						v-for="item in waiting"
						:key="item.id"
						:item="item"
						:viewer-id="viewerId"
						:members="members"
						:note-count="noteCounts.get(item.id) ?? 0"
						:hide-actions="hideActions"
						@act="(action) => emit('act', item, action)"
					/>
				</ul>
			</template>
		</div>
	</section>
</template>
