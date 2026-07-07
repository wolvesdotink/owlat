import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { channelHealthDot, type ChannelHealthStatus } from '~/utils/channelKinds';
import {
	UNIFIED_TIMELINE_CHANNELS,
	channelIcon,
	channelLabel,
	channelColor,
	directionIcon,
	directionLabel,
	deliveryStatusMeta,
	formatTimelineTime,
	truncateTimelineText,
	type UnifiedTimelineChannel,
} from './useUnifiedContactTimeline';

/**
 * Global cross-channel inbox — recent messages across every channel.
 *
 * Subscribes to `api.unifiedMessages.listRecent`, the org-wide stream of the
 * newest messages across email / sms / whatsapp / chat / generic (already
 * returned newest-first by the backend, with an optional server-side channel
 * filter so a single-channel view doesn't pull rows it then discards). This is
 * the global counterpart to `useUnifiedContactTimeline` (per-contact) — it
 * powers the "Channels" cross-channel inbox page. Reuses the same display
 * helpers so channel icons/labels/colors render identically everywhere.
 *
 * Admin-only at the backend (`organization:manage`); the page is reachable only
 * under the `inbox` feature gate.
 */
export function useChannelInbox(limit = 50) {
	// null = all channels (the backend falls back to the by-created-at index).
	const channelFilter = ref<UnifiedTimelineChannel | null>(null);

	const {
		data: messages,
		isLoading,
		error,
	} = useConvexQuery(api.unifiedMessages.listRecent, () => ({
		...(channelFilter.value ? { channel: channelFilter.value } : {}),
		limit,
	}));

	const timeline = computed(() => messages.value ?? []);

	// Per-channel health for the filter pills. `getChannelConfigs` is org-scoped
	// (all members get the row minus credentials); we only surface a status dot
	// for enabled channels that actually have a config row — built-in email/chat
	// and unconfigured kinds get no dot. Absent `healthStatus` on an enabled row
	// reads as healthy (monitoring hasn't run yet).
	const { data: channelConfigs } = useOrganizationQuery(api.unifiedMessages.getChannelConfigs);

	const channelHealthMap = computed(() => {
		const map = new Map<string, ChannelHealthStatus | undefined>();
		for (const c of channelConfigs.value ?? []) {
			if (c.isEnabled) map.set(c.channel, c.healthStatus ?? 'healthy');
		}
		return map;
	});

	/**
	 * The status dot for a channel filter pill, or null when the channel has no
	 * enabled config row (so the pill renders without a dot).
	 */
	function channelHealth(channel: UnifiedTimelineChannel) {
		if (!channelHealthMap.value.has(channel)) return null;
		return channelHealthDot(channelHealthMap.value.get(channel));
	}

	// Resolve a conversation straight from a feed row. Shares the team-inbox
	// status lifecycle (`updateThreadStatus`), so a row resolved here leaves the
	// Open queue everywhere. `run` toasts its own categorized failure and
	// resolves to `undefined` (never throws) on failure.
	const { run: updateThreadStatus } = useBackendOperation(api.inbox.mutations.updateThreadStatus, {
		label: 'Resolve conversation',
	});

	async function resolveThread(threadId: Id<'conversationThreads'>) {
		const result = await updateThreadStatus({ threadId, status: 'resolved' });
		if (result === undefined) return;
		displayToast('Marked as resolved');
	}

	return {
		timeline,
		isLoading,
		error,
		channelFilter,
		channels: UNIFIED_TIMELINE_CHANNELS,
		channelIcon,
		channelLabel,
		channelColor,
		channelHealth,
		directionIcon,
		directionLabel,
		deliveryStatusMeta,
		resolveThread,
		formatTime: formatTimelineTime,
		truncate: truncateTimelineText,
	};
}
