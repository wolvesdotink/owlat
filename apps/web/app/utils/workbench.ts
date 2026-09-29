/**
 * The Workbench: one tab per mailbox the viewer reads (and one for the team
 * inbox, for owners/admins), each summarising only that mailbox. This module
 * holds the pure parts — which tab opens, and where each "Filed away" count
 * leads — so they stay unit-testable.
 */

import type { FiledCategory } from '@owlat/shared/threadStatus';

/** A mailbox id, or `team` for the team inbox. */
export type WorkbenchScope = string;
export const TEAM_SCOPE = 'team';

/** One tab in the Workbench's tab row. */
export interface WorkbenchTab {
	scope: WorkbenchScope;
	name: string;
	slot: number | null;
	/** The inbox's address (tooltip); null for the team inbox. */
	address: string | null;
	isTeam: boolean;
	/** Items waiting on the viewer's answer in this inbox. */
	answer: number;
	unread: number;
}

/** Remembered across visits, so the Workbench reopens on the last tab. */
export const WORKBENCH_SCOPE_STORAGE_KEY = 'owlat.workbench.scope';

/**
 * The tab to show: the one in the URL when the viewer can open it (even an
 * inbox they hid — a link is deliberate), else the one they used last, else
 * the first tab they did not hide. `null` when there is nothing to show.
 */
export function pickWorkbenchScope(input: {
	requested: unknown;
	remembered: string | null;
	/** Every scope the viewer can open. */
	available: readonly WorkbenchScope[];
	/** The ones with a tab (not hidden). */
	shown: readonly WorkbenchScope[];
}): WorkbenchScope | null {
	const { requested, remembered, available, shown } = input;
	if (typeof requested === 'string' && available.includes(requested)) return requested;
	if (remembered && shown.includes(remembered)) return remembered;
	return shown[0] ?? available[0] ?? null;
}

/**
 * The tabs in order: every readable inbox the viewer has not hidden, then the
 * team inbox. A hidden inbox that is open right now (a direct link) keeps its
 * tab until the viewer moves on.
 */
export function workbenchTabs(input: {
	inboxIds: readonly string[];
	hidden: readonly string[];
	teamOn: boolean;
	current: WorkbenchScope | null;
}): WorkbenchScope[] {
	const hidden = new Set(input.hidden);
	const tabs = input.inboxIds.filter((id) => !hidden.has(id) || id === input.current);
	if (input.teamOn) tabs.push(TEAM_SCOPE);
	return tabs;
}

/** Where a "Filed away" count opens: that exact list, in that inbox. */
export function filedHref(scope: WorkbenchScope, key: FiledCategory): string {
	if (scope === TEAM_SCOPE) {
		const view = key === 'promotion' ? 'promotions' : key === 'spam' ? 'spam' : 'notifications';
		return `/dashboard/inbox/updates?view=${view}`;
	}
	// The classifier moves spam out of the inbox, so it lives in the Spam folder.
	if (key === 'spam') return `/dashboard/postbox/spam?mailbox=${scope}`;
	return `/dashboard/inboxes?in=${scope}&category=${key}`;
}
