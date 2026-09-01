/**
 * Column spans for the adaptive dashboard grid
 * (`grid-cols-1 sm:grid-cols-2 lg:grid-cols-4`).
 *
 * Shared because two things place cells on that grid: `DashboardCardRenderer`
 * for the real cards, and the first-load placeholder grid on
 * `pages/dashboard/index.vue`. If those two ever disagreed the page would snap
 * from the placeholder layout into the real one — exactly the jump the
 * placeholders exist to remove — so the mapping lives in one place.
 */
export type DashboardCardSize = 'small' | 'medium' | 'large';

export function dashboardCardSpan(size: DashboardCardSize | string): string {
	switch (size) {
		case 'large':
			return 'col-span-1 sm:col-span-2 lg:col-span-4';
		case 'medium':
			return 'col-span-1 sm:col-span-2';
		case 'small':
		default:
			return 'col-span-1';
	}
}
