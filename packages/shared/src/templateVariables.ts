/**
 * The `{{token}}` template-variable GRAMMAR, in one place.
 *
 * The same token syntax is walked by the email designer's preview, by the
 * per-recipient personalization pass on the send path, and (since plan idea 13)
 * by the Postbox composer's snippets. Each of those had its own copy of the
 * regex, which is exactly the kind of duplication that ends with three
 * subtly-different answers to "is this a variable?".
 *
 * The grammar, deliberately small:
 *
 *     {{name}}              a bare token
 *     {{name|'fallback'}}   a token with an inline default, single-quoted
 *
 * `name` is `\w+` — letters, digits, underscore. No spaces, no dotted paths, no
 * nesting: anything richer would need an expression language, and a mail
 * template is not the place to grow one.
 *
 * WHO DECIDES WHAT A TOKEN BECOMES is deliberately NOT here. {@link
 * replaceTemplateVariables} takes a resolver and does nothing but walk;
 * "unknown means sample data" (preview), "unknown means empty" (send) and
 * "unknown means leave it visible so the preflight catches it" (snippets) are
 * three different policies over one grammar.
 */

/** Source of the token pattern; a fresh RegExp per call keeps `lastIndex` sane. */
const TOKEN_SOURCE = String.raw`\{\{(\w+)(?:\|'([^']*)')?\}\}`;

/** A new global matcher for the token grammar (fresh, so `lastIndex` is 0). */
function templateVariablePattern(): RegExp {
	return new RegExp(TOKEN_SOURCE, 'g');
}

/** Does this string carry at least one `{{token}}`? */
export function containsTemplateVariable(value: string | undefined | null): boolean {
	if (!value) return false;
	return new RegExp(TOKEN_SOURCE).test(value);
}

/**
 * Every token name in `value`, in order of appearance, duplicates included —
 * callers that want a set say so, and the order matters to anything that
 * prompts for values in reading order.
 */
export function extractTemplateVariableNames(value: string | undefined | null): string[] {
	if (!value) return [];
	const names: string[] = [];
	const pattern = templateVariablePattern();
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(value)) !== null) names.push(match[1]!);
	return names;
}

/**
 * How one token resolves. Return a string to substitute it, or `null`/
 * `undefined` to LEAVE THE TOKEN VERBATIM — which is how a caller says "I don't
 * know this one", without having to invent a placeholder syntax of its own.
 *
 * `fallback` is the token's inline default when it declared one.
 */
export type TemplateVariableResolver = (
	name: string,
	fallback: string | undefined
) => string | null | undefined;

/**
 * Walk `content` and rewrite each `{{token}}` through `resolve`.
 *
 * `escape` is the caller's, not ours: HTML output must escape substituted
 * values (they are untrusted data), plain-text output must not.
 */
export function replaceTemplateVariables(
	content: string,
	resolve: TemplateVariableResolver,
	options: { escape?: (value: string) => string } = {}
): string {
	const escape = options.escape ?? ((value: string) => value);
	return content.replace(templateVariablePattern(), (match, name: string, fallback?: string) => {
		const resolved = resolve(name, fallback);
		return resolved === null || resolved === undefined ? match : escape(resolved);
	});
}
