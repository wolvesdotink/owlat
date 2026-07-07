import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

/**
 * Cross-channel unified contact timeline (B4).
 *
 * Subscribes to `api.unifiedMessages.getContactTimeline` — the pure
 * multi-channel message stream (email / sms / whatsapp / chat / generic),
 * already returned newest-first by the backend. Provides per-channel and
 * per-direction display helpers plus a channel filter. The activity-event
 * timeline (`api.contacts.timeline.getTimeline`) is rendered separately by
 * the Activity tab via `useContactTimeline`.
 */

export type UnifiedTimelineChannel = 'email' | 'sms' | 'whatsapp' | 'generic' | 'chat';

export const UNIFIED_TIMELINE_CHANNELS: UnifiedTimelineChannel[] = [
	'email',
	'sms',
	'whatsapp',
	'chat',
	'generic',
];

const CHANNEL_CONFIG: Record<
	UnifiedTimelineChannel,
	{ icon: string; label: string; color: string }
> = {
	email: { icon: 'lucide:mail', label: 'Email', color: 'text-blue-500' },
	sms: { icon: 'lucide:smartphone', label: 'SMS', color: 'text-green-500' },
	whatsapp: { icon: 'lucide:message-circle', label: 'WhatsApp', color: 'text-emerald-500' },
	chat: { icon: 'lucide:message-square', label: 'Chat', color: 'text-orange-500' },
	generic: { icon: 'lucide:webhook', label: 'Generic', color: 'text-purple-500' },
};

// Shared cross-channel display helpers — reused by every unified-message view
// (per-contact timeline, per-thread timeline, and the global channel inbox) so
// channel icons/labels/colors and direction/time formatting stay identical.
export const channelIcon = (channel: string): string =>
	CHANNEL_CONFIG[channel as UnifiedTimelineChannel]?.icon ?? 'lucide:message-square';

export const channelLabel = (channel: string): string =>
	CHANNEL_CONFIG[channel as UnifiedTimelineChannel]?.label ?? channel;

export const channelColor = (channel: string): string =>
	CHANNEL_CONFIG[channel as UnifiedTimelineChannel]?.color ?? 'text-text-tertiary';

export const directionIcon = (direction: string): string =>
	direction === 'inbound' ? 'lucide:arrow-down-left' : 'lucide:arrow-up-right';

export const directionLabel = (direction: string): string =>
	direction === 'inbound' ? 'Received' : 'Sent';

export const formatTimelineTime = (ts: number): string => {
	const date = new Date(ts);
	const now = new Date();
	const diffHours = (now.getTime() - date.getTime()) / (1000 * 60 * 60);

	if (diffHours < 24) {
		return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
	}
	if (diffHours < 24 * 7) {
		return date.toLocaleDateString('en-US', {
			weekday: 'short',
			hour: 'numeric',
			minute: '2-digit',
		});
	}
	return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

export const truncateTimelineText = (text: string, max = 120): string => {
	if (!text) return '';
	return text.length > max ? text.slice(0, max) + '…' : text;
};

export interface DeliveryStatusMeta {
	icon: string;
	/** Design-token text color for the mark. */
	class: string;
	/** Human label for the icon's `title`/aria (no enum strings in the UI). */
	label: string;
}

/**
 * Collapse an outbound message's delivery state into a single small status
 * icon (one-chip rule): the direction + channel chips carry the roll-up, so
 * delivery detail rides on a recessive mark whose `title` spells it out.
 * Returns null for states that need no mark — inbound `received` and the
 * neutral `sent`-only case where the channel chip already implies it.
 */
export const deliveryStatusMeta = (
	status: string | null | undefined
): DeliveryStatusMeta | null => {
	switch (status) {
		case 'read':
			return { icon: 'lucide:check-check', class: 'text-success', label: 'Read' };
		case 'delivered':
			return { icon: 'lucide:check-check', class: 'text-success', label: 'Delivered' };
		case 'queued':
		case 'sending':
		case 'processing':
			return { icon: 'lucide:clock', class: 'text-text-tertiary', label: 'Sending' };
		case 'failed':
			return { icon: 'lucide:alert-circle', class: 'text-error', label: 'Failed' };
		case 'bounced':
			return { icon: 'lucide:alert-triangle', class: 'text-error', label: 'Bounced' };
		default:
			return null;
	}
};

export function useUnifiedContactTimeline(contactId: Ref<Id<'contacts'>>) {
	const {
		data: messages,
		isLoading,
		error,
	} = useConvexQuery(api.unifiedMessages.getContactTimeline, () => ({
		contactId: contactId.value,
		limit: 50,
	}));

	// Channel filter (null = all channels)
	const channelFilter = ref<UnifiedTimelineChannel | null>(null);

	const timeline = computed(() => messages.value ?? []);

	const filteredTimeline = computed(() => {
		if (!channelFilter.value) return timeline.value;
		return timeline.value.filter((msg) => msg.channel === channelFilter.value);
	});

	// The conversation thread an outbound native-chat reply would post on:
	// the contact's most recent thread (the timeline is newest-first). Native
	// chat (`unifiedMessages.sendChatMessage`) is keyed to a thread, so chat
	// compose is only offered once the contact has at least one thread.
	const latestThreadId = computed<Id<'conversationThreads'> | null>(
		() => timeline.value[0]?.threadId ?? null
	);

	return {
		timeline,
		filteredTimeline,
		latestThreadId,
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
