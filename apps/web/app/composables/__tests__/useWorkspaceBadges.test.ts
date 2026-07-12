// @vitest-environment happy-dom
/**
 * useWorkspaceBadges — the per-workspace unread counts behind the desktop
 * titlebar pill and the switcher rail.
 *
 * Regression focus: the active-workspace watchEffect calls setBadge, whose
 * `{ ...badges.value }` spread makes the shared badges ref a dependency of
 * every instance of that effect. The composable is mounted TWICE in the real
 * tree (DesktopTitlebar + its child WorkspaceMenu); without the
 * unchanged-count guard each instance's write of a fresh object re-triggered
 * the OTHER instance (cross-triggering is allowed where self-triggering is
 * not), ping-ponging forever — "Maximum recursive updates exceeded in
 * component <DesktopTitlebar>" the moment a workspace was active (surfaced by
 * the dev local-dev auto-seed, which made activeId non-null under `tauri
 * dev`). These tests mount two components on the REAL composable, so the old
 * code fails them with that exact recursion error.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { defineComponent, h, nextTick, ref } from 'vue';

vi.mock('@owlat/api', () => ({
	api: {
		inbox: { queries: { getInboundStats: { __query: 'inboundStats' } } },
		chat: { mentions: { countMyUnreadMentions: { __query: 'mentionCount' } } },
	},
}));

vi.mock('~/lib/desktop/activeWorkspace', () => ({
	isDesktopRuntime: () => true,
}));

// Background clients for INACTIVE workspaces: capture the per-workspace count
// callback so tests can push counts the way a live subscription would.
const backgroundCallbacks = new Map<string, (count: number) => void>();
const closeMock = vi.fn();
vi.mock('~/lib/desktop/workspaceBadgeClient', () => ({
	createWorkspaceBadgeClient: (ws: { id: string }, onCount: (count: number) => void) => {
		backgroundCallbacks.set(ws.id, onCount);
		return { close: closeMock };
	},
}));

import { api } from '@owlat/api';
import { useWorkspaceBadges } from '../useWorkspaceBadges';

const workspaces = ref([
	{ id: 'w1', label: 'Acme' },
	{ id: 'w2', label: 'Globex' },
]);
const activeId = ref<string | null>('w1');
const inboundStats = ref<{ draftReady?: number } | undefined>(undefined);
const mentionCount = ref<number | undefined>(undefined);

beforeAll(() => {
	vi.stubGlobal('useDesktopWorkspaces', () => ({ workspaces, activeId }));
	vi.stubGlobal('useFeatureFlag', () => ({ isEnabled: () => true }));
	vi.stubGlobal('useConvexQuery', (query: unknown) => ({
		data: query === api.inbox.queries.getInboundStats ? inboundStats : mentionCount,
	}));
});

enableAutoUnmount(afterEach);

/** Stand-in for a badge consumer: render the active badge. */
const Probe = defineComponent({
	props: { tag: { type: String, default: 'probe' } },
	setup() {
		const { badgeFor } = useWorkspaceBadges();
		return () => h('span', String(activeId.value ? badgeFor(activeId.value) : '-'));
	},
});

/** The real tree mounts the composable twice: DesktopTitlebar + WorkspaceMenu. */
const Pair = defineComponent({
	setup() {
		return () => h('div', [h(Probe, { tag: 'titlebar' }), h(Probe, { tag: 'menu' })]);
	},
});

describe('useWorkspaceBadges', () => {
	it('feeds the active workspace badge from the global queries and CONVERGES across two consumers (no recursive update loop)', async () => {
		inboundStats.value = { draftReady: 3 };
		mentionCount.value = 2;

		const w = mount(Pair);
		// Old code dies here: with two instances of the active-badge watchEffect
		// each writing a fresh badges object, they re-trigger one another until
		// Vue throws "Maximum recursive updates exceeded".
		await nextTick();
		await nextTick();
		expect(w.text()).toBe('55');

		// Still live after converging: a new count flows through exactly once.
		mentionCount.value = 4;
		await nextTick();
		await nextTick();
		expect(w.text()).toBe('77');
	});

	it('routes background-client counts to inactive workspaces via badgeFor', async () => {
		inboundStats.value = { draftReady: 1 };
		mentionCount.value = 0;

		const badgeForRef: { fn?: (id: string) => number } = {};
		const Reader = defineComponent({
			setup() {
				const { badgeFor } = useWorkspaceBadges();
				badgeForRef.fn = badgeFor;
				return () => h('span');
			},
		});
		mount(Reader);
		await nextTick();

		// The inactive workspace got a background client; the active one did not.
		expect(backgroundCallbacks.has('w2')).toBe(true);
		expect(backgroundCallbacks.has('w1')).toBe(false);

		backgroundCallbacks.get('w2')?.(6);
		await nextTick();
		expect(badgeForRef.fn?.('w2')).toBe(6);
		expect(badgeForRef.fn?.('w1')).toBe(1);
	});
});
