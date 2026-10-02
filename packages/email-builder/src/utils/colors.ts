import { readableTextColor } from '@owlat/shared/brandKit';

/**
 * Compute button text color based on background luminance. The brand kit
 * picks a button label colour with the same rule, so it lives in the shared
 * package.
 */
export const computeButtonTextColor = (bgColor: string): string => readableTextColor(bgColor);

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
