/**
 * Saved-reply variables, resolved at insertion.
 *
 * A reply's text may carry `{{…}}` variables. The documented names are dotted
 * and say where the value comes from:
 *
 *   {{contact.firstName}} {{contact.lastName}} {{contact.email}}
 *   {{me.firstName}} {{me.name}} {{thread.subject}} {{today}}
 *
 * The older undotted spellings (`{{firstName}}`, `{{company}}`, `{{date}}`, …)
 * keep working, and a reply can DECLARE what any other token means (plan idea
 * 13): a fact the composer knows, or `prompt`, which asks the person inserting
 * it, for the one-off number or link a saved reply leaves blank.
 *
 * The `{{token}}` / `{{token|'fallback'}}` GRAMMAR is not reinvented here: it
 * is `@owlat/shared/templateVariables`, the same walk the email designer's
 * preview and the send path's personalization use. That grammar has no dotted
 * names, and widening it would change what the send path personalizes, so a
 * dotted name is spelled with underscores (`contact_firstName`) before the
 * walk; reply bodies are resolved entirely here, at insertion.
 *
 * WHAT AN UNRESOLVED VARIABLE BECOMES is the policy that matters: a `[[...]]`
 * gap, the same placeholder an AI draft leaves for a missing fact. The
 * composer highlights gaps and holds Send until each one is filled, so a
 * missing name can never go out as a raw placeholder. A reply may also carry
 * free gaps of its own (`[[order number]]`); they are left as they are.
 *
 * Module scope: no Vue, no Convex, no i18n. Labels are catalog keys, and the
 * text a gap shows comes from the caller.
 */

import { formatDraftGap, hasDraftGaps } from '@owlat/shared/answerMode';
import { escapeHtml, htmlToPlainText } from '@owlat/shared/html';
import {
	extractTemplateVariableNames,
	replaceTemplateVariables,
} from '@owlat/shared/templateVariables';

/** Where a reply variable gets its value from. */
export type SnippetVariableSource =
	| 'recipientFirstName'
	| 'recipientLastName'
	| 'recipientFullName'
	| 'recipientEmail'
	| 'recipientCompany'
	| 'senderFirstName'
	| 'senderName'
	| 'senderEmail'
	| 'threadSubject'
	| 'date'
	| 'prompt';

export const SNIPPET_VARIABLE_SOURCES: readonly SnippetVariableSource[] = [
	'recipientFirstName',
	'recipientLastName',
	'recipientFullName',
	'recipientEmail',
	'recipientCompany',
	'senderFirstName',
	'senderName',
	'senderEmail',
	'threadSubject',
	'date',
	'prompt',
];

const SOURCE_KEY_PREFIX = 'shared.postbox.snippetVariables.sources';

/** Catalog key for a source's label, resolved at the render boundary. */
export function snippetVariableSourceKey(source: SnippetVariableSource): string {
	return `${SOURCE_KEY_PREFIX}.${source}`;
}

/** One declared variable on a reply. */
export interface SnippetVariable {
	/** The token name, i.e. the `x` in `{{x}}`. */
	token: string;
	source: SnippetVariableSource;
	/** What the insert-time prompt asks for. Only meaningful for `prompt`. */
	label?: string;
}

/** Everything the composer knows at the moment of insertion. */
export type SnippetVariableContext = Partial<
	Record<Exclude<SnippetVariableSource, 'prompt'>, string | null>
>;

/** The documented variables, in the order the help lists them. */
export const SAVED_REPLY_VARIABLES = [
	'contact.firstName',
	'contact.lastName',
	'contact.email',
	'me.firstName',
	'me.name',
	'thread.subject',
	'today',
] as const;

/**
 * Tokens a body uses without declaring, mapped to the source they mean anyway,
 * keyed lower case without separators. The dotted names are the documented
 * set; `{{firstName}}` predates them and is in a great many saved snippets, and
 * the rest are the obvious spellings a person types before reading the help.
 */
const IMPLICIT_SOURCES: Readonly<Record<string, SnippetVariableSource>> = {
	contactfirstname: 'recipientFirstName',
	contactlastname: 'recipientLastName',
	contactname: 'recipientFullName',
	contactemail: 'recipientEmail',
	contactcompany: 'recipientCompany',
	mefirstname: 'senderFirstName',
	mename: 'senderName',
	meemail: 'senderEmail',
	threadsubject: 'threadSubject',
	firstname: 'recipientFirstName',
	lastname: 'recipientLastName',
	fullname: 'recipientFullName',
	name: 'recipientFullName',
	email: 'recipientEmail',
	company: 'recipientCompany',
	subject: 'threadSubject',
	date: 'date',
	today: 'date',
	sender: 'senderName',
	sendername: 'senderName',
	senderemail: 'senderEmail',
};

/** The declared source for a token, falling back to the implicit table. */
function sourceFor(
	token: string,
	declared: readonly SnippetVariable[]
): SnippetVariableSource | undefined {
	const explicit = declared.find((v) => v.token === token);
	if (explicit) return explicit.source;
	return IMPLICIT_SOURCES[token.toLowerCase().replace(/_/g, '')];
}

/**
 * `{{ contact.firstName }}` → `{{contact_firstName}}`.
 *
 * The shared grammar is deliberately strict about inner whitespace and has no
 * dots, because it is the grammar the SEND path personalizes with. Reply bodies
 * are resolved entirely client-side, at insertion, so they are normalized into
 * it first: people have hand-typed the spaced spelling since before there was
 * a variable system, and the documented names are dotted.
 */
function tightenTokens(bodyHtml: string, written?: Map<string, string>): string {
	return bodyHtml.replace(
		/\{\{\s*(\w+(?:\.\w+)*)\s*((?:\|'[^']*')?)\s*\}\}/g,
		(_match, name: string, fallback: string) => {
			const token = name.replace(/\./g, '_');
			written?.set(token, name);
			return `{{${token}${fallback}}}`;
		}
	);
}

/**
 * The documented variable a token is (`contact_firstName` → `contact.firstName`),
 * or null. Those explain themselves, so the variable editor lists only the rest.
 */
export function documentedVariable(token: string): string | null {
	const dotted = token.replace(/_/g, '.').toLowerCase();
	return SAVED_REPLY_VARIABLES.find((name) => name.toLowerCase() === dotted) ?? null;
}

/** Every distinct token a reply body uses, in reading order. */
export function snippetTokens(bodyHtml: string): string[] {
	const seen = new Set<string>();
	const ordered: string[] = [];
	for (const token of extractTemplateVariableNames(tightenTokens(bodyHtml))) {
		if (seen.has(token)) continue;
		seen.add(token);
		ordered.push(token);
	}
	return ordered;
}

/**
 * The declared `prompt` variables this reply body actually uses, in reading
 * order — i.e. exactly the fields the insert-time dialog should ask for. A
 * declaration for a token the body no longer contains asks nothing, so editing
 * a reply's text can never leave a stale question behind.
 */
export function promptedSnippetVariables(
	bodyHtml: string,
	declared: readonly SnippetVariable[]
): SnippetVariable[] {
	const used = new Set(snippetTokens(bodyHtml));
	return declared.filter((v) => v.source === 'prompt' && used.has(v.token));
}

export interface ResolveSnippetOptions {
	declared?: readonly SnippetVariable[];
	context?: SnippetVariableContext;
	/** Answers to the `prompt` variables, keyed by token. */
	answers?: Readonly<Record<string, string>>;
	/**
	 * The text of the gap an unresolved variable becomes, e.g. the localized
	 * label of its source. Default: the variable as it is written.
	 */
	gapLabel?: (token: string, source: SnippetVariableSource | undefined) => string;
}

export interface ResolvedSnippet {
	/** The body with every token substituted (values HTML-escaped) or made a gap. */
	html: string;
	/** Tokens that became gaps, as written in the body. */
	unresolved: string[];
	/** The result holds a `[[...]]` gap (one of ours or one the reply carried). */
	hasGaps: boolean;
}

/**
 * Resolve a reply body for insertion.
 *
 * Order per token: an answer the sender just typed → the context value for its
 * source → the token's own inline fallback → a gap. Values are HTML-escaped: a
 * recipient's name is untrusted data being spliced into the draft's markup.
 */
export function resolveSnippetBody(
	bodyHtml: string,
	options: ResolveSnippetOptions = {}
): ResolvedSnippet {
	const declared = options.declared ?? [];
	const context = options.context ?? {};
	const answers = options.answers ?? {};
	const unresolved: string[] = [];
	// How each token is written in the body, for the text of its gap.
	const writtenAs = new Map<string, string>();

	const html = replaceTemplateVariables(tightenTokens(bodyHtml, writtenAs), (token, fallback) => {
		const answer = answers[token];
		if (answer && answer.trim()) return escapeHtml(answer.trim());
		const source = sourceFor(token, declared);
		const value = source && source !== 'prompt' ? context[source] : null;
		if (value && value.trim()) return escapeHtml(value.trim());
		if (fallback && fallback.trim()) return escapeHtml(fallback);
		const written = writtenAs.get(token) ?? token;
		if (!unresolved.includes(written)) unresolved.push(written);
		const declaredLabel = declared.find((v) => v.token === token)?.label?.trim();
		const label = declaredLabel || options.gapLabel?.(written, source) || written;
		return escapeHtml(formatDraftGap(label));
	});

	return { html, unresolved, hasGaps: hasDraftGaps(htmlToPlainText(html)) };
}
