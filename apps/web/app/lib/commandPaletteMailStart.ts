/**
 * What Mail scope offers before anything is typed, and what it offers after a
 * search that found nothing.
 *
 * An empty box has run no search, so it must not report "no matches"; it is the
 * moment to show where a search can start: the mailbox's saved searches, the
 * people mailed most (each a `from:` search), and a few operators worth
 * knowing. Every row fills the box rather than leaving the overlay, so the live
 * hits answer right away and the query can still be refined before Enter.
 *
 * Pure: the composable hands in the loaded rows, the translator and the
 * callback that rewrites the box.
 */
import type { PaletteItem } from './commandPalette';
import { withoutLastOperator } from '~/utils/postboxSearchSuggest';

const MESSAGE_ROOT = 'shared.commandPaletteMailStart';

/** Complete terms that each answer a common question, run as they are. */
export const MAIL_START_EXAMPLES: ReadonlyArray<{ query: string; hintKey: string }> = [
	{ query: 'has:attachment', hintKey: `${MESSAGE_ROOT}.examples.hasAttachment` },
	{ query: 'is:unread', hintKey: `${MESSAGE_ROOT}.examples.isUnread` },
	{ query: 'older_than:30d', hintKey: `${MESSAGE_ROOT}.examples.olderThan30d` },
];

/** How many people the empty box suggests. */
export const MAIL_START_PEOPLE_LIMIT = 3;

/** How many address-book rows the ranking reads, newest first. */
export const MAIL_START_CONTACT_WINDOW = 50;

export interface MailStartContact {
	email: string;
	displayName?: string;
	/** Bumped each time the user sends to this address. */
	useCount: number;
	lastUsedAt: number;
}

export interface MailStartSavedSearch {
	_id: string;
	name: string;
	rawQuery: string;
}

/**
 * The people mailed most among the recently used address-book rows. The window
 * is the newest rows, so someone mailed often years ago does not outrank this
 * month's correspondents; inside it, the send count decides.
 */
export function frequentCorrespondents<T extends MailStartContact>(
	contacts: readonly T[],
	limit = MAIL_START_PEOPLE_LIMIT
): T[] {
	return contacts
		.filter((contact) => contact.useCount > 0)
		.sort((a, b) => b.useCount - a.useCount || b.lastUsedAt - a.lastUsedAt)
		.slice(0, limit);
}

type Translate = (key: string, params?: Record<string, string>) => string;

export interface MailStartItems {
	saved: PaletteItem[];
	people: PaletteItem[];
	examples: PaletteItem[];
}

/** The empty box's rows. `apply` puts a query in the box and keeps the overlay open. */
export function buildMailStartItems(input: {
	savedSearches: readonly MailStartSavedSearch[];
	contacts: readonly MailStartContact[];
	t: Translate;
	apply: (query: string) => void;
}): MailStartItems {
	const { t, apply } = input;
	return {
		saved: input.savedSearches.map((search) => ({
			id: `mail-saved:${search._id}`,
			label: search.name,
			subtitle: search.rawQuery,
			icon: 'lucide:bookmark',
			keepOpen: true,
			run: () => apply(search.rawQuery),
		})),
		people: frequentCorrespondents(input.contacts).map((contact) => ({
			id: `mail-person:${contact.email}`,
			label: contact.displayName || contact.email,
			subtitle: `from:${contact.email}`,
			icon: 'lucide:user',
			keepOpen: true,
			run: () => apply(`from:${contact.email}`),
		})),
		examples: MAIL_START_EXAMPLES.map((example) => ({
			id: `mail-example:${example.query}`,
			label: example.query,
			subtitle: t(example.hintKey),
			icon: 'lucide:terminal',
			keepOpen: true,
			run: () => apply(example.query),
		})),
	};
}

/**
 * The way out of a search that found nothing: the same query without the
 * operator added last. Empty when there is no operator to drop; the deep
 * search row under it still runs the words as typed.
 */
export function buildMailFixItems(
	query: string,
	t: Translate,
	apply: (query: string) => void
): PaletteItem[] {
	const fix = withoutLastOperator(query);
	if (!fix) return [];
	return [
		{
			id: `mail-fix:${fix.rest}`,
			label: t(`${MESSAGE_ROOT}.withoutOperator`, { operator: fix.removed }),
			subtitle: fix.rest,
			icon: 'lucide:undo-2',
			keepOpen: true,
			run: () => apply(fix.rest),
		},
	];
}
