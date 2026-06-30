import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import {
	channelIcon,
	channelLabel,
	channelColor,
	directionIcon,
	directionLabel,
	formatTimelineTime,
} from '~/composables/useUnifiedContactTimeline';

export interface TimelineDisplayItem {
	_id: string;
	channel: string;
	direction: string;
	content: { text?: string; subject?: string };
	status?: string;
	createdAt: number;
	isActivity: boolean;
}

export function useContactTimeline(contactId: Ref<Id<'contacts'>>) {
	// Unified timeline (cross-channel messages + activities)
	const { data: timeline, isLoading: timelineLoading } = useConvexQuery(
		api.contacts.timeline.getTimeline,
		() => ({ contactId: contactId.value, limit: 50 }),
	);

	// Timeline stats
	const { data: stats, isLoading: statsLoading } = useConvexQuery(
		api.contacts.timeline.getTimelineStats,
		() => ({ contactId: contactId.value }),
	);

	// Channel filter
	const channelFilter = ref<string | null>(null);

	const displayTimeline = computed<TimelineDisplayItem[]>(() => {
		const entries = timeline.value ?? [];
		return entries.map((entry): TimelineDisplayItem => {
			if (entry.type === 'message') {
				return {
					_id: entry.data._id,
					channel: entry.data.channel,
					direction: entry.data.direction,
					content: { text: entry.data.content.text, subject: entry.data.content.subject },
					status: entry.data.status,
					createdAt: entry.data.createdAt,
					isActivity: false,
				};
			}
			return {
				_id: entry.data._id,
				channel: 'activity',
				direction: 'outbound',
				content: { text: entry.data.activityType },
				createdAt: entry.data.timestamp,
				isActivity: true,
			};
		});
	});

	const filteredTimeline = computed<TimelineDisplayItem[]>(() => {
		if (!channelFilter.value) return displayTimeline.value;
		return displayTimeline.value.filter((item) => item.channel === channelFilter.value);
	});

	// Channel / direction / time display helpers — shared with the unified
	// cross-channel timeline so the icon/label/color and relative-time formatting
	// stay identical across every message view (no more drifted local copies).
	const formatTime = formatTimelineTime;

	return {
		timeline,
		timelineLoading,
		stats,
		statsLoading,
		channelFilter,
		filteredTimeline,
		channelIcon,
		channelLabel,
		channelColor,
		directionIcon,
		directionLabel,
		formatTime,
	};
}
