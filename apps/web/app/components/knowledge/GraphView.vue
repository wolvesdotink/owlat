<script setup lang="ts">
/**
 * <KnowledgeGraphView> — the read-only knowledge-graph dashboard container.
 *
 * Gated on `ai.knowledge.analytics`: when the flag is off the canvas/insights are
 * never rendered (and the snapshot/subgraph reads are skipped in the composable).
 * Composes the force-directed <KnowledgeGraphCanvas>, the <KnowledgeGraphStatsPanel>
 * insight layer, and a click-through side panel that reuses `getEntry` +
 * <KnowledgeRelationsList> exactly like the entry detail page.
 */
import { ENTRY_TYPES, TYPE_CONFIG, type EntryType } from '~/utils/knowledgeEntryTypes';

const {
	analyticsEnabled,
	stats,
	graph,
	depth,
	entryTypeFilter,
	isLoading,
	selectedNodeId,
	selectedEntry,
	selectedOutgoing,
	selectedIncoming,
	selectedEntryMap,
	selectNode,
	clearSelection,
	focusNode,
	typeVariant,
	typeIcon,
	typeLabel,
} = useKnowledgeGraphView();

const typeFilters = computed(() => [
	{ key: null as EntryType | null, label: 'All' },
	...ENTRY_TYPES.map((t) => ({ key: t as EntryType | null, label: TYPE_CONFIG[t].label })),
]);
</script>

<template>
	<!-- Flag gate: the view renders only when ai.knowledge.analytics is on. -->
	<div
		v-if="!analyticsEnabled"
		class="flex flex-col items-center justify-center py-20 text-center"
	>
		<div class="w-14 h-14 rounded-full bg-bg-surface border border-border-subtle flex items-center justify-center mb-4">
			<Icon name="lucide:bar-chart-3" class="w-7 h-7 text-text-tertiary" />
		</div>
		<h3 class="text-base font-medium text-text-primary">Graph analytics are off</h3>
		<p class="text-sm text-text-secondary mt-1 max-w-sm">
			Enable <span class="font-medium">Knowledge graph analytics</span> in Settings to view the
			graph and its insights.
		</p>
	</div>

	<div v-else class="space-y-5">
		<!-- Controls -->
		<div class="flex flex-wrap items-center gap-3">
			<!-- entryType filter -->
			<div class="flex items-center gap-1 overflow-x-auto">
				<button
					v-for="f in typeFilters"
					:key="f.key ?? 'all'"
					class="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium whitespace-nowrap transition-colors"
					:class="
						entryTypeFilter === f.key
							? 'bg-brand-subtle text-brand'
							: 'text-text-secondary hover:text-text-primary hover:bg-bg-surface'
					"
					@click="entryTypeFilter = f.key"
				>
					{{ f.label }}
				</button>
			</div>

			<div class="flex-1" />

			<!-- depth toggle -->
			<div class="flex items-center gap-1 rounded-lg border border-border-subtle p-0.5">
				<button
					v-for="d in ([1, 2] as const)"
					:key="d"
					class="px-2.5 py-1 rounded-md text-xs font-medium transition-colors"
					:class="depth === d ? 'bg-brand-subtle text-brand' : 'text-text-secondary hover:text-text-primary'"
					@click="depth = d"
				>
					{{ d }} hop{{ d === 1 ? '' : 's' }}
				</button>
			</div>
		</div>

		<div class="grid grid-cols-1 lg:grid-cols-3 gap-5">
			<!-- Canvas -->
			<div class="lg:col-span-2 space-y-3">
				<div v-if="isLoading && graph.nodes.length === 0" class="flex items-center justify-center py-24">
					<div class="w-8 h-8 border-2 border-brand border-t-transparent rounded-full animate-spin" />
				</div>
				<KnowledgeGraphCanvas
					v-else
					:nodes="graph.nodes"
					:edges="graph.edges"
					:selected-id="selectedNodeId"
					@node-click="selectNode"
				/>

				<!-- Edge legend -->
				<div class="flex flex-wrap items-center gap-4 text-[11px] text-text-tertiary px-1">
					<span class="flex items-center gap-1.5">
						<svg width="22" height="8"><line x1="0" y1="4" x2="22" y2="4" stroke="currentColor" stroke-width="1.5" /></svg>
						Extracted
					</span>
					<span class="flex items-center gap-1.5">
						<svg width="22" height="8"><line x1="0" y1="4" x2="22" y2="4" stroke="currentColor" stroke-width="1.5" stroke-dasharray="6 4" /></svg>
						Inferred
					</span>
					<span class="flex items-center gap-1.5">
						<svg width="22" height="8"><line x1="0" y1="4" x2="22" y2="4" stroke="currentColor" stroke-width="1" stroke-dasharray="2 5" opacity="0.5" /></svg>
						Ambiguous
					</span>
					<span class="flex items-center gap-1.5 ml-auto">
						<span class="inline-block w-3 h-3 rounded-full border border-brand" /> Hub
					</span>
				</div>
			</div>

			<!-- Sidebar: selection (click-through) + insights -->
			<div class="space-y-4">
				<!-- Click-through side panel -->
				<div
					v-if="selectedEntry"
					class="rounded-xl border border-border-subtle bg-bg-elevated p-5"
				>
					<div class="flex items-start justify-between gap-2 mb-3">
						<div class="flex items-center gap-2 min-w-0">
							<div
								class="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
								:class="{
									'bg-brand-subtle text-brand': typeVariant(selectedEntry.entryType) === 'default',
									'bg-warning/10 text-warning': typeVariant(selectedEntry.entryType) === 'warning',
									'bg-bg-surface text-text-secondary': typeVariant(selectedEntry.entryType) === 'neutral',
									'bg-success-subtle text-success': typeVariant(selectedEntry.entryType) === 'success',
									'bg-error/10 text-error': typeVariant(selectedEntry.entryType) === 'error',
								}"
							>
								<Icon :name="typeIcon(selectedEntry.entryType)" class="w-4 h-4" />
							</div>
							<div class="min-w-0">
								<p class="text-sm font-semibold text-text-primary truncate">{{ selectedEntry.title }}</p>
								<p class="text-[11px] text-text-tertiary">{{ typeLabel(selectedEntry.entryType) }}</p>
							</div>
						</div>
						<button
							type="button"
							class="text-text-tertiary hover:text-text-primary transition-colors flex-shrink-0"
							aria-label="Close panel"
							@click="clearSelection"
						>
							<Icon name="lucide:x" class="w-4 h-4" />
						</button>
					</div>

					<p class="text-sm text-text-secondary line-clamp-4 mb-3">{{ selectedEntry.content }}</p>

					<div class="flex items-center gap-2 mb-4">
						<button
							type="button"
							class="btn btn-secondary btn-sm gap-1.5 flex-1"
							@click="focusNode(selectedEntry._id)"
						>
							<Icon name="lucide:crosshair" class="w-3.5 h-3.5" />
							Center here
						</button>
						<NuxtLink :to="`/dashboard/knowledge/${selectedEntry._id}`" class="btn btn-secondary btn-sm gap-1.5 flex-1">
							<Icon name="lucide:external-link" class="w-3.5 h-3.5" />
							Open
						</NuxtLink>
					</div>

					<KnowledgeRelationsList
						:outgoing-relations="selectedOutgoing"
						:incoming-relations="selectedIncoming"
						:entry-map="selectedEntryMap"
						readonly
					/>
				</div>

				<KnowledgeGraphStatsPanel :stats="stats" @god-node-click="focusNode" />
			</div>
		</div>
	</div>
</template>
