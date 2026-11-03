/**
 * Postbox search chips: the helpers that edit a raw query string and describe
 * a parsed one.
 *
 * The grammar itself (tokenizer, parser, clause shape) lives in
 * `@owlat/shared/mailSearch`, next to the type the backend's validator is
 * checked against. What stays here is presentation: removing one operator
 * from the box, clearing every operator, and the chip labels the search page
 * renders.
 */

import {
	formatSearchSize,
	isPlainTextSearch,
	renderSearchTokens,
	splitNegation,
	tokenizeSearchQuery,
	type MailSearchQuery,
} from '@owlat/shared/mailSearch';

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
	return renderSearchTokens(
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
	return renderSearchTokens(
		tokenizeSearchQuery(input).filter((token) => !/^[a-z_]+:/i.test(splitNegation(token.raw).body))
	);
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
export function describeChips(parsed: MailSearchQuery): SearchChip[] {
	const chips: SearchChip[] = [];
	const seen = new Set<string>();
	const push = (key: string, label: string) => {
		const id = `${key}\0${label}`;
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

/** At most this many results counts as "found little" for the rewrite offer. */
const FEW_RESULTS = 3;

/**
 * Whether the search page offers to turn the query into operators: the query is
 * at least two loose words with no syntax, and the search has settled on a
 * handful of results or none. A query with operators was written by someone
 * who knows them, and a single word has nothing to translate.
 */
export function isSearchRewriteOffered(input: {
	parsed: MailSearchQuery;
	resultCount: number;
	hasMore: boolean;
	isLoading: boolean;
}): boolean {
	if (input.isLoading || input.hasMore || input.resultCount > FEW_RESULTS) return false;
	return isPlainTextSearch(input.parsed) && input.parsed.text.split(/\s+/).length >= 2;
}
