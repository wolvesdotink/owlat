/**
 * Reactive Postbox search wrapper.
 *
 * Parses the user's free-form query into operators (`from:` / `is:` /
 * `before:` etc.) on the client, then hands the structured payload to
 * the Convex `mailMailbox.search` query.
 *
 * Double quotes group whitespace, both around an operator's value
 * (`subject:"quarterly report"`) and on their own (`"exact phrase"`). A bare
 * quoted run becomes a PHRASE: its words still go to the backend's full-text
 * index (so the scan stays indexed and paginated), and the backend additionally
 * requires the words to appear adjacently, which the token index alone cannot
 * express.
 */

import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

interface ParsedSearchQuery {
	text: string;
	/** Quoted runs that must appear verbatim, not merely as loose tokens. */
	phrases?: string[];
	from?: string;
	to?: string;
	subject?: string;
	hasAttachment?: boolean;
	flagSeen?: boolean;
	flagFlagged?: boolean;
	folderRole?: string;
	labelName?: string;
	beforeMs?: number;
	afterMs?: number;
}

/** One lexed token: its text, and whether the text came from inside quotes. */
interface SearchToken {
	/** `subject:"a b"` → `subject:a b`; quotes are consumed, not kept. */
	raw: string;
	/** True when any part of this token was quoted. */
	quoted: boolean;
}

/**
 * Split on whitespace, except inside double quotes.
 *
 * Quotes bind to the token they touch, so `subject:"a b"` stays ONE token
 * (previously it split into `subject:"a` plus a stray `b"`, which silently
 * searched for a leading-quote fragment and dumped the rest into free text).
 * An unclosed quote runs to the end of the input rather than being dropped, so
 * a half-typed query still searches for what has been typed so far.
 */
export function tokenizeSearchQuery(input: string): SearchToken[] {
	const tokens: SearchToken[] = [];
	let current = '';
	let quoted = false;
	let inQuotes = false;
	const flush = () => {
		if (current || quoted) tokens.push({ raw: current, quoted });
		current = '';
		quoted = false;
	};
	for (const ch of input) {
		if (ch === '"') {
			inQuotes = !inQuotes;
			quoted = true;
			continue;
		}
		if (!inQuotes && /\s/.test(ch)) {
			flush();
			continue;
		}
		current += ch;
	}
	flush();
	return tokens;
}

function parseDuration(raw: string): number | null {
	const m = raw.match(/^(\d+)([dhm])$/);
	if (!m || m[1] === undefined || m[2] === undefined) return null;
	const n = parseInt(m[1], 10);
	const unit = m[2];
	if (unit === 'd') return n * 24 * 60 * 60 * 1000;
	if (unit === 'h') return n * 60 * 60 * 1000;
	if (unit === 'm') return n * 60 * 1000;
	return null;
}

export function parseSearchQuery(input: string): ParsedSearchQuery {
	const result: ParsedSearchQuery = { text: '' };
	const remaining: string[] = [];
	const phrases: string[] = [];
	for (const token of tokenizeSearchQuery(input)) {
		const tok = token.raw;
		if (!tok) continue;
		const colon = tok.indexOf(':');
		// A quoted run with no operator is a phrase, not an operator token — and
		// `"10:30 standup"` must not be read as an `10:` operator.
		if (colon < 0 || (token.quoted && !/^[a-z_]+:/i.test(tok))) {
			if (token.quoted && /\s/.test(tok)) phrases.push(tok.toLowerCase());
			remaining.push(tok);
			continue;
		}
		const op = tok.slice(0, colon).toLowerCase();
		const val = tok.slice(colon + 1);
		if (!val) continue;
		switch (op) {
			case 'from':
				result.from = val.toLowerCase();
				break;
			case 'to':
				result.to = val.toLowerCase();
				break;
			case 'subject':
				result.subject = val.toLowerCase();
				break;
			case 'has':
				if (val === 'attachment') result.hasAttachment = true;
				else if (val === 'no-attachment') result.hasAttachment = false;
				else remaining.push(tok);
				break;
			case 'is':
				if (val === 'unread') result.flagSeen = false;
				else if (val === 'read') result.flagSeen = true;
				else if (val === 'starred' || val === 'flagged') result.flagFlagged = true;
				else remaining.push(tok);
				break;
			case 'in':
				result.folderRole = val.toLowerCase();
				break;
			case 'label':
				result.labelName = val.toLowerCase();
				break;
			case 'before': {
				const ts = Date.parse(val);
				if (!Number.isNaN(ts)) result.beforeMs = ts;
				else remaining.push(tok);
				break;
			}
			case 'after': {
				const ts = Date.parse(val);
				if (!Number.isNaN(ts)) result.afterMs = ts;
				else remaining.push(tok);
				break;
			}
			case 'older_than': {
				const dur = parseDuration(val);
				if (dur != null) result.beforeMs = Date.now() - dur;
				else remaining.push(tok);
				break;
			}
			case 'newer_than': {
				const dur = parseDuration(val);
				if (dur != null) result.afterMs = Date.now() - dur;
				else remaining.push(tok);
				break;
			}
			default:
				remaining.push(tok);
		}
	}
	result.text = remaining.join(' ').trim();
	if (phrases.length > 0) result.phrases = phrases;
	return result;
}

/**
 * Drop every occurrence of one operator from a raw query string.
 *
 * Re-lexes and rebuilds rather than running a regex over the raw text: a regex
 * for `key:[^\s]+` stops at the first space, so it left the tail of a quoted
 * value (`subject:"quarterly report"` → a stray `report"`) behind in the box.
 */
export function removeSearchOperator(input: string, key: string): string {
	const prefix = `${key.toLowerCase()}:`;
	return tokenizeSearchQuery(input)
		.filter((token) => !token.raw.toLowerCase().startsWith(prefix))
		.map((token) => (token.quoted || /\s/.test(token.raw) ? quoteToken(token.raw) : token.raw))
		.join(' ')
		.trim();
}

/**
 * Drop every operator, keeping the free text — including its quoting.
 *
 * Backs "Clear all filters". Rebuilding from `parsed.text` instead would strip
 * the quotes off a phrase, silently downgrading `"exact phrase"` to two loose
 * words the moment the user cleared an unrelated operator.
 */
export function stripSearchOperators(input: string): string {
	return tokenizeSearchQuery(input)
		.filter((token) => !/^[a-z_]+:/i.test(token.raw))
		.map((token) => (token.quoted || /\s/.test(token.raw) ? quoteToken(token.raw) : token.raw))
		.join(' ')
		.trim();
}

/** Re-quote a token for display, keeping `op:"value with spaces"` shape. */
function quoteToken(raw: string): string {
	const colon = raw.indexOf(':');
	if (colon > 0 && /^[a-z_]+:/i.test(raw)) {
		return `${raw.slice(0, colon)}:"${raw.slice(colon + 1)}"`;
	}
	return `"${raw}"`;
}

export function usePostboxSearch(mailboxId: Ref<Id<'mailboxes'> | null>, query: Ref<string>) {
	const parsed = computed(() => parseSearchQuery(query.value));

	// Keyset-paginated: "Load more" walks past the first page via the backend's
	// opaque cursor instead of silently stopping at the old 200-row cap. Any
	// change to the parsed query restarts from a fresh first page.
	const { rows, isLoading, isLoadingMore, hasMore, canLoadMore, loadMore } = usePostboxCursorFeed(
		api.mail.mailbox.search,
		() => {
			if (!mailboxId.value) return 'skip';
			const trimmed = query.value.trim();
			if (!trimmed) return 'skip';
			return {
				mailboxId: mailboxId.value,
				...parsed.value,
				limit: 50,
			};
		},
		computed(() => JSON.stringify(parsed.value)),
		{ keepPreviousData: true }
	);

	return { parsed, results: rows, isLoading, isLoadingMore, hasMore, canLoadMore, loadMore };
}

/** Build human-readable filter chips from a parsed query. */
export function describeChips(parsed: ParsedSearchQuery): Array<{ key: string; label: string }> {
	const chips: Array<{ key: string; label: string }> = [];
	if (parsed.from) chips.push({ key: 'from', label: `from: ${parsed.from}` });
	if (parsed.to) chips.push({ key: 'to', label: `to: ${parsed.to}` });
	if (parsed.subject) chips.push({ key: 'subject', label: `subject: ${parsed.subject}` });
	if (parsed.hasAttachment === true) chips.push({ key: 'has', label: 'has: attachment' });
	if (parsed.hasAttachment === false) chips.push({ key: 'has', label: 'has: no attachment' });
	if (parsed.flagSeen === false) chips.push({ key: 'is', label: 'is: unread' });
	if (parsed.flagSeen === true) chips.push({ key: 'is', label: 'is: read' });
	if (parsed.flagFlagged === true) chips.push({ key: 'is', label: 'is: starred' });
	if (parsed.folderRole) chips.push({ key: 'in', label: `in: ${parsed.folderRole}` });
	if (parsed.labelName) chips.push({ key: 'label', label: `label: ${parsed.labelName}` });
	if (parsed.beforeMs)
		chips.push({
			key: 'before',
			label: `before: ${new Date(parsed.beforeMs).toLocaleDateString()}`,
		});
	if (parsed.afterMs)
		chips.push({ key: 'after', label: `after: ${new Date(parsed.afterMs).toLocaleDateString()}` });
	return chips;
}
