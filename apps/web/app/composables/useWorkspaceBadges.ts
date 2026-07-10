/**
 * Per-workspace unread counts for the desktop switcher.
 *
 * The ACTIVE workspace's badge is fed by the single global ConvexClient (inbox
 * drafts-ready + unread chat mentions, gated by its feature flags). Every other
 * connected workspace gets a lightweight background ConvexClient — authed
 * against that instance with the session blob in its own keychain entry —
 * subscribed to the same two queries, so the rail shows an at-a-glance unread
 * count for the workspace you are NOT currently in. See
 * `lib/desktop/workspaceBadgeClient.ts`.
 *
 * The dock/taskbar total stays owned by useDesktopNotifications to avoid duplicate
 * badge writers. `badgeFor(id)` is the read accessor for the rail.
 */
import { api } from '@owlat/api';
import { isDesktopRuntime } from '~/lib/desktop/activeWorkspace';
import {
	createWorkspaceBadgeClient,
	type WorkspaceBadgeClient,
} from '~/lib/desktop/workspaceBadgeClient';
import type { WorkspaceConfig } from '~/lib/desktop/workspaceTypes';

const badges = ref<Record<string, number>>({});

// One background client per inactive workspace id (module-level so multiple
// `useWorkspaceBadges()` callers share a single set of subscriptions).
const backgroundClients = new Map<string, WorkspaceBadgeClient>();
let backgroundOwners = 0;

function setBadge(id: string, count: number): void {
	badges.value = { ...badges.value, [id]: count };
}

/** Reconcile background clients to exactly the connected, inactive workspaces. */
function syncBackgroundClients(workspaces: readonly WorkspaceConfig[], activeId: string | null) {
	const wantedIds = new Set(workspaces.filter((w) => w.id !== activeId).map((w) => w.id));

	// Tear down clients for workspaces that are gone or now active.
	for (const [id, client] of backgroundClients) {
		if (!wantedIds.has(id)) {
			client.close();
			backgroundClients.delete(id);
		}
	}

	// Spin up clients for newly-inactive / newly-added workspaces.
	for (const ws of workspaces) {
		if (ws.id === activeId || backgroundClients.has(ws.id)) continue;
		backgroundClients.set(
			ws.id,
			createWorkspaceBadgeClient(ws, (count) => setBadge(ws.id, count))
		);
	}
}

function teardownBackgroundClients(): void {
	for (const client of backgroundClients.values()) client.close();
	backgroundClients.clear();
}

export function useWorkspaceBadges() {
	const { activeId, workspaces } = useDesktopWorkspaces();
	const { isEnabled } = useFeatureFlag();

	const { data: inboundStats } = useConvexQuery(api.inbox.queries.getInboundStats, () =>
		isEnabled('inbox') ? {} : 'skip'
	);
	const { data: mentionCount } = useConvexQuery(api.chat.mentions.countMyUnreadMentions, () =>
		isEnabled('chat') ? {} : 'skip'
	);

	// Active workspace: fed by the global client (already authed against it).
	watchEffect(() => {
		const id = activeId.value;
		if (!id) return;
		const pending = (inboundStats.value as { draftReady?: number } | undefined)?.draftReady ?? 0;
		const mentions = (mentionCount.value as number | undefined) ?? 0;
		setBadge(id, pending + mentions);
	});

	// Inactive workspaces: one background client each (desktop only).
	if (isDesktopRuntime()) {
		backgroundOwners += 1;
		watch([workspaces, activeId], ([list, active]) => syncBackgroundClients(list, active), {
			immediate: true,
			deep: true,
		});
		if (getCurrentScope()) {
			onScopeDispose(() => {
				backgroundOwners -= 1;
				if (backgroundOwners <= 0) teardownBackgroundClients();
			});
		}
	}

	function badgeFor(id: string): number {
		return badges.value[id] ?? 0;
	}

	return { badges: readonly(badges), badgeFor };
}
