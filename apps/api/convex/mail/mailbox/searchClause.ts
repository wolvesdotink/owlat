/**
 * The search GRAMMAR as the backend sees it: the clause validator, the clause
 * type, and the predicate that decides whether one message row satisfies one
 * clause.
 *
 * Split out of `mailbox/search.ts` for the ~500 LOC rule in CONVENTIONS.md, and
 * it is the natural seam: everything here is PURE (or pure plus a name map),
 * driven entirely by what the web-side parser can emit, while what remains in
 * `search.ts` is the fan-out, the index choice and the cursor arithmetic. A
 * change to the query language lands here; a change to how a page is scanned
 * lands there.
 */

import { v } from 'convex/values';
import type { Doc, Id } from '../../_generated/dataModel';

/**
 * Excluded operands (`-from:ines`), per operator. Arrays because several
 * exclusions of one operator are a conjunction, unlike the positive operators
 * where the parser's last occurrence wins.
 */
export const searchNegationValidator = v.object({
	text: v.optional(v.array(v.string())),
	from: v.optional(v.array(v.string())),
	to: v.optional(v.array(v.string())),
	cc: v.optional(v.array(v.string())),
	bcc: v.optional(v.array(v.string())),
	subject: v.optional(v.array(v.string())),
	filename: v.optional(v.array(v.string())),
	labelName: v.optional(v.array(v.string())),
	folderRole: v.optional(v.array(v.string())),
});

/**
 * One conjunction of search terms — the whole query, or one side of an `OR`.
 * Shared between the top-level args and the `or` array so both sides of a
 * disjunction speak exactly the same grammar.
 */
export const searchClauseFields = {
	// Pre-parsed query payload; the web side calls
	// `parseSearchQuery(rawText)` before calling us so the parser
	// stays close to the UI.
	text: v.string(),
	// Quoted runs from the raw query ("exact phrase"). Their words are also in
	// `text`, so the search index still does the indexed narrowing; these
	// additionally require ADJACENCY, which a token index cannot express.
	// Already lowercased by the parser.
	phrases: v.optional(v.array(v.string())),
	from: v.optional(v.string()),
	to: v.optional(v.string()),
	cc: v.optional(v.string()),
	bcc: v.optional(v.string()),
	subject: v.optional(v.string()),
	// Attachment filename substring. Once this mailbox's `mailAttachments` index
	// is built, a text-free `filename:` query DRIVES the scan off it (see
	// `searchByFilename`) and so reaches attachments of any age; on a mailbox
	// whose index is still partial it stays the post-filter it always was,
	// narrowing a page rather than the scan.
	filename: v.optional(v.string()),
	hasAttachment: v.optional(v.boolean()),
	flagSeen: v.optional(v.boolean()),
	flagFlagged: v.optional(v.boolean()),
	folderRole: v.optional(v.string()),
	labelName: v.optional(v.string()),
	beforeMs: v.optional(v.number()),
	afterMs: v.optional(v.number()),
	// Raw RFC822 size bounds, in bytes, both strict.
	largerThan: v.optional(v.number()),
	smallerThan: v.optional(v.number()),
	not: v.optional(searchNegationValidator),
};

export const searchClauseValidator = v.object(searchClauseFields);

export type SearchClause = {
	text: string;
	phrases?: string[];
	from?: string;
	to?: string;
	cc?: string;
	bcc?: string;
	subject?: string;
	filename?: string;
	hasAttachment?: boolean;
	flagSeen?: boolean;
	flagFlagged?: boolean;
	folderRole?: string;
	labelName?: string;
	beforeMs?: number;
	afterMs?: number;
	largerThan?: number;
	smallerThan?: number;
	not?: {
		text?: string[];
		from?: string[];
		to?: string[];
		cc?: string[];
		bcc?: string[];
		subject?: string[];
		filename?: string[];
		labelName?: string[];
		folderRole?: string[];
	};
};

/** Names resolved once per request and shared by every clause that uses them. */
export interface ResolvedNames {
	folderByRole: Map<string, Id<'mailFolders'> | null>;
	labelByName: Map<string, Id<'mailLabels'> | null>;
}

/**
 * A clause whose `in:`/`label:` names no existing folder or label can never
 * match anything, so it is dropped before the scan instead of being carried
 * through it. When EVERY clause is dead the search short-circuits to empty.
 */
export function isDeadClause(clause: SearchClause, names: ResolvedNames): boolean {
	if (clause.folderRole && !names.folderByRole.get(clause.folderRole)) return true;
	if (clause.labelName && !names.labelByName.get(clause.labelName)) return true;
	return false;
}

function includesAll(haystack: string, needles: string[] | undefined): boolean {
	return !needles || needles.every((needle) => haystack.includes(needle));
}

function excludesAll(haystack: string, needles: string[] | undefined): boolean {
	return !needles || needles.every((needle) => !haystack.includes(needle));
}

/**
 * Does this message satisfy one clause?
 *
 * `filterText` decides whether the clause's free text is re-checked here.
 * Normally it is NOT: the search index already narrowed the scan to it, and a
 * strict substring re-check would throw away the index's stemming and
 * prefix-matching (searching "meetings" would stop finding "meeting"). A
 * disjunction has no single indexed text to narrow by, so those queries run
 * off the arrival index and every clause has to check its own text — coarser
 * matching, but the only honest option once the index is out of the picture.
 */
export function matchesClause(
	m: Doc<'mailMessages'>,
	clause: SearchClause,
	names: ResolvedNames,
	filterText: boolean
): boolean {
	const folderId = clause.folderRole ? names.folderByRole.get(clause.folderRole) : undefined;
	if (clause.folderRole && m.folderId !== folderId) return false;

	if (clause.from && !m.fromAddress.includes(clause.from)) return false;
	if (clause.to && !m.toAddresses.some((a) => a.includes(clause.to as string))) return false;
	if (clause.cc && !m.ccAddresses.some((a) => a.includes(clause.cc as string))) return false;
	if (clause.bcc && !m.bccAddresses.some((a) => a.includes(clause.bcc as string))) return false;
	if (clause.subject && !m.subject.toLowerCase().includes(clause.subject)) return false;

	const filenames = m.attachments.map((a) => a.filename.toLowerCase());
	if (clause.filename && !filenames.some((name) => name.includes(clause.filename as string))) {
		return false;
	}

	// Every quoted phrase must appear verbatim in the subject or the
	// snippet — the two fields the caller can actually see in a result row.
	const haystack = `${m.subject}\n${m.snippet}`.toLowerCase();
	if (clause.phrases && !includesAll(haystack, clause.phrases)) return false;
	if (filterText && clause.text) {
		const words = clause.text.toLowerCase().split(/\s+/).filter(Boolean);
		if (!includesAll(haystack, words)) return false;
	}

	if (clause.hasAttachment !== undefined && m.hasAttachments !== clause.hasAttachment) return false;
	if (clause.flagSeen !== undefined && m.flagSeen !== clause.flagSeen) return false;
	if (clause.flagFlagged !== undefined && m.flagFlagged !== clause.flagFlagged) return false;

	if (clause.labelName) {
		const labelId = names.labelByName.get(clause.labelName);
		if (!labelId || !m.labelIds.includes(labelId)) return false;
	}

	if (clause.beforeMs !== undefined && m.receivedAt >= clause.beforeMs) return false;
	if (clause.afterMs !== undefined && m.receivedAt <= clause.afterMs) return false;
	if (clause.largerThan !== undefined && m.rawSize <= clause.largerThan) return false;
	if (clause.smallerThan !== undefined && m.rawSize >= clause.smallerThan) return false;

	const not = clause.not;
	if (not) {
		if (!excludesAll(haystack, not.text)) return false;
		if (!excludesAll(m.fromAddress, not.from)) return false;
		if (!excludesAll(m.toAddresses.join(' '), not.to)) return false;
		if (!excludesAll(m.ccAddresses.join(' '), not.cc)) return false;
		if (!excludesAll(m.bccAddresses.join(' '), not.bcc)) return false;
		if (!excludesAll(m.subject.toLowerCase(), not.subject)) return false;
		if (!excludesAll(filenames.join('\n'), not.filename)) return false;
		// An exclusion that names a label or folder which does not exist excludes
		// nothing — it must not silently empty the result set.
		for (const name of not.labelName ?? []) {
			const labelId = names.labelByName.get(name);
			if (labelId && m.labelIds.includes(labelId)) return false;
		}
		for (const role of not.folderRole ?? []) {
			const excluded = names.folderByRole.get(role);
			if (excluded && m.folderId === excluded) return false;
		}
	}

	return true;
}
