import { ref, computed, watch, type ComputedRef } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import {
	ACTIVITY_EDITOR_MODULES,
	type ContactActivityType,
} from './contactActivities';

// Type for activity items
export interface ActivityItem {
	_id: string;
	contactId: string;
	activityType: string;
	metadata?: unknown;
	occurredAt: number;
}

const FALLBACK_DISPLAY = {
	icon: 'lucide:clock',
	label: '',
	color: 'text-text-secondary',
};

function moduleForType(type: string) {
	const map = ACTIVITY_EDITOR_MODULES as Record<
		string,
		(typeof ACTIVITY_EDITOR_MODULES)[ContactActivityType]
	>;
	return map[type];
}

/**
 * Composable for contact activity timeline: pagination, parsing, formatting.
 */
export function useActivityTimeline(contactId: ComputedRef<Id<'contacts'>>) {
	// Pagination state
	const activityCursor = ref<number | undefined>(undefined);
	const isLoadingMoreActivities = ref(false);
	const accumulatedActivities = ref<ActivityItem[]>([]);

	// DATA: Convex query with pagination
	const { data: activitiesData, isLoading: activitiesLoading } = useConvexQuery(
		api.contacts.activities.listByContact,
		() => ({
			contactId: contactId.value,
			limit: 20,
			cursor: activityCursor.value,
		})
	);

	// Watch for new activity data and accumulate
	watch(
		activitiesData,
		(newData) => {
			if (newData) {
				if (!activityCursor.value) {
					// First load - replace all
					accumulatedActivities.value = [...newData.items] as ActivityItem[];
				} else {
					// Pagination load - append
					const existingIds = new Set(accumulatedActivities.value.map((a) => a._id));
					const newItems = ([...newData.items] as ActivityItem[]).filter(
						(item: ActivityItem) => !existingIds.has(item._id)
					);
					accumulatedActivities.value = [...accumulatedActivities.value, ...newItems];
				}
				isLoadingMoreActivities.value = false;
			}
		},
		{ immediate: true }
	);

	// ACTIONS
	const loadMoreActivities = () => {
		if (activitiesData.value?.hasMore && activitiesData.value?.nextCursor) {
			isLoadingMoreActivities.value = true;
			activityCursor.value = activitiesData.value.nextCursor;
		}
	};

	// COMPUTED
	const hasMoreActivities = computed(() => activitiesData.value?.hasMore ?? false);

	// Display helpers — route through the per-literal Contact activity
	// (module) display half at `composables/contactActivities/<literal>/`.

	const getActivityIcon = (type: string) =>
		moduleForType(type)?.displayConfig.icon ?? FALLBACK_DISPLAY.icon;

	const getActivityLabel = (type: string) =>
		moduleForType(type)?.displayConfig.label ?? type;

	const getActivityColor = (type: string) =>
		moduleForType(type)?.displayConfig.color ?? FALLBACK_DISPLAY.color;

	const parseMetadata = (metadata: unknown): Record<string, unknown> => {
		if (!metadata) return {};
		if (typeof metadata === 'object') return metadata as Record<string, unknown>;
		if (typeof metadata === 'string') {
			try {
				return JSON.parse(metadata);
			} catch {
				return {};
			}
		}
		return {};
	};

	const getActivityDescription = (type: string, metadata: unknown): string => {
		const module = moduleForType(type);
		if (!module) return '';
		const parsed = parseMetadata(metadata);
		const blob = Object.keys(parsed).length === 0 ? undefined : parsed;
		// TS narrows per-literal at the call site of each module's
		// `formatDescription`, but when dispatched from the indexed
		// registry the type collapses to a union — and the union's
		// formatter would take an *intersection* of metadata shapes. Cast
		// to the safe shape: each per-literal formatter only reads keys
		// from its own schema, so passing the raw metadata is correct at
		// runtime.
		return (module.formatDescription as (m: unknown) => string)(blob);
	};

	const formatActivityTime = (timestamp: number): string =>
		formatCompactRelativeTime(timestamp);

	return {
		// Data
		accumulatedActivities,
		activitiesLoading,
		hasMoreActivities,
		isLoadingMoreActivities,

		// Actions
		loadMoreActivities,

		// Display helpers
		getActivityIcon,
		getActivityLabel,
		getActivityColor,
		getActivityDescription,
		formatActivityTime,
	};
}
