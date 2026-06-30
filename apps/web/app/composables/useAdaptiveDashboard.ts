import { api } from '@owlat/api';
import type { SavedRule } from './useDashboardRules';

type CardSize = 'small' | 'medium' | 'large';

interface DashboardCard {
	type: string;
	size: CardSize;
	pinned?: boolean;
}

interface AvailableCard {
	type: string;
	label: string;
	description: string;
}

export function useAdaptiveDashboard() {
	const { user } = useAuth();

	const isAuthed = computed(() => !!user.value?.id);

	const { data: layoutData, isLoading: layoutLoading } = useConvexQuery(
		api.analytics.adaptiveDashboard.getLayout,
		() => (isAuthed.value ? {} : 'skip')
	);

	const { data: availableCardsData, isLoading: availableCardsLoading } = useConvexQuery(
		api.analytics.adaptiveDashboard.getAvailableCards,
		{}
	);

	// Raw saved layout (includes adaptive rules) — only the editor needs it, so
	// it's fetched on the same subscription cadence as the resolved layout.
	const { data: rawLayoutData } = useConvexQuery(
		api.analytics.adaptiveDashboard.getRawLayout,
		() => (isAuthed.value ? {} : 'skip')
	);

	const { run: saveLayoutMutation } = useBackendOperation(
		api.analytics.adaptiveDashboard.saveLayout,
		{ label: 'Save dashboard layout' },
	);

	const isEditing = ref(false);

	const cards = computed<DashboardCard[]>(() => {
		if (!layoutData.value) return [];
		return layoutData.value.cards as DashboardCard[];
	});

	const availableCards = computed<AvailableCard[]>(() => {
		// Spread to a mutable array (consumers expect AvailableCard[]); the typed
		// source still surfaces any backend shape drift at compile time.
		return availableCardsData.value ? [...availableCardsData.value] : [];
	});

	// Adaptive rules from the saved layout (empty when no row exists yet). The
	// editor seeds its working copies from this.
	const savedRules = computed<SavedRule[]>(() => {
		return (rawLayoutData.value?.rules as SavedRule[] | undefined) ?? [];
	});

	const isLoading = computed(() => layoutLoading.value || availableCardsLoading.value);

	async function saveLayout(
		pinnedCards: Array<{ type: string; size: CardSize }>,
		// Pass `rules` to persist adaptive rules alongside the pinned cards. Omit
		// it (the pin/unpin UI) so a pinned-cards-only save never wipes the stored
		// adaptive rules — saveLayout treats `rules: undefined` as "leave as-is".
		rules?: SavedRule[]
	) {
		if (!isAuthed.value) return;
		await saveLayoutMutation(rules !== undefined ? { pinnedCards, rules } : { pinnedCards });
	}

	return {
		cards,
		availableCards,
		savedRules,
		isLoading,
		isEditing,
		saveLayout,
	};
}
