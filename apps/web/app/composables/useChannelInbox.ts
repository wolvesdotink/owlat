import { api } from '@owlat/api';
import {
	UNIFIED_TIMELINE_CHANNELS,
	channelIcon,
	channelLabel,
	channelColor,
	directionIcon,
	directionLabel,
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

	const { data: messages, isLoading, error } = useConvexQuery(
		api.unifiedMessages.listRecent,
		() => ({
			...(channelFilter.value ? { channel: channelFilter.value } : {}),
			limit,
		}),
	);

	const timeline = computed(() => messages.value ?? []);

	return {
		timeline,
		isLoading,
		error,
		channelFilter,
		channels: UNIFIED_TIMELINE_CHANNELS,
		channelIcon,
		channelLabel,
		channelColor,
		directionIcon,
		directionLabel,
		formatTime: formatTimelineTime,
		truncate: truncateTimelineText,
	};
}
