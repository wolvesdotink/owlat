/**
 * Search-bar autocomplete: what to offer for the token under the caret.
 *
 * The operator grammar was invisible — a plain input with a placeholder, and no
 * way to learn that `is:unread` exists short of reading docs. This turns the
 * grammar into something you can discover by typing: `fr` offers `from:`,
 * `from:in` offers the address book, `label:` offers the mailbox's labels, and
 * an empty box offers what you searched for last.
 *
 * Pure: it takes the caret position, the already-loaded contacts and labels,
 * and the recents list, and returns rows. No Convex, no localStorage reads, no
 * Vue — so the ranking is unit-testable without mounting the bar.
 *
 * Every human-readable hint is carried as an i18n KEY plus params and resolved
 * at the render boundary; nothing in this module is user-visible English.
 */

export type SuggestionKind = 'operator' | 'value' | 'recent';

export interface SearchSuggestion {
	/** Stable key for rendering and for keyboard selection. */
	id: string;
	kind: SuggestionKind;
	/** Replaces the active token, verbatim. */
	insert: string;
	/** The primary line — grammar or data, never translated prose. */
	label: string;
	/** Secondary line for grammar rows, resolved with `t(hint.key)` at render. */
	hint?: { key: string; params?: Record<string, string> };
	/**
	 * Secondary line for DATA rows — a contact's display name. Raw user text, so
	 * it is passed through rather than routed through the catalog.
	 */
	detail?: string;
	icon: string;
	/** Whether accepting this row completes a whole term (vs. opening one). */
	isTerminal: boolean;
}

const HINT_ROOT = 'components.postbox.postboxSearchBar.suggestions';

/**
 * The offered grammar, in the order it is offered. Entries with a trailing
 * colon open an operand (accepting them keeps the dropdown open on the value
 * list); the `is:`/`has:` entries are complete terms on their own, because
 * their operands are a closed set worth naming outright.
 */
const OPERATOR_REGISTRY: ReadonlyArray<{ token: string; hintKey: string; isTerminal: boolean }> = [
	{ token: 'from:', hintKey: `${HINT_ROOT}.from`, isTerminal: false },
	{ token: 'to:', hintKey: `${HINT_ROOT}.to`, isTerminal: false },
	{ token: 'cc:', hintKey: `${HINT_ROOT}.cc`, isTerminal: false },
	{ token: 'bcc:', hintKey: `${HINT_ROOT}.bcc`, isTerminal: false },
	{ token: 'subject:', hintKey: `${HINT_ROOT}.subject`, isTerminal: false },
	{ token: 'label:', hintKey: `${HINT_ROOT}.label`, isTerminal: false },
	{ token: 'in:', hintKey: `${HINT_ROOT}.in`, isTerminal: false },
	{ token: 'is:unread', hintKey: `${HINT_ROOT}.isUnread`, isTerminal: true },
	{ token: 'is:read', hintKey: `${HINT_ROOT}.isRead`, isTerminal: true },
	{ token: 'is:starred', hintKey: `${HINT_ROOT}.isStarred`, isTerminal: true },
	{ token: 'has:attachment', hintKey: `${HINT_ROOT}.hasAttachment`, isTerminal: true },
	{ token: 'has:no-attachment', hintKey: `${HINT_ROOT}.hasNoAttachment`, isTerminal: true },
	{ token: 'filename:', hintKey: `${HINT_ROOT}.filename`, isTerminal: false },
	{ token: 'larger:', hintKey: `${HINT_ROOT}.larger`, isTerminal: false },
	{ token: 'smaller:', hintKey: `${HINT_ROOT}.smaller`, isTerminal: false },
	{ token: 'before:', hintKey: `${HINT_ROOT}.before`, isTerminal: false },
	{ token: 'after:', hintKey: `${HINT_ROOT}.after`, isTerminal: false },
	{ token: 'newer_than:', hintKey: `${HINT_ROOT}.newerThan`, isTerminal: false },
	{ token: 'older_than:', hintKey: `${HINT_ROOT}.olderThan`, isTerminal: false },
];

/** System folder roles `in:` accepts, in rail order. */
const FOLDER_ROLES = ['inbox', 'sent', 'drafts', 'archive', 'spam', 'trash', 'snoozed'] as const;

/** Operators whose operand this module can complete from loaded data. */
const ADDRESS_OPERATORS = new Set(['from', 'to', 'cc', 'bcc']);

export interface ActiveToken {
	/** Index of the token's first character in the raw value. */
	start: number;
	/** Index one past the token's last character. */
	end: number;
	text: string;
}

/**
 * The token the caret sits in, honouring quotes.
 *
 * Splitting on plain whitespace would tear `subject:"quarterly re|` into a
 * trailing `re`, and the bar would then offer operator completions for "re"
 * while the user is halfway through typing a subject.
 */
export function activeSearchToken(value: string, caret: number): ActiveToken {
	const at = Math.max(0, Math.min(caret, value.length));
	let inQuotes = false;
	let start = 0;
	for (let i = 0; i < at; i++) {
		const ch = value[i]!;
		if (ch === '"') inQuotes = !inQuotes;
		else if (!inQuotes && /\s/.test(ch)) start = i + 1;
	}
	let end = at;
	let tailQuotes = inQuotes;
	while (end < value.length) {
		const ch = value[end]!;
		if (ch === '"') tailQuotes = !tailQuotes;
		else if (!tailQuotes && /\s/.test(ch)) break;
		end++;
	}
	return { start, end, text: value.slice(start, end) };
}

/** Replace the active token with `insert`, leaving the rest of the box alone. */
export function applySearchSuggestion(
	value: string,
	token: ActiveToken,
	insert: string
): { value: string; caret: number } {
	const next = `${value.slice(0, token.start)}${insert}${value.slice(token.end)}`;
	return { value: next, caret: token.start + insert.length };
}

/** Quote an operand that carries whitespace, so the tokenizer keeps it whole. */
function quoteOperand(value: string): string {
	return /\s/.test(value) ? `"${value}"` : value;
}

interface SuggestContact {
	email: string;
	displayName?: string;
}

interface SuggestLabel {
	name: string;
	color?: string;
}

export interface SuggestInput {
	/** The active token's text, exactly as typed (may carry a leading `-`). */
	token: string;
	contacts?: SuggestContact[];
	labels?: SuggestLabel[];
	/** Previous raw queries, most recent first. */
	recents?: string[];
	limit?: number;
}

/**
 * Rows for the token under the caret.
 *
 * An empty token offers history, a bare word offers the grammar, and an
 * `op:value` fragment offers that operator's values. A leading `-` is carried
 * through every completion so a negated term stays negated.
 */
export function buildSearchSuggestions(input: SuggestInput): SearchSuggestion[] {
	const limit = input.limit ?? 8;
	const raw = input.token;
	const negated = raw.startsWith('-') && raw.length > 1;
	const body = negated ? raw.slice(1) : raw;
	const sign = negated ? '-' : '';
	const colon = body.indexOf(':');

	if (colon > 0) {
		const op = body.slice(0, colon).toLowerCase();
		const typed = body.slice(colon + 1).toLowerCase();
		return operandSuggestions(op, typed, sign, input, limit);
	}

	const prefix = body.toLowerCase();
	const rows: SearchSuggestion[] = [];

	// An empty box has no grammar to complete, so history is the whole offer.
	if (!prefix) {
		rows.push(...recentRows(input.recents ?? [], '', limit));
		return rows;
	}

	for (const entry of OPERATOR_REGISTRY) {
		if (!entry.token.startsWith(prefix)) continue;
		rows.push({
			id: `operator:${entry.token}`,
			kind: 'operator',
			insert: `${sign}${entry.token}`,
			label: `${sign}${entry.token}`,
			hint: { key: entry.hintKey },
			icon: 'lucide:terminal',
			isTerminal: entry.isTerminal,
		});
		if (rows.length >= limit) return rows;
	}
	// History is ranked below the grammar: a completion the user is mid-way
	// through typing beats a query they ran yesterday.
	rows.push(...recentRows(input.recents ?? [], prefix, limit - rows.length));
	return rows.slice(0, limit);
}

function recentRows(recents: string[], prefix: string, limit: number): SearchSuggestion[] {
	if (limit <= 0) return [];
	return recents
		.filter((entry) => !prefix || entry.toLowerCase().includes(prefix))
		.slice(0, limit)
		.map((entry) => ({
			id: `recent:${entry}`,
			kind: 'recent' as const,
			// A recent entry is a WHOLE query, not a token: accepting it replaces
			// the box rather than the token under the caret. The bar handles that;
			// `insert` carries the query so both paths read the same field.
			insert: entry,
			label: entry,
			icon: 'lucide:history',
			isTerminal: true,
		}));
}

function operandSuggestions(
	op: string,
	typed: string,
	sign: string,
	input: SuggestInput,
	limit: number
): SearchSuggestion[] {
	// The operand may already be quoted (`label:"Big Name`); match on its text.
	const term = typed.replace(/^"|"$/g, '');

	if (ADDRESS_OPERATORS.has(op)) {
		return (input.contacts ?? [])
			.filter(
				(contact) =>
					!term ||
					contact.email.toLowerCase().includes(term) ||
					(contact.displayName ?? '').toLowerCase().includes(term)
			)
			.slice(0, limit)
			.map((contact) => ({
				id: `value:${op}:${contact.email}`,
				kind: 'value' as const,
				insert: `${sign}${op}:${quoteOperand(contact.email)}`,
				label: `${sign}${op}: ${contact.email}`,
				detail: contact.displayName,
				icon: 'lucide:user',
				isTerminal: true,
			}));
	}

	if (op === 'label') {
		return (input.labels ?? [])
			.filter((label) => !term || label.name.toLowerCase().includes(term))
			.slice(0, limit)
			.map((label) => ({
				id: `value:label:${label.name}`,
				kind: 'value' as const,
				insert: `${sign}label:${quoteOperand(label.name)}`,
				label: `${sign}label: ${label.name}`,
				icon: 'lucide:tag',
				isTerminal: true,
			}));
	}

	if (op === 'in') {
		return FOLDER_ROLES.filter((role) => !term || role.startsWith(term))
			.slice(0, limit)
			.map((role) => ({
				id: `value:in:${role}`,
				kind: 'value' as const,
				insert: `${sign}in:${role}`,
				label: `${sign}in: ${role}`,
				icon: 'lucide:folder',
				isTerminal: true,
			}));
	}

	// `is:` / `has:` reuse the operator registry — their values are grammar,
	// registered there once with their hints rather than duplicated here.
	if (op === 'is' || op === 'has') {
		return OPERATOR_REGISTRY.filter(
			(entry) =>
				entry.token.startsWith(`${op}:`) && entry.token.slice(op.length + 1).startsWith(term)
		)
			.slice(0, limit)
			.map((entry) => ({
				id: `operator:${entry.token}`,
				kind: 'operator' as const,
				insert: `${sign}${entry.token}`,
				label: `${sign}${entry.token}`,
				hint: { key: entry.hintKey },
				icon: 'lucide:terminal',
				isTerminal: true,
			}));
	}

	// Free-form operands (subject:, filename:, sizes, dates) have nothing to
	// complete from — offering a guess would be noise.
	return [];
}

/** localStorage key for the Postbox search history, mirroring the palette's. */
export const POSTBOX_RECENT_SEARCHES_KEY = 'owlat_postbox_recent_searches';
export const MAX_RECENT_POSTBOX_SEARCHES = 8;

/** Most-recent-first, deduplicated, capped. Pure — the storage IO is separate. */
export function pushRecentSearch(recents: string[], query: string): string[] {
	const trimmed = query.trim();
	if (!trimmed) return recents;
	return [trimmed, ...recents.filter((entry) => entry !== trimmed)].slice(
		0,
		MAX_RECENT_POSTBOX_SEARCHES
	);
}

export function loadRecentSearches(): string[] {
	if (import.meta.server) return [];
	try {
		const stored = localStorage.getItem(POSTBOX_RECENT_SEARCHES_KEY);
		const parsed: unknown = stored ? JSON.parse(stored) : [];
		return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === 'string') : [];
	} catch {
		return [];
	}
}

export function saveRecentSearches(recents: string[]): void {
	if (import.meta.server) return;
	try {
		localStorage.setItem(POSTBOX_RECENT_SEARCHES_KEY, JSON.stringify(recents));
	} catch {
		// Ignore quota / disabled storage — history is a convenience, not state.
	}
}
