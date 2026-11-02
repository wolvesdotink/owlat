<script setup lang="ts">
import type { PaletteGroup, PaletteItem } from '~/lib/commandPalette';
import type { QuickQueryAnswer } from '~/composables/useCommandPaletteAsk';
import type { PalettePrompt } from '~/composables/useCommandPaletteScope';
import { highlightSegments } from '~/lib/commandPalette';
import { SEARCH_MIN_QUERY } from '~/lib/commandPaletteCore';
import { useShortcutLabels } from '~/composables/useShortcutLabels';

/**
 * The command palette's result region: the grouped rows, and the three things
 * that stand in for them — the Ask answer, the spinner, and the empty state.
 * Mail scope's empty box also gets a legend of the mode prefixes.
 *
 * Split out of `AppCommandPalette.vue` (file-size cap) as a purely presentational
 * child: it owns no state, reads no backend, and every selection leaves as an
 * event. The parent keeps the keyboard, the scope and the providers.
 */

const props = defineProps<{
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
	/** Whether `?` asks knowledge here; with the flag off the legend leaves it out. */
	askAvailable: boolean;
}>();

defineEmits<{
	run: [item: PaletteItem];
	hover: [index: number];
	clearRecent: [];
}>();

const { t } = useI18n();
const { labelFor } = useShortcutLabels();

const PREFIX_LEGEND = [
	{ prefix: '>', labelKey: 'components.appCommandPalette.prefixes.commands' },
	{ prefix: '@', labelKey: 'components.appCommandPalette.prefixes.people' },
	{ prefix: '#', labelKey: 'components.appCommandPalette.prefixes.labels' },
	{ prefix: '?', labelKey: 'components.appCommandPalette.prefixes.ask' },
] as const;

/**
 * Shown under the starting points of an empty Mail box. The footer only lists
 * the four characters, which says nothing about what each one does.
 */
const prefixLegend = computed(() =>
	props.prompt === 'mailSearch' && !props.matchTerm.trim()
		? PREFIX_LEGEND.filter((entry) => entry.prefix !== '?' || props.askAvailable)
		: []
);

/** The row's key chip: its catalog shortcut as bound right now, else its literal hint. */
function hintFor(item: PaletteItem): string | null {
	if (item.shortcutId) return labelFor(item.shortcutId);
	return item.hint ?? null;
}
</script>

<template>
	<div class="max-h-[60vh] overflow-y-auto py-2">
		<div id="app-cmdk-list" role="listbox">
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
						v-else-if="hintFor(item)"
						class="text-2xs text-text-tertiary border border-border-subtle rounded px-1"
						>{{ hintFor(item) }}</kbd
					>
				</button>
			</div>

			<!-- Ask scope: one synthesized answer with its citations, inside the
		     palette rather than in a modal of its own. -->
			<template v-if="prompt === 'ask'">
				<div v-if="askLoading" class="px-4 py-8 text-center text-text-tertiary">
					<UiSpinner class="mx-auto" size="sm" tone="brand" />
					<p class="mt-2 text-sm">{{ t('components.query.quickQueryPanel.searching') }}</p>
				</div>
				<div v-else-if="askAnswer" class="px-4 py-3">
					<QueryResult
						:answer="askAnswer.answer"
						:sources="askAnswer.sources"
						:is-truncated="askAnswer.isTruncated === true"
					/>
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

			<!-- An empty box has searched for nothing, so it never says "no matches".
			     One Mail character has not searched yet either: the hits wait for two. -->
			<div
				v-else-if="!hasRows && matchTerm.trim()"
				class="px-4 py-8 text-center text-text-tertiary"
			>
				<Icon name="lucide:search" class="w-8 h-8 mx-auto mb-2 opacity-50" />
				<p class="text-sm">
					{{
						matchTerm.trim().length >= SEARCH_MIN_QUERY
							? t('components.appCommandPalette.noResults', { query: matchTerm })
							: prompt === 'mailSearch'
								? t('components.appCommandPalette.keepTyping')
								: t('components.appCommandPalette.noMatches')
					}}
				</p>
			</div>
		</div>

		<!-- Outside the listbox: a legend is not an option to pick. -->
		<div
			v-if="prefixLegend.length > 0"
			class="mx-4 mt-1 pt-2 border-t border-border-subtle text-xs text-text-tertiary"
		>
			<p class="py-1.5 font-medium uppercase tracking-wider">
				{{ t('components.appCommandPalette.prefixes.heading') }}
			</p>
			<dl class="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5 pb-1">
				<template v-for="entry in prefixLegend" :key="entry.prefix">
					<dt>
						<kbd
							class="inline-flex justify-center min-w-5 px-1 py-0.5 bg-bg-surface border border-border-subtle rounded text-2xs"
							>{{ entry.prefix }}</kbd
						>
					</dt>
					<dd class="text-text-secondary">{{ t(entry.labelKey) }}</dd>
				</template>
			</dl>
		</div>
	</div>
</template>
