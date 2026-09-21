/**
 * Typed snippet variables (plan idea 13).
 *
 * Snippets used to support exactly one token, `{{firstName}}`, resolved from
 * the first recipient. A snippet can now DECLARE what each of its tokens means,
 * and the picker resolves them at insertion:
 *
 *   - recipient facts (first name, full name, company) from the address book,
 *   - the sender's own identity (name, From address),
 *   - today's date, formatted in the reader's locale,
 *   - and `prompt`, which asks at insert time — the "custom prompt-on-insert"
 *     case, for the one-off number or link a canned response leaves blank.
 *
 * The `{{token}}` / `{{token|'fallback'}}` GRAMMAR is not reinvented here: it
 * is `@owlat/shared/templateVariables`, the same walk the email designer's
 * preview and the send path's personalization use.
 *
 * WHAT AN UNRESOLVED TOKEN BECOMES is the policy that matters. It stays as its
 * literal `{{token}}` — NOT a `[token]` marker, and never an empty string. The
 * composer's preflight (`postboxPreflight`, plan idea 6) already flags a
 * leftover `{{…}}` as `unfilledVariable`, so leaving the token intact is what
 * wires the two ideas together: a snippet inserted with a blank the sender
 * never filled in gets caught beside Send instead of shipping.
 *
 * Module scope: no Vue, no Convex, no i18n. Labels are catalog keys.
 */

import { escapeHtml } from '@owlat/shared/html';
import {
	extractTemplateVariableNames,
	replaceTemplateVariables,
} from '@owlat/shared/templateVariables';

/** Where a declared snippet variable gets its value from. */
export type SnippetVariableSource =
	| 'recipientFirstName'
	| 'recipientFullName'
	| 'recipientCompany'
	| 'senderName'
	| 'senderEmail'
	| 'date'
	| 'prompt';

export const SNIPPET_VARIABLE_SOURCES: readonly SnippetVariableSource[] = [
	'recipientFirstName',
	'recipientFullName',
	'recipientCompany',
	'senderName',
	'senderEmail',
	'date',
	'prompt',
];

const SOURCE_KEY_PREFIX = 'shared.postbox.snippetVariables.sources';

/** Catalog key for a source's label, resolved at the render boundary. */
export function snippetVariableSourceKey(source: SnippetVariableSource): string {
	return `${SOURCE_KEY_PREFIX}.${source}`;
}

/** One declared variable on a snippet. */
export interface SnippetVariable {
	/** The token name, i.e. the `x` in `{{x}}`. */
	token: string;
	source: SnippetVariableSource;
	/** What the insert-time prompt asks for. Only meaningful for `prompt`. */
	label?: string;
}

/** Everything the picker knows at the moment of insertion. */
export interface SnippetVariableContext {
	recipientFirstName?: string | null;
	recipientFullName?: string | null;
	recipientCompany?: string | null;
	senderName?: string | null;
	senderEmail?: string | null;
	/** Today, already formatted in the active locale by the caller. */
	date?: string | null;
}

/**
 * Tokens a snippet body uses without declaring, mapped to the source they mean
 * anyway. `{{firstName}}` predates the typed set and is in tens of thousands of
 * saved snippets; it keeps working, and the rest are the obvious spellings a
 * person types before discovering the variable editor.
 */
const IMPLICIT_SOURCES: Readonly<Record<string, SnippetVariableSource>> = {
	firstname: 'recipientFirstName',
	first_name: 'recipientFirstName',
	fullname: 'recipientFullName',
	full_name: 'recipientFullName',
	name: 'recipientFullName',
	company: 'recipientCompany',
	date: 'date',
	today: 'date',
	sender: 'senderName',
	sendername: 'senderName',
	senderemail: 'senderEmail',
};

/** `firstName` and `first_name` and `FirstName` are the same implicit token. */
function normalizeToken(token: string): string {
	return token.toLowerCase();
}

/** The declared source for a token, falling back to the implicit table. */
function sourceFor(
	token: string,
	declared: readonly SnippetVariable[]
): SnippetVariableSource | undefined {
	const explicit = declared.find((v) => v.token === token);
	if (explicit) return explicit.source;
	const key = normalizeToken(token);
	return IMPLICIT_SOURCES[key] ?? IMPLICIT_SOURCES[key.replace(/_/g, '')];
}

function contextValue(
	source: SnippetVariableSource,
	context: SnippetVariableContext
): string | null {
	switch (source) {
		case 'recipientFirstName':
			return context.recipientFirstName ?? null;
		case 'recipientFullName':
			return context.recipientFullName ?? null;
		case 'recipientCompany':
			return context.recipientCompany ?? null;
		case 'senderName':
			return context.senderName ?? null;
		case 'senderEmail':
			return context.senderEmail ?? null;
		case 'date':
			return context.date ?? null;
		case 'prompt':
			// Never from context: a prompt variable's only source is the person.
			return null;
	}
}

/**
 * `{{ firstName }}` → `{{firstName}}`.
 *
 * The shared grammar is deliberately strict about inner whitespace, because it
 * is the grammar the SEND path personalizes with and widening it there would
 * change what goes out. Snippet bodies are different: they are resolved
 * entirely client-side, at insertion, and people have been hand-typing the
 * spaced spelling into the snippet editor since before there was a variable
 * system. Tightening first keeps those working without touching the wire.
 */
function tightenTokens(bodyHtml: string): string {
	return bodyHtml.replace(/\{\{\s*(\w+)\s*((?:\|'[^']*')?)\s*\}\}/g, '{{$1$2}}');
}

/** Every distinct token a snippet body uses, in reading order. */
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
 * The declared `prompt` variables this snippet body actually uses, in reading
 * order — i.e. exactly the fields the insert-time dialog should ask for. A
 * declaration for a token the body no longer contains asks nothing, so editing
 * a snippet's text can never leave a stale question behind.
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
}

export interface ResolvedSnippet {
	/** The body with every known token substituted (values HTML-escaped). */
	html: string;
	/** Tokens left standing, for the preflight to pick up. */
	unresolved: string[];
}

/**
 * Resolve a snippet body for insertion.
 *
 * Order per token: an answer the sender just typed → the context value for its
 * source → the token's own inline fallback → left standing. Values are
 * HTML-escaped: a recipient's name is untrusted data being spliced into the
 * draft's markup.
 */
export function resolveSnippetBody(
	bodyHtml: string,
	options: ResolveSnippetOptions = {}
): ResolvedSnippet {
	const declared = options.declared ?? [];
	const context = options.context ?? {};
	const answers = options.answers ?? {};
	const unresolved: string[] = [];

	const html = replaceTemplateVariables(
		tightenTokens(bodyHtml),
		(token, fallback) => {
			const answer = answers[token];
			if (answer && answer.trim()) return answer.trim();
			const source = sourceFor(token, declared);
			const value = source ? contextValue(source, context) : null;
			if (value && value.trim()) return value.trim();
			if (fallback && fallback.trim()) return fallback;
			if (!unresolved.includes(token)) unresolved.push(token);
			return null;
		},
		{ escape: escapeHtml }
	);

	return { html, unresolved };
}
