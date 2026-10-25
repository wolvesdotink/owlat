/**
 * The words a mail search hands to find in conversation when one of its
 * results opens: the first quoted phrase, else the free text. Never an
 * operator (`from:`, `is:`, a date): those match headers and flags, not words
 * in a body, and a query made only of them seeds nothing, so the reader does
 * not open on a highlight it would have to make up. A query with `OR` seeds
 * nothing either: which side matched this message is not known.
 *
 * Search itself matches words loosely and find matches them literally, so a
 * seed can find nothing in a body (a subject-only hit); the bar then says so
 * rather than marking something else.
 */
import type { MailSearchQuery } from '@owlat/shared/mailSearch';

/** Longest query find takes; longer pastes are cut. */
export const POSTBOX_FIND_MAX_QUERY = 200;

export function postboxFindTermsOf(parsed: MailSearchQuery): string | null {
	if (parsed.or?.length) return null;
	const words = (parsed.phrases?.[0] ?? parsed.text ?? '').trim();
	return words ? words.slice(0, POSTBOX_FIND_MAX_QUERY) : null;
}

/** The route query a mail-search hit opens its conversation with. */
export const POSTBOX_FIND_QUERY_PARAM = 'find';
