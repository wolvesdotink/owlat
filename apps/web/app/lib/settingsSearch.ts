/**
 * The Settings sidebar's search: pages and the individual controls on them,
 * matched the way the ⌘K palette matches settings (`filterByKeywords` over
 * title, context line and synonyms) and gated by the same control tables, so
 * the two searches cannot disagree about what exists.
 *
 * Pure (no Vue, no Nuxt, no Convex); the caller resolves the environment and
 * passes `t`. See `__tests__/settingsSearch.test.ts`.
 */
import type { IconComponent } from '@coolicons/vue';
import { adminControlTargets } from './adminSettingsControls';
import type { AdminEnvironment } from './adminSettingsRegistry';
import type { AdminAreaView } from './adminSettingsNav';
import {
	filterByKeywords,
	parseKeywords,
	settingsControlTargets,
	type SettingsEnvironment,
	type SettingsSectionView,
} from './settingsRegistry';

/** Enough to cover a page and its controls without the sidebar outgrowing the screen. */
export const SETTINGS_SEARCH_CAP = 12;

export interface SettingsSearchResult {
	readonly id: string;
	readonly path: string;
	readonly icon: IconComponent;
	readonly title: string;
	readonly group: string;
}

export interface SettingsSearchInput {
	/** The My settings rail, already gated. */
	readonly youSections: readonly SettingsSectionView[];
	/** The Workspace rail; empty for someone without the Workspace tab. */
	readonly adminAreas: readonly AdminAreaView[];
	readonly environment: SettingsEnvironment;
	readonly adminEnvironment: AdminEnvironment;
	readonly t: (key: string) => string;
}

interface Row extends SettingsSearchResult {
	readonly label: string;
	readonly subtitle: string;
	readonly keywords: readonly string[];
}

/**
 * Page matches first, then control matches, each ranked by `filterByKeywords`,
 * capped at {@link SETTINGS_SEARCH_CAP}. Pages come from the rails the caller
 * renders, so hidden and gated pages stay out exactly as they do there.
 */
export function settingsSearchResults(
	input: SettingsSearchInput,
	query: string
): SettingsSearchResult[] {
	if (!query.trim()) return [];
	const { t } = input;
	const row = (
		id: string,
		path: string,
		icon: IconComponent,
		title: string,
		group: string,
		keywords: readonly string[]
	): Row => ({ id, path, icon, title, group, label: title, subtitle: group, keywords });

	const pages: Row[] = [
		...input.youSections.flatMap((section) =>
			section.entries.map((entry) =>
				row(
					entry.path,
					entry.path,
					entry.icon,
					t(entry.titleKey),
					t(section.titleKey),
					// Synonyms only. The matcher is a subsequence match, so a page's
					// description sentence would match almost any short query.
					parseKeywords(t(entry.keywordsKey))
				)
			)
		),
		...input.adminAreas.flatMap((area) =>
			area.entries.map((entry) =>
				row(entry.path, entry.path, entry.icon, t(entry.titleKey), t(area.titleKey), [])
			)
		),
	];

	// The Workspace tab is the admin gate here: no tab, no workspace controls.
	const canAdminister = input.adminAreas.length > 0;
	const controls: Row[] = [
		...settingsControlTargets(input.environment),
		...adminControlTargets(input.adminEnvironment, canAdminister),
	].map((target) =>
		row(
			`setting:${target.id}`,
			target.href,
			target.entry.icon,
			t(target.control.titleKey),
			t(target.entry.titleKey),
			parseKeywords(t(target.control.keywordsKey))
		)
	);

	return [...filterByKeywords(pages, query), ...filterByKeywords(controls, query)]
		.slice(0, SETTINGS_SEARCH_CAP)
		.map(({ id, path, icon, title, group }) => ({ id, path, icon, title, group }));
}
