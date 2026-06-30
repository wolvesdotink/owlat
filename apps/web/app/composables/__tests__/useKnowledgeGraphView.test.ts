import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';
import {
	statsQueryArgs,
	subgraphQueryArgs,
	useKnowledgeGraphView,
} from '../useKnowledgeGraphView';
import type { Id } from '@owlat/api/dataModel';

const rootId = 'entry_root' as Id<'knowledgeEntries'>;

describe('statsQueryArgs', () => {
	it('skips the snapshot read until analytics is enabled', () => {
		expect(statsQueryArgs(false)).toBe('skip');
		expect(statsQueryArgs(true)).toEqual({});
	});
});

describe('subgraphQueryArgs', () => {
	it('skips until analytics is on AND a root entry is chosen', () => {
		expect(subgraphQueryArgs(false, rootId, 1)).toBe('skip');
		expect(subgraphQueryArgs(true, null, 1)).toBe('skip');
		expect(subgraphQueryArgs(true, rootId, 2)).toEqual({ entryId: rootId, depth: 2 });
	});
});

describe('useKnowledgeGraphView gating', () => {
	let enabledFlags: Set<string>;

	beforeEach(() => {
		enabledFlags = new Set();
		// useFeatureFlag is a Nuxt auto-import; stub it so we control the flag.
		vi.stubGlobal('useFeatureFlag', () => ({
			isEnabled: (flag: string) => enabledFlags.has(flag),
			isLoading: ref(false),
			flags: ref({}),
			error: ref(null),
		}));
		// Every Convex subscription is stubbed to an inert, empty result so the
		// composable can be constructed without a live backend. We assert the
		// *gating* (analyticsEnabled + the pure arg helpers) rather than live data.
		vi.stubGlobal('useConvexQuery', () => ({
			data: ref(undefined),
			isLoading: ref(false),
			error: ref(null),
			isRefetching: ref(false),
		}));
	});

	it('reports analytics disabled when the flag is off, and an empty graph', () => {
		const view = useKnowledgeGraphView();
		expect(view.analyticsEnabled.value).toBe(false);
		expect(view.graph.value.nodes).toEqual([]);
		expect(view.graph.value.edges).toEqual([]);
		// The snapshot read must be skipped while disabled.
		expect(statsQueryArgs(view.analyticsEnabled.value)).toBe('skip');
	});

	it('reports analytics enabled when the flag is on', () => {
		enabledFlags.add('ai.knowledge.analytics');
		const view = useKnowledgeGraphView();
		expect(view.analyticsEnabled.value).toBe(true);
		expect(statsQueryArgs(view.analyticsEnabled.value)).toEqual({});
	});

	it('selection helpers drive the side-panel state', () => {
		enabledFlags.add('ai.knowledge.analytics');
		const view = useKnowledgeGraphView();
		expect(view.selectedNodeId.value).toBeNull();
		view.selectNode('entry_x');
		expect(view.selectedNodeId.value).toBe('entry_x');
		view.focusNode('entry_y');
		expect(view.rootEntryId.value).toBe('entry_y');
		expect(view.selectedNodeId.value).toBe('entry_y');
		view.clearSelection();
		expect(view.selectedNodeId.value).toBeNull();
	});
});
