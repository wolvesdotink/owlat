/**
 * The viewer's "Show the brief above conversations" (`isAutoSummarizeOn`) for
 * message rows. Off, a row shows no AI line: no brief line ("2 for you …"), no
 * gist, no lead or ask under the Priority view; the plain snippet or subject
 * instead.
 *
 * The lists that render rows (PostboxThreadList, PostboxThreadSectionList,
 * PostboxThreadBundleList, the Priority view) read the preference once and
 * provide it; each row (PostboxThreadRowBody) injects it. A row with no
 * provider above it shows the brief, the default.
 */
import { computed, inject, provide, type ComputedRef, type InjectionKey, type Ref } from 'vue';

export const POSTBOX_BRIEF_LINES: InjectionKey<Readonly<Ref<boolean>>> =
	Symbol('postboxBriefLines');

/** A list: hand its rows the preference (a missing one leaves the default, on). */
export function provideBriefLines(shown: Readonly<Ref<boolean>> | undefined): void {
	if (shown) provide(POSTBOX_BRIEF_LINES, shown);
}

/** A row: whether to show the AI's lines. */
export function useBriefLinesShown(): ComputedRef<boolean> {
	const shown = inject(POSTBOX_BRIEF_LINES, null);
	return computed(() => shown?.value !== false);
}
