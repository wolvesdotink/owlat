<script setup lang="ts">
/**
 * The Overview of a personal Postbox thread (SPEC §7, plan §4.1): what is new,
 * where things stand, what is asked of you, what you are waiting for, and
 * what was done. Replaces the one-line AI strip in the reader and the
 * catch-up card in Answer mode.
 *
 * Presentational over semantic emits: the host runs reactions, shows cited
 * quotes and attaches files. Every line carries a source marker; the markers
 * read the thread's senders through `sourceOf`.
 *
 * On a phone (`compact`, or a narrow viewport when unset) "Latest update" and
 * the items come first and the rest folds into one disclosure (plan §7).
 *
 * `selectable` (Answer mode) turns the item rings into checkboxes, bound with
 * `v-model:selected`: the items the reply should cover.
 */
import type {
	BriefItemView,
	BriefModeView,
	FileView,
} from '../../../../api/convex/mail/interpret/briefShape';
import { provide } from 'vue';
import type { BriefAction } from '~/utils/threadBriefItems';
import { useMediaQuery } from '~/composables/useMediaQuery';
import { BRIEF_CONTEXT, type BriefSource } from '~/utils/threadBriefContext';
import { isBriefComplete } from '~/utils/threadBriefBanners';
import BriefActivity from './BriefActivity.vue';
import BriefFiles from './BriefFiles.vue';
import BriefIncomplete from './BriefIncomplete.vue';
import BriefItems from './BriefItems.vue';
import BriefLatest from './BriefLatest.vue';
import BriefParticipants from './BriefParticipants.vue';
import BriefStanding from './BriefStanding.vue';

const props = withDefaults(
	defineProps<{
		/** undefined while loading; null when the thread has no brief. */
		brief: BriefModeView | null | undefined;
		sourceOf?: (messageId: string) => BriefSource | undefined;
		selectable?: boolean;
		selected?: readonly string[];
		compact?: boolean;
		isSigned?: boolean;
		/** Items an unsent draft covers (Answer mode). */
		addressed?: readonly string[];
		/** What a file chip does, if anything. */
		fileAction?: 'attach' | 'open';
		/** "Jonas · today 09:12": who wrote the newest message. */
		latestNote?: string;
	}>(),
	{
		sourceOf: () => undefined,
		selected: () => [],
		compact: undefined,
		addressed: () => [],
		fileAction: undefined,
		latestNote: undefined,
	}
);

const emit = defineEmits<{
	react: [item: BriefItemView, action: BriefAction];
	cite: [ref: string, quoteIndex: number];
	'open-conversation': [];
	'update:selected': [ids: string[]];
	'select-file': [file: FileView];
}>();

const { t } = useI18n();

const narrow = useMediaQuery('(max-width: 639px)');
const isPhone = computed(() => props.compact ?? narrow.value);
const moreOpen = ref(false);
const showRest = computed(() => !isPhone.value || moreOpen.value);

provide(BRIEF_CONTEXT, {
	sourceOf: (id) => props.sourceOf(id),
	cite: (ref, quoteIndex) => emit('cite', ref, quoteIndex),
});

const hasBody = computed(() => !!props.brief && props.brief.completeness !== 'none');
const complete = computed(() => isBriefComplete(props.brief));
const selectedSet = computed(() => new Set(props.selected));
const addressedSet = computed(() => new Set(props.addressed));
const isLatestNew = computed(() => (props.brief?.sinceLastSeen?.newActivityCount ?? 0) > 0);

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
		data-testid="thread-brief"
		:aria-busy="brief === undefined"
	>
		<div v-if="brief === undefined" class="space-y-3" aria-hidden="true">
			<UiSkeleton class="h-3 w-28" />
			<UiSkeleton class="h-4 w-full" />
			<UiSkeleton class="h-4 w-4/5" />
			<UiSkeleton class="mt-4 h-3 w-20" />
			<UiSkeleton class="h-10 w-full" />
		</div>
		<template v-else>
			<BriefIncomplete
				:brief="brief"
				:is-signed="isSigned"
				:class="{ 'mb-4': hasBody }"
				@open-conversation="emit('open-conversation')"
			/>
			<template v-if="brief && hasBody">
				<BriefLatest :lines="brief.latest ?? []" :is-new="isLatestNew" :note="latestNote" />
				<BriefStanding v-if="brief.standing && showRest" :standing="brief.standing" />
				<BriefItems
					kind="forYou"
					:items="brief.forYou"
					show-empty
					:incomplete="!complete"
					:selectable="selectable"
					:selected="selectedSet"
					:addressed="addressedSet"
					:compact="isPhone"
					:hide-actions="selectable"
					@react="(item, action) => emit('react', item, action)"
					@toggle-select="toggle"
				/>
				<BriefItems
					kind="waiting"
					:items="brief.waitingOnOthers"
					:compact="isPhone"
					:hide-actions="selectable"
					@react="(item, action) => emit('react', item, action)"
				/>
				<BriefItems
					kind="unclear"
					:items="brief.unclear"
					:selectable="selectable"
					:selected="selectedSet"
					:compact="isPhone"
					:hide-actions="selectable"
					@react="(item, action) => emit('react', item, action)"
					@toggle-select="toggle"
				/>
				<template v-if="showRest">
					<BriefActivity :activity="brief.activity" />
					<div
						v-if="brief.participants.length > 0 || brief.files.length > 0"
						class="brief-pair grid gap-4 sm:grid-cols-2"
					>
						<BriefParticipants :participants="brief.participants" />
						<BriefFiles
							:files="brief.files"
							:action="fileAction"
							@select="(file) => emit('select-file', file)"
						/>
					</div>
				</template>
				<button
					v-else
					type="button"
					class="mt-3 flex w-full items-center gap-1 text-left text-xs text-text-tertiary"
					:aria-expanded="moreOpen"
					data-testid="brief-more"
					@click="moreOpen = true"
				>
					{{ t('components.brief.phone.more') }}
					<Icon name="lucide:chevron-right" class="size-3.5" aria-hidden="true" />
				</button>
			</template>
		</template>
		<slot name="footer" />
	</div>
</template>

<style scoped>
.brief-pair {
	margin-top: 1rem;
	padding-top: 0.875rem;
	border-top: 1px solid var(--color-border-subtle);
}
.brief-pair :deep(.brief-section + .brief-section) {
	margin-top: 0;
	padding-top: 0;
	border-top: 0;
}
</style>
