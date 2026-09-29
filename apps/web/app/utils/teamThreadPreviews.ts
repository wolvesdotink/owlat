/**
 * What the Team Inbox list already knows about each thread it showed, kept so
 * the thread page can head its loading state with the real subject and sender
 * instead of a centred spinner while `getThread` is in flight.
 *
 * Module state on purpose: the app is `ssr: false`, so there is one browser
 * session per module instance and nothing leaks between requests. It only
 * ever seeds a placeholder; the page swaps to `getThread` the moment it lands.
 * Bounded, oldest first out, so a long session paging through the list does
 * not grow it without limit.
 */

/** The row fields the thread page's header can show before the thread loads. */
export interface TeamThreadPreview {
	subject: string;
	contactIdentifier: string;
	messageCount?: number;
}

type TeamThreadPreviewRow = TeamThreadPreview & { _id: string };

export const TEAM_THREAD_PREVIEW_LIMIT = 200;

const previews = new Map<string, TeamThreadPreview>();

/** Remember the rows a Team Inbox list page just loaded (newest write wins). */
export function rememberTeamThreadPreviews(rows: readonly TeamThreadPreviewRow[]): void {
	for (const row of rows) {
		// Re-insert so a row seen again counts as recent.
		previews.delete(row._id);
		previews.set(row._id, {
			subject: row.subject,
			contactIdentifier: row.contactIdentifier,
			messageCount: row.messageCount,
		});
	}
	while (previews.size > TEAM_THREAD_PREVIEW_LIMIT) {
		const oldest = previews.keys().next().value;
		if (oldest === undefined) break;
		previews.delete(oldest);
	}
}

/** The list row for this thread, or null when the list never showed it. */
export function teamThreadPreview(threadId: string): TeamThreadPreview | null {
	return previews.get(threadId) ?? null;
}

/** Test seam: forget every remembered row. */
export function clearTeamThreadPreviews(): void {
	previews.clear();
}
