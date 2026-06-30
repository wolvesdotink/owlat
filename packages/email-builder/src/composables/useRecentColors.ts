import { ref, onMounted, type Ref } from 'vue';
import { RecentColorsManager } from '../utils/colors';

export interface UseRecentColorsReturn {
	recentBackgroundColors: Ref<string[]>;
	addRecentBackgroundColor: (color: string) => void;
}

/**
 * Composable for managing recent background colors
 */
export function useRecentColors(): UseRecentColorsReturn {
	const recentColorsManager = new RecentColorsManager();
	const recentBackgroundColors = ref<string[]>([]);

	onMounted(() => {
		recentBackgroundColors.value = recentColorsManager.getColors();
	});

	const addRecentBackgroundColor = (color: string) => {
		recentBackgroundColors.value = recentColorsManager.addColor(color);
	};

	return {
		recentBackgroundColors,
		addRecentBackgroundColor,
	};
}
