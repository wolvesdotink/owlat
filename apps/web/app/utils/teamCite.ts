/**
 * Source markers on team surfaces (SPEC §7 "Team"): who sent a message of the
 * thread and when, read from the team stream, and which message a marker
 * points at. Pure.
 */
import type {
	TeamOpenItemsView,
	TeamStreamEntry,
} from '../../../api/convex/mail/interpret/briefShape';
import type { BriefSource } from '~/utils/threadBriefContext';

/** The sender and date of each email the stream has loaded, by message id. */
export function streamSources(entries: readonly TeamStreamEntry[]): Map<string, BriefSource> {
	const out = new Map<string, BriefSource>();
	for (const entry of entries) {
		if (entry.kind === 'customerEmail') {
			out.set(entry.source.id, {
				...(entry.fromName ? { name: entry.fromName } : {}),
				...(entry.fromEmail ? { email: entry.fromEmail } : {}),
				at: entry.at,
			});
		} else if (entry.kind === 'teamReply' && entry.source) {
			out.set(entry.source.id, { ...(entry.toName ? { name: entry.toName } : {}), at: entry.at });
		}
	}
	return out;
}

/** The message a marker (`<itemId>` or `<itemId>~pending`, quote index) points at. */
export function citedMessageId(
	view: TeamOpenItemsView | null | undefined,
	ref: string,
	quoteIndex: number
): string | null {
	if (!view) return null;
	const pending = /^(.+)~pending$/.exec(ref);
	const itemId = pending ? pending[1] : ref;
	const item = [...view.forTeam, ...view.unclear, ...view.waitingOnOthers].find(
		(i) => i.id === itemId
	);
	const evidence = pending ? item?.pendingUpdate?.evidence : item?.evidence;
	const quote = evidence?.[quoteIndex] ?? evidence?.[0];
	return quote?.source.id ?? null;
}
