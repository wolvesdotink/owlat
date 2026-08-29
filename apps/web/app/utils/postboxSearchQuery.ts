/**
 * Postbox search grammar — tokenizer, parser and the helpers the chips use.
 *
 * Pure: no Convex, no Vue. `usePostboxSearch` wraps it in a subscription and
 * the search page renders chips off it, but the grammar itself is testable
 * without mounting anything.
 *
 * Double quotes group whitespace, both around an operator's value
 * (`subject:"quarterly report"`) and on their own (`"exact phrase"`). A bare
 * quoted run becomes a PHRASE: its words still go to the backend's full-text
 * index (so the scan stays indexed and paginated), and the backend additionally
 * requires the words to appear adjacently, which the token index alone cannot
 * express.
 *
 * Beyond the plain `op:value` conjunction the grammar carries two shapes that
 * the wire has to represent explicitly:
 *
 *  - NEGATION. A leading `-` inverts one term (`-from:ines`, `-invoice`,
 *    `-"exact phrase"`). Substring operators collect into `not`, so several
 *    exclusions of the same operator can coexist (`-from:a -from:b`); the
 *    boolean operators (`is:` / `has:`) have nothing to collect and simply
 *    flip. Date and size operators take no negation — `-before:X` is read as
 *    `before:X`, because "not before" and "after" differ at the boundary and a
 *    silently-shifted boundary is worse than an ignored minus.
 *  - SINGLE-LEVEL OR. An unquoted, uppercase `OR` splits the query into
 *    top-level alternatives: `from:a OR from:b` is one clause per side and a
 *    message matches if ANY clause matches. There is no nesting and no
 *    parenthesis grammar, which keeps the wire a flat `or: clause[]` and keeps
 *    the backend's post-filter a single `.some()`.
 */

/** One lexed token: its text, and whether the text came from inside quotes. */
export interface SearchToken {
	/** `subject:"a b"` → `subject:a b`; quotes are consumed, not kept. */
	raw: string;
	/** True when any part of this token was quoted. */
	quoted: boolean;
}

/**
 * Excluded operands, per operator. Arrays because `-from:a -from:b` is a
 * meaningful conjunction of exclusions, unlike the positive `from:` which the
 * last occurrence simply wins.
 */
export interface SearchNegations {
	text?: string[];
	from?: string[];
	to?: string[];
	cc?: string[];
	bcc?: string[];
	subject?: string[];
	filename?: string[];
	labelName?: string[];
	folderRole?: string[];
}

/** One conjunction of terms — the whole query, or one side of an `OR`. */
export interface ParsedSearchClause {
	text: string;
	/** Quoted runs that must appear verbatim, not merely as loose tokens. */
	phrases?: string[];
	from?: string;
	to?: string;
	cc?: string;
	bcc?: string;
	subject?: string;
	/** Attachment filename substring (`filename:invoice`). */
	filename?: string;
	hasAttachment?: boolean;
	flagSeen?: boolean;
	flagFlagged?: boolean;
	folderRole?: string;
	labelName?: string;
	beforeMs?: number;
	afterMs?: number;
	/** `larger:5M` — raw message size strictly greater than this many bytes. */
	largerThan?: number;
	/** `smaller:5M` — raw message size strictly less than this many bytes. */
	smallerThan?: number;
	not?: SearchNegations;
}

export interface ParsedSearchQuery extends ParsedSearchClause {
	/**
	 * Alternatives introduced by a top-level `OR`. Absent for the ordinary
	 * all-conjunction query, so the common case ships the exact payload it
	 * shipped before this grammar grew.
	 */
	or?: ParsedSearchClause[];
}

/**
 * Operators whose negation is a plain substring exclusion, so they all take
 * the same path. `label:` and `in:` also negate, but their operand is a name
 * the backend has to resolve to an id first, so they are handled by name.
 */
const NEGATABLE_SUBSTRING_OPERATORS: readonly string[] = [
	'from',
	'to',
	'cc',
	'bcc',
	'subject',
	'filename',
];

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

/**
 * True for the disjunction keyword. Uppercase and unquoted only: lowercase
 * "or" is an ordinary English word that people really do search for, and
 * `"OR"` in quotes is the user asking for the literal.
 */
function isOrToken(token: SearchToken): boolean {
	return !token.quoted && token.raw === 'OR';
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

const SIZE_UNITS: Record<string, number> = {
	b: 1,
	k: 1024,
	kb: 1024,
	m: 1024 * 1024,
	mb: 1024 * 1024,
	g: 1024 * 1024 * 1024,
	gb: 1024 * 1024 * 1024,
};

/** `larger:5M` / `smaller:200k` / `larger:1048576` → bytes. */
export function parseSearchSize(raw: string): number | null {
	const m = raw
		.trim()
		.toLowerCase()
		.match(/^(\d+(?:\.\d+)?)(b|kb?|mb?|gb?)?$/);
	if (!m || m[1] === undefined) return null;
	const mult = SIZE_UNITS[m[2] ?? 'b'];
	if (mult === undefined) return null;
	return Math.round(parseFloat(m[1]) * mult);
}

/** Byte count back to the shorthand the operator accepts, for chip display. */
export function formatSearchSize(bytes: number): string {
	if (bytes >= SIZE_UNITS['g']!) return `${+(bytes / SIZE_UNITS['g']!).toFixed(1)}G`;
	if (bytes >= SIZE_UNITS['m']!) return `${+(bytes / SIZE_UNITS['m']!).toFixed(1)}M`;
	if (bytes >= SIZE_UNITS['k']!) return `${+(bytes / SIZE_UNITS['k']!).toFixed(1)}K`;
	return `${bytes}B`;
}

/** Strip a leading `-`, reporting whether one was there. */
function splitNegation(raw: string): { negated: boolean; body: string } {
	if (raw.startsWith('-') && raw.length > 1) return { negated: true, body: raw.slice(1) };
	return { negated: false, body: raw };
}

function pushNegation(clause: ParsedSearchClause, field: keyof SearchNegations, value: string) {
	const not = (clause.not ??= {});
	(not[field] ??= []).push(value);
}

/** Parse one conjunction of tokens; `null` when the run constrains nothing. */
function parseClause(tokens: SearchToken[]): ParsedSearchClause | null {
	const clause: ParsedSearchClause = { text: '' };
	const remaining: string[] = [];
	const phrases: string[] = [];
	for (const token of tokens) {
		if (!token.raw) continue;
		const { negated, body } = splitNegation(token.raw);
		if (!body) continue;
		const colon = body.indexOf(':');
		// A quoted run with no operator is a phrase, not an operator token — and
		// `"10:30 standup"` must not be read as an `10:` operator.
		if (colon < 0 || (token.quoted && !/^[a-z_]+:/i.test(body))) {
			if (negated) {
				pushNegation(clause, 'text', body.toLowerCase());
				continue;
			}
			if (token.quoted && /\s/.test(body)) phrases.push(body.toLowerCase());
			remaining.push(body);
			continue;
		}
		const op = body.slice(0, colon).toLowerCase();
		const val = body.slice(colon + 1);
		if (!val) continue;
		// The substring operators share one negation path: `-op:v` records an
		// exclusion instead of a constraint, and several may pile up.
		if (negated && NEGATABLE_SUBSTRING_OPERATORS.includes(op)) {
			pushNegation(clause, op as keyof SearchNegations, val.toLowerCase());
			continue;
		}
		switch (op) {
			case 'from':
				clause.from = val.toLowerCase();
				break;
			case 'to':
				clause.to = val.toLowerCase();
				break;
			case 'cc':
				clause.cc = val.toLowerCase();
				break;
			case 'bcc':
				clause.bcc = val.toLowerCase();
				break;
			case 'subject':
				clause.subject = val.toLowerCase();
				break;
			case 'filename':
				clause.filename = val.toLowerCase();
				break;
			case 'has':
				if (val === 'attachment') clause.hasAttachment = !negated;
				else if (val === 'no-attachment') clause.hasAttachment = negated;
				else remaining.push(body);
				break;
			case 'is':
				if (val === 'unread') clause.flagSeen = negated;
				else if (val === 'read') clause.flagSeen = !negated;
				else if (val === 'starred' || val === 'flagged') clause.flagFlagged = !negated;
				else remaining.push(body);
				break;
			case 'in':
				if (negated) pushNegation(clause, 'folderRole', val.toLowerCase());
				else clause.folderRole = val.toLowerCase();
				break;
			case 'label':
				if (negated) pushNegation(clause, 'labelName', val.toLowerCase());
				else clause.labelName = val.toLowerCase();
				break;
			case 'larger': {
				const size = parseSearchSize(val);
				if (size != null) clause.largerThan = size;
				else remaining.push(body);
				break;
			}
			case 'smaller': {
				const size = parseSearchSize(val);
				if (size != null) clause.smallerThan = size;
				else remaining.push(body);
				break;
			}
			case 'before': {
				const ts = Date.parse(val);
				if (!Number.isNaN(ts)) clause.beforeMs = ts;
				else remaining.push(body);
				break;
			}
			case 'after': {
				const ts = Date.parse(val);
				if (!Number.isNaN(ts)) clause.afterMs = ts;
				else remaining.push(body);
				break;
			}
			case 'older_than': {
				const dur = parseDuration(val);
				if (dur != null) clause.beforeMs = Date.now() - dur;
				else remaining.push(body);
				break;
			}
			case 'newer_than': {
				const dur = parseDuration(val);
				if (dur != null) clause.afterMs = Date.now() - dur;
				else remaining.push(body);
				break;
			}
			default:
				remaining.push(negated ? token.raw : body);
		}
	}
	clause.text = remaining.join(' ').trim();
	if (phrases.length > 0) clause.phrases = phrases;
	// A run that constrains nothing (`from:a OR` while typing) must not be sent:
	// an empty clause matches every message and would widen the disjunction to
	// the whole mailbox.
	const constrains = Object.keys(clause).some((key) => key !== 'text') || clause.text !== '';
	return constrains ? clause : null;
}

export function parseSearchQuery(input: string): ParsedSearchQuery {
	const groups: SearchToken[][] = [[]];
	for (const token of tokenizeSearchQuery(input)) {
		if (isOrToken(token)) groups.push([]);
		else groups[groups.length - 1]!.push(token);
	}
	const clauses = groups
		.map(parseClause)
		.filter((clause): clause is ParsedSearchClause => clause !== null);
	const [primary, ...rest] = clauses;
	if (!primary) return { text: '' };
	return rest.length > 0 ? { ...primary, or: rest } : primary;
}

/**
 * Drop every occurrence of one operator from a raw query string.
 *
 * The key is SIGN-AWARE: `from` removes the positive terms and `-from` removes
 * the exclusions, matching the chips one for one. A blunt sign-blind removal
 * would make the `-from: noise` chip delete the `from: ines` the user is
 * actually searching for.
 *
 * Re-lexes and rebuilds rather than running a regex over the raw text: a regex
 * for `key:[^\s]+` stops at the first space, so it left the tail of a quoted
 * value (`subject:"quarterly report"` → a stray `report"`) behind in the box.
 */
export function removeSearchOperator(input: string, key: string): string {
	const wantNegated = key.startsWith('-');
	const prefix = `${(wantNegated ? key.slice(1) : key).toLowerCase()}:`;
	return renderTokens(
		tokenizeSearchQuery(input).filter((token) => {
			const { negated, body } = splitNegation(token.raw);
			if (!body.toLowerCase().startsWith(prefix)) return true;
			return negated !== wantNegated;
		})
	);
}

/**
 * Drop every operator, keeping the free text — including its quoting.
 *
 * Backs "Clear all filters". Rebuilding from `parsed.text` instead would strip
 * the quotes off a phrase, silently downgrading `"exact phrase"` to two loose
 * words the moment the user cleared an unrelated operator.
 */
export function stripSearchOperators(input: string): string {
	return renderTokens(
		tokenizeSearchQuery(input).filter((token) => !/^[a-z_]+:/i.test(splitNegation(token.raw).body))
	);
}

/**
 * Join tokens back into a query string, re-quoting what needs it and dropping
 * the `OR`s that a removal left dangling — `from:a OR from:b` minus `from` is
 * a bare `OR`, which would otherwise re-parse into an empty alternative.
 */
function renderTokens(tokens: SearchToken[]): string {
	const kept: SearchToken[] = [];
	for (const token of tokens) {
		if (isOrToken(token) && (kept.length === 0 || isOrToken(kept[kept.length - 1]!))) continue;
		kept.push(token);
	}
	while (kept.length > 0 && isOrToken(kept[kept.length - 1]!)) kept.pop();
	return kept
		.map((token) => (token.quoted || /\s/.test(token.raw) ? quoteToken(token.raw) : token.raw))
		.join(' ')
		.trim();
}

/** Re-quote a token for display, keeping `-op:"value with spaces"` shape. */
function quoteToken(raw: string): string {
	const { negated, body } = splitNegation(raw);
	const colon = body.indexOf(':');
	const requoted =
		colon > 0 && /^[a-z_]+:/i.test(body)
			? `${body.slice(0, colon)}:"${body.slice(colon + 1)}"`
			: `"${body}"`;
	return negated ? `-${requoted}` : requoted;
}

export interface SearchChip {
	/** Operator name, so removal can drop every occurrence of it. */
	key: string;
	label: string;
}

/**
 * Build the filter chips for a parsed query.
 *
 * Chips echo the grammar the user typed (`from: sara`, `-label: noise`), so
 * they are deliberately not translated prose: the operator names are the
 * product's search language and are the same in every locale. Alternatives
 * from an `OR` contribute their chips too, deduplicated, because a chip's
 * removal already spans the whole raw query.
 */
export function describeChips(parsed: ParsedSearchQuery): SearchChip[] {
	const chips: SearchChip[] = [];
	const seen = new Set<string>();
	const push = (key: string, label: string) => {
		const id = `${key} ${label}`;
		if (seen.has(id)) return;
		seen.add(id);
		chips.push({ key, label });
	};
	for (const clause of [parsed, ...(parsed.or ?? [])]) {
		if (clause.from) push('from', `from: ${clause.from}`);
		if (clause.to) push('to', `to: ${clause.to}`);
		if (clause.cc) push('cc', `cc: ${clause.cc}`);
		if (clause.bcc) push('bcc', `bcc: ${clause.bcc}`);
		if (clause.subject) push('subject', `subject: ${clause.subject}`);
		if (clause.filename) push('filename', `filename: ${clause.filename}`);
		if (clause.hasAttachment === true) push('has', 'has: attachment');
		if (clause.hasAttachment === false) push('has', 'has: no attachment');
		if (clause.flagSeen === false) push('is', 'is: unread');
		if (clause.flagSeen === true) push('is', 'is: read');
		if (clause.flagFlagged === true) push('is', 'is: starred');
		if (clause.folderRole) push('in', `in: ${clause.folderRole}`);
		if (clause.labelName) push('label', `label: ${clause.labelName}`);
		if (clause.largerThan !== undefined)
			push('larger', `larger: ${formatSearchSize(clause.largerThan)}`);
		if (clause.smallerThan !== undefined)
			push('smaller', `smaller: ${formatSearchSize(clause.smallerThan)}`);
		if (clause.beforeMs)
			push('before', `before: ${new Date(clause.beforeMs).toLocaleDateString()}`);
		if (clause.afterMs) push('after', `after: ${new Date(clause.afterMs).toLocaleDateString()}`);
		for (const [field, values] of Object.entries(clause.not ?? {})) {
			if (field === 'text') continue;
			const op = field === 'labelName' ? 'label' : field === 'folderRole' ? 'in' : field;
			for (const value of values) push(`-${op}`, `-${op}: ${value}`);
		}
	}
	return chips;
}
