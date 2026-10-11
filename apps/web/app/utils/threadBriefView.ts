/**
 * Which view a Postbox thread opens on (SPEC §7, plan §4.2): Overview (the
 * thread brief) or Conversation (the messages). Pure, so the precedence is
 * unit-testable without mounting the reader.
 *
 * Precedence, first match wins:
 *   1. A shared (team) mailbox has no Overview at all.
 *   2. A cited quote (`?cite=`) opens Conversation, for this visit only.
 *   3. `?view=` in the URL (a link from the Workbench or a notification).
 *   4. What the viewer clicked in this visit.
 *   5. The viewer's saved per-thread choice (`threadViewerState.viewOverride`).
 *   6. The saved default ("Open threads on", D1 applied server-side).
 *   7. Overview.
 *
 * Steps 5 to 7 only describe where the thread OPENS, so they give way when
 * there is nothing to open on: no interpretation yet, or a message whose
 * original is the primary view (short mail, security mail). Then the thread
 * opens on Conversation, exactly like before the brief existed. An explicit
 * choice (3, 4) still shows the Overview, which then says why it is empty.
 *
 * Nothing here writes a preference; the reader writes the per-thread choice
 * only when the viewer clicks the switch (never from a cite).
 */
import type { ThreadView } from '@owlat/shared/threadBrief';

/** How far the brief read has got, as the view rule needs it. */
export type BriefAvailability =
	/** The brief query or the saved default has not answered yet. */
	| 'loading'
	/** No interpretation (AI off, not eligible, failed, not run yet). */
	| 'none'
	/** The original is the primary view (short mail, security mail). */
	| 'original'
	| 'available';

export interface ThreadViewInput {
	isShared: boolean;
	hasCite: boolean;
	queryView?: ThreadView | null;
	sessionChoice?: ThreadView | null;
	override?: ThreadView | null;
	/** `undefined` while the preference is loading. */
	savedDefault: ThreadView | undefined;
	availability: BriefAvailability;
}

/** The resolved view; `pending` renders a skeleton until both reads answer. */
export type ResolvedThreadView = ThreadView | 'pending';

export function resolveThreadView(input: ThreadViewInput): ResolvedThreadView {
	if (input.isShared || input.hasCite) return 'conversation';
	if (input.queryView) return input.queryView;
	if (input.sessionChoice) return input.sessionChoice;
	const opening = input.override ?? input.savedDefault;
	if (opening === 'conversation') return 'conversation';
	if (input.availability === 'none' || input.availability === 'original') return 'conversation';
	if (opening === undefined || input.availability === 'loading') return 'pending';
	return 'overview';
}

/** `?view=` as a view, or null for anything else. */
export function parseQueryView(raw: unknown): ThreadView | null {
	return raw === 'overview' || raw === 'conversation' ? raw : null;
}

/**
 * `?cite=<ref>:<quoteIndex>`: the item or fact id (or `latest-<n>` for a
 * "Latest update" line) and which of its quotes to show.
 */
export interface CiteParam {
	ref: string;
	quoteIndex: number;
}

export function parseCite(raw: unknown): CiteParam | null {
	if (typeof raw !== 'string') return null;
	const cut = raw.lastIndexOf(':');
	if (cut <= 0) return null;
	const quoteIndex = Number(raw.slice(cut + 1));
	if (!Number.isInteger(quoteIndex) || quoteIndex < 0) return null;
	return { ref: raw.slice(0, cut), quoteIndex };
}

export function formatCite(cite: CiteParam): string {
	return `${cite.ref}:${cite.quoteIndex}`;
}

/** The ref a "Latest update" line is cited by. */
export function latestCiteRef(lineIndex: number): string {
	return `latest-${lineIndex}`;
}
