import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import {
	prepareGraphModel,
	type GraphNodeModel,
	type GraphEdgeModel,
} from '~/utils/knowledgeGraphLayout';
import {
	entryTypeIcon,
	entryTypeLabel,
	entryTypeVariant,
	relationLabel,
	relationBadgeClass,
	type EntryType,
} from '~/utils/knowledgeEntryTypes';

/**
 * Args for the analytics snapshot read. Pure so the gating ("only fetch when the
 * `ai.knowledge.analytics` flag is on") can be asserted without a live Convex
 * subscription — returns the Convex `'skip'` sentinel until the flag resolves on.
 */
export function statsQueryArgs(enabled: boolean): 'skip' | Record<string, never> {
	return enabled ? {} : 'skip';
}

/**
 * Args for the subgraph read: skip until analytics is on AND a root entry is
 * chosen (the BFS seed). Pure + exported for the same reason as `statsQueryArgs`.
 */
export function subgraphQueryArgs(
	enabled: boolean,
	rootEntryId: Id<'knowledgeEntries'> | null,
	depth: number,
): 'skip' | { entryId: Id<'knowledgeEntries'>; depth: number } {
	if (!enabled || !rootEntryId) return 'skip';
	return { entryId: rootEntryId, depth };
}

/**
 * Read-only knowledge-graph dashboard model (audit item p9-graph-dashboard).
 *
 * Gated end-to-end on `ai.knowledge.analytics`: every Convex subscription returns
 * `'skip'` until the flag resolves on, so the view fetches nothing — and the page
 * is also route-gated by `definePageMeta({ requiresFeature })`. Mirrors
 * `useKnowledgeGraph` (presentation helpers re-exported from the shared map) and
 * seeds the subgraph BFS from the top god node so the canvas opens on the densest
 * hub.
 */
export function useKnowledgeGraphView() {
	const { isEnabled } = useFeatureFlag();
	const analyticsEnabled = computed(() => isEnabled('ai.knowledge.analytics'));

	// Graph shape snapshot (god nodes, confidence histogram, communities, redacted
	// surprising connections). Skipped entirely until the flag is on.
	const { data: statsData, isLoading: statsLoading } = useConvexQuery(
		api.knowledge.graphAnalytics.getGraphStats,
		() => statsQueryArgs(analyticsEnabled.value),
	);
	const stats = computed(() => statsData.value ?? null);

	const godNodes = computed(() => stats.value?.godNodes ?? []);
	const godNodeIds = computed(() => godNodes.value.map((g) => g.entryId as string));

	// Controls.
	const rootEntryId = ref<Id<'knowledgeEntries'> | null>(null);
	const depth = ref<1 | 2>(1);
	const entryTypeFilter = ref<EntryType | null>(null);
	const selectedNodeId = ref<Id<'knowledgeEntries'> | null>(null);

	// Default the BFS seed to the densest hub once the snapshot lands; the user can
	// re-center on any node afterwards (focusNode).
	watch(
		godNodes,
		(list) => {
			if (!rootEntryId.value && list.length > 0) {
				rootEntryId.value = list[0]!.entryId as Id<'knowledgeEntries'>;
			}
		},
		{ immediate: true },
	);

	const { data: subgraphData, isLoading: subgraphLoading } = useConvexQuery(
		api.knowledge.graphAnalytics.getSubgraph,
		() => subgraphQueryArgs(analyticsEnabled.value, rootEntryId.value, depth.value),
	);

	const graph = computed<{ nodes: GraphNodeModel[]; edges: GraphEdgeModel[] }>(() => {
		const sub = subgraphData.value;
		if (!sub) return { nodes: [], edges: [] };
		return prepareGraphModel({
			nodes: sub.nodes.map((n) => ({
				id: n.id as string,
				title: n.title,
				entryType: n.entryType,
				confidence: n.confidence,
			})),
			edges: sub.edges.map((e) => ({
				fromId: e.fromId as string,
				toId: e.toId as string,
				relationType: e.relationType,
				confidence: e.confidence,
				confidenceTag: e.confidenceTag,
			})),
			godNodeIds: godNodeIds.value,
			entryTypeFilter: entryTypeFilter.value,
		});
	});

	// Click-through: the side panel reuses `getEntry` (relations + related titles)
	// exactly like the entry detail page. Skipped until a node is selected.
	const { data: selectedEntryData, isLoading: selectedLoading } = useConvexQuery(
		api.knowledge.graph.getEntry,
		() => (selectedNodeId.value ? { entryId: selectedNodeId.value } : 'skip'),
	);
	const selectedEntry = computed(() => selectedEntryData.value?.entry ?? null);
	const selectedOutgoing = computed(() => selectedEntryData.value?.outgoing ?? []);
	const selectedIncoming = computed(() => selectedEntryData.value?.incoming ?? []);
	const selectedEntryMap = computed(() => {
		const map: Record<string, { title: string; entryType: string }> = {
			...selectedEntryData.value?.relatedEntries,
		};
		const e = selectedEntry.value;
		if (e) map[e._id] = { title: e.title, entryType: e.entryType };
		return map;
	});

	function selectNode(id: string): void {
		selectedNodeId.value = id as Id<'knowledgeEntries'>;
	}
	function clearSelection(): void {
		selectedNodeId.value = null;
	}
	/** Re-seed the BFS from `id` (and select it for the side panel). */
	function focusNode(id: string): void {
		rootEntryId.value = id as Id<'knowledgeEntries'>;
		selectedNodeId.value = id as Id<'knowledgeEntries'>;
	}

	const isLoading = computed(() => statsLoading.value || subgraphLoading.value);

	return {
		// gate
		analyticsEnabled,
		// snapshot
		stats,
		godNodes,
		godNodeIds,
		// graph
		graph,
		rootEntryId,
		depth,
		entryTypeFilter,
		isLoading,
		// selection / side panel
		selectedNodeId,
		selectedEntry,
		selectedOutgoing,
		selectedIncoming,
		selectedEntryMap,
		selectedLoading,
		selectNode,
		clearSelection,
		focusNode,
		// presentation (shared map)
		typeVariant: entryTypeVariant,
		typeIcon: entryTypeIcon,
		typeLabel: entryTypeLabel,
		relationLabel,
		relationBadgeClass,
	};
}
