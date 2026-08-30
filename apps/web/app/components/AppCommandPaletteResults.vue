<script setup lang="ts">
import type { PaletteGroup, PaletteItem } from '~/lib/commandPalette';
import type { QuickQueryAnswer } from '~/composables/useCommandPaletteAsk';
import type { PalettePrompt } from '~/composables/useCommandPaletteScope';
import { highlightSegments } from '~/lib/commandPalette';
import { SEARCH_MIN_QUERY } from '~/lib/commandPaletteCore';

/**
 * The command palette's result region: the grouped rows, and the three things
 * that stand in for them — the Ask answer, the spinner, and the empty state.
 *
 * Split out of `AppCommandPalette.vue` (file-size cap) as a purely presentational
 * child: it owns no state, reads no backend, and every selection leaves as an
 * event. The parent keeps the keyboard, the scope and the providers.
 */

defineProps<{
	/** Already gated, ordered and capped by the parent's provider pipeline. */
	groups: PaletteGroup[];
	/** Index into the FLATTENED row list — rows resolve their own via `indexById`. */
	activeIndex: number;
	indexById: Map<string, number>;
	/** What the fuzzy highlighter bolds in each label. */
	matchTerm: string;
	/** Which of the three stand-ins (if any) applies. */
	prompt: PalettePrompt;
	isSearching: boolean;
	hasRows: boolean;
	/** Ask scope only. */
	askAnswer: QuickQueryAnswer | null;
	askLoading: boolean;
}>();

defineEmits<{
	run: [item: PaletteItem];
	hover: [index: number];
	clearRecent: [];
}>();

const { t } = useI18n();
</script>

<template>
	<div id="app-cmdk-list" role="listbox" class="max-h-[60vh] overflow-y-auto py-2">
		<div v-for="group in groups" :key="group.key" class="mb-1">
			<div
				class="flex items-center justify-between px-4 py-1.5 text-xs font-medium text-text-tertiary uppercase tracking-wider"
			>
				<!-- Provider group headings are message keys (providers are pure
				     module-scope registries and cannot call `useI18n`); a heading a
				     provider still ships as literal text passes through unchanged. -->
				<span>{{ t(group.heading) }}</span>
				<button
					v-if="group.key === 'recent'"
					class="text-xs normal-case tracking-normal text-text-tertiary hover:text-text-primary transition-colors duration-(--motion-fast)"
					@click="$emit('clearRecent')"
				>
					{{ t('components.appCommandPalette.clearRecent') }}
				</button>
			</div>
			<button
				v-for="item in group.items"
				:id="`app-cmdk-opt-${indexById.get(item.id)}`"
				:key="item.id"
				type="button"
				role="option"
				:aria-selected="indexById.get(item.id) === activeIndex"
				class="w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors duration-(--motion-fast)"
				:class="
					indexById.get(item.id) === activeIndex
						? 'bg-bg-surface text-text-primary'
						: 'hover:bg-bg-surface text-text-secondary'
				"
				@click="$emit('run', item)"
				@mousemove="$emit('hover', indexById.get(item.id) ?? activeIndex)"
			>
				<Icon :name="item.icon" class="w-4 h-4 flex-shrink-0 text-text-tertiary" />
				<span class="flex-1 min-w-0">
					<span class="block text-sm truncate">
						<!-- The fuzzy scorer matched these characters; bolding them is what
						     makes a subsequence hit ("pbx" → Postbox) legible. -->
						<span
							v-for="(segment, segmentIndex) in highlightSegments(item.label, matchTerm)"
							:key="segmentIndex"
							:class="segment.isMatch ? 'font-semibold text-text-primary' : undefined"
							>{{ segment.text }}</span
						>
					</span>
					<span v-if="item.subtitle" class="block text-xs text-text-tertiary truncate">{{
						item.subtitle
					}}</span>
				</span>
				<Icon
					v-if="item.argument"
					name="lucide:chevron-right"
					class="w-4 h-4 flex-shrink-0 text-text-tertiary"
				/>
				<kbd
					v-else-if="item.hint"
					class="text-2xs text-text-tertiary border border-border-subtle rounded px-1"
					>{{ item.hint }}</kbd
				>
			</button>
		</div>

		<!-- Ask scope: one synthesized answer with its citations, where the Quick
		     Query modal used to be. -->
		<template v-if="prompt === 'ask'">
			<div v-if="askLoading" class="px-4 py-8 text-center text-text-tertiary">
				<UiSpinner class="mx-auto" size="sm" tone="brand" />
				<p class="mt-2 text-sm">{{ t('components.query.quickQueryPanel.searching') }}</p>
			</div>
			<div v-else-if="askAnswer" class="px-4 py-3">
				<QueryResult :answer="askAnswer.answer" :sources="askAnswer.sources" />
			</div>
			<div v-else class="px-4 py-8 text-center text-text-tertiary">
				<Icon name="lucide:sparkles" class="w-8 h-8 mx-auto mb-2 opacity-50" />
				<p class="text-sm">{{ t('components.query.quickQueryPanel.emptyTitle') }}</p>
				<p class="text-xs mt-1">{{ t('components.query.quickQueryPanel.emptyHint') }}</p>
			</div>
		</template>

		<div v-else-if="isSearching && !hasRows" class="px-4 py-8 text-center text-text-tertiary">
			<UiSpinner class="mx-auto" size="sm" tone="brand" />
			<p class="mt-2 text-sm">{{ t('components.appCommandPalette.searching') }}</p>
		</div>

		<div v-else-if="!hasRows" class="px-4 py-8 text-center text-text-tertiary">
			<Icon name="lucide:search" class="w-8 h-8 mx-auto mb-2 opacity-50" />
			<p class="text-sm">
				{{
					matchTerm.trim().length >= SEARCH_MIN_QUERY
						? t('components.appCommandPalette.noResults', { query: matchTerm })
						: t('components.appCommandPalette.noMatches')
				}}
			</p>
		</div>
	</div>
</template>
