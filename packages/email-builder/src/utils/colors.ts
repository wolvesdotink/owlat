/**
 * Compute button text color based on background luminance
 */
export const computeButtonTextColor = (bgColor: string): string => {
	const hex = bgColor.replace('#', '');
	const r = parseInt(hex.substring(0, 2), 16);
	const g = parseInt(hex.substring(2, 4), 16);
	const b = parseInt(hex.substring(4, 6), 16);
	const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
	return luminance > 0.5 ? '#12110e' : '#ffffff';
};

import { MAX_RECENT_COLORS } from '../constants';

/**
 * Manage recent background colors (stored in localStorage)
 */
export class RecentColorsManager {
	private key = 'recent-background-colors';
	private maxColors = MAX_RECENT_COLORS;

	/**
	 * Get recent colors from localStorage
	 */
	getColors(): string[] {
		if (typeof window === 'undefined') return [];

		const stored = localStorage.getItem(this.key);
		if (!stored) return [];

		try {
			return JSON.parse(stored);
		} catch {
			return [];
		}
	}

	/**
	 * Add a color to recent colors
	 */
	addColor(color: string): string[] {
		if (color === 'transparent' || !color) return this.getColors();
		if (typeof window === 'undefined') return [];

		const colors = this.getColors().filter((c) => c !== color);
		colors.unshift(color);
		const trimmed = colors.slice(0, this.maxColors);

		localStorage.setItem(this.key, JSON.stringify(trimmed));
		return trimmed;
	}
}
