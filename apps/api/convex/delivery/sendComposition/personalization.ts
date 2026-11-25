import { decodeHtmlEntities } from '@owlat/mail-message/text/htmlToPlainText';
import { escapeHtml } from '@owlat/shared/html';
import { matchTemplateVariables, replaceTemplateVariables } from '@owlat/shared/templateVariables';
import {
	hasSendRegions,
	ownValue,
	resolveSendRegions,
	type RepeatItemScope,
	type SendRegionFill,
} from '@owlat/shared/sendRegions';
/**
 * Send composition (module) — personalization leaf.
 *
 * Single `replaceVariables` implementation across every send producer, with
 * the escape policy declared explicitly per call site. Replaces the three
 * pre-deepening `replaceVariables` implementations that diverged silently on
 * HTML escaping. The escape itself is the shared `escapeHtml`
 * (`@owlat/shared/html`), so every producer now escapes identically.
 *
 * Runs in V8 (no Node-only APIs).
 */

/**
 * Escape policy applied to every substituted value (and fallback):
 *  - `html`   — HTML-escape for email bodies (rendered as HTML by clients).
 *  - `header` — strip CR/LF so a substituted value cannot inject extra mail
 *               headers (RFC 5322 §2.2). Used for header-context output:
 *               subjects. Producer-side defense-in-depth — the CRLF can never
 *               reach a transport that would split it into a `Bcc:`/`To:` line.
 *  - `plain`  — no escaping (non-header, non-HTML plain text).
 */
type EscapePolicy = 'plain' | 'html' | 'header';

/**
 * Apply the escape policy to a single substituted value.
 *
 * - `html`   → HTML-escape (mirrors the pre-deepening `emailWorker.escapeHtml`
 *   byte-for-byte so the migration is a no-op for already-html-escaping sites).
 * - `header` → strip CR/LF (collapse runs to a single space). A personalized
 *   subject of `Hi {{firstName}}` with `firstName: "Bob\r\nBcc: x@evil.com"`
 *   would otherwise carry a bare CRLF into the subject; stripping it here stops
 *   header injection at the producer, independent of the chosen transport
 *   (which is the only CRLF guard today, and is absent on the SES attachment
 *   path — see PR-41). Mirrors `mail/rfc822.ts` `escapeHeader`.
 */
function applyEscape(value: string, escape: EscapePolicy): string {
	if (escape === 'html') return escapeHtml(value);
	if (escape === 'header') return value.replace(/[\r\n]+/g, ' ');
	return value;
}

/**
 * The variables `content` uses without a fallback, in order of first use. A
 * token with a fallback (even an empty one, `{{name|''}}`) renders without its
 * value; one without renders blank, so the caller has to supply it.
 *
 * `html: true` for rendered HTML, where a fallback inside an attribute has its
 * quotes escaped; the send reads that content the same way.
 */
export function variablesWithoutFallback(
	content: string,
	syntax: { html?: boolean } = {}
): string[] {
	const names = new Set<string>();
	for (const token of matchTemplateVariables(content, syntax)) {
		if (token.fallback === undefined) names.add(token.name);
	}
	return [...names];
}

/**
 * Replace `{{var}}` (and `{{var|'fallback'}}`) tokens in a string with values
 * from a variable record. Supports the `{{name|'fallback'}}` fallback syntax.
 *
 * The fallback string follows the same escape policy as the value — when
 * `escape: 'html'`, both substituted values and fallbacks are HTML-escaped.
 * The `html` policy also reads the content as HTML: the renderer escapes
 * attribute values, so a token in an image `src` or a link `href` arrives as
 * `{{photo|&#39;https://…&#39;}}`. Its fallback is entity-decoded before the
 * escape, so what lands in the attribute is escaped exactly once.
 *
 * Missing variables, `undefined`, `null`, and empty-string values all
 * trigger the fallback path (or `''` if no fallback declared).
 */
export function personalize(
	content: string,
	variables: Record<string, unknown>,
	options: { escape: EscapePolicy }
): string {
	return replaceTemplateVariables(
		content,
		(variable, fallback) => {
			const value = variables[variable];
			if (value !== undefined && value !== null && value !== '') {
				return applyEscape(valueText(value), options.escape);
			}
			return fallback ? applyEscape(fallback, options.escape) : '';
		},
		{ html: options.escape === 'html' }
	);
}

/**
 * A value as text. A list (a transactional email's repeat data) is written as
 * its JSON: `String()` would call each entry's own `toString`, which an entry
 * object from the request may hold as a string field, and throw.
 */
const valueText = (value: unknown): string =>
	Array.isArray(value) ? JSON.stringify(value) : String(value);

/**
 * An entry field as text. A list sent as JSON text reaches the send without
 * the intake's flat-entry check, so a field may still be an object, which
 * `String()` can throw on.
 */
const fieldText = (value: unknown): string =>
	typeof value === 'object' ? JSON.stringify(value) : String(value);

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A segment inside a repeated region: `{{alias.field}}` takes the entry's
 * field (empty when the entry has none) and `{{$index}}` its position from 0,
 * under the same escape policy as every other value. The rest of the segment is
 * personalized as usual. The segment is split around the entry's tokens before
 * anything is filled, so no substituted value is read as a token.
 */
function personalizeRepeatItem(
	segment: string,
	item: RepeatItemScope,
	variables: Record<string, unknown>,
	options: { escape: EscapePolicy }
): string {
	// Any field name the request may send, as the preview substitutes them.
	const itemToken = new RegExp(
		String.raw`\{\{(?:${escapeRegExp(item.alias)}\.([^{}]+)|\$index)\}\}`,
		'g'
	);
	let out = '';
	let last = 0;
	for (const match of segment.matchAll(itemToken)) {
		out += personalize(segment.slice(last, match.index), variables, options);
		// The renderer HTML-escapes text, so a field name such as `a&b` reaches
		// the HTML as `a&amp;b`.
		const field =
			match[1] !== undefined && options.escape === 'html' ? decodeHtmlEntities(match[1]) : match[1];
		const value = field === undefined ? item.index : ownValue(item.fields, field);
		out +=
			value === undefined || value === null ? '' : applyEscape(fieldText(value), options.escape);
		last = match.index + match[0].length;
	}
	return out + personalize(segment.slice(last), variables, options);
}

/** Fills each kept segment of a body with regions, as `personalizeBody` does. */
function regionFill(
	variables: Record<string, unknown>,
	options: { escape: EscapePolicy }
): SendRegionFill {
	return (segment, item) =>
		item
			? personalizeRepeatItem(segment, item, variables, options)
			: personalize(segment, variables, options);
}

/**
 * `personalize` for a body that may carry the region markers of a transactional
 * email's conditions and repeats (`@owlat/shared/sendRegions`): each region is
 * kept, dropped or repeated against `regionVariables` (the request's data, by
 * default the variables themselves), and no marker reaches the output. A body
 * without markers is personalized exactly as `personalize` does. A text body
 * with markers is trimmed, because a dropped region at either end leaves its
 * blank line behind.
 */
export function personalizeBody(
	content: string,
	variables: Record<string, unknown>,
	options: { escape: EscapePolicy },
	regionVariables: Record<string, unknown> = variables
): string {
	if (!hasSendRegions(content)) return personalize(content, variables, options);
	const body = resolveSendRegions(content, regionVariables, regionFill(variables, options));
	return options.escape === 'html' ? body : body.trim();
}

/**
 * Whether `personalizeBody` would write more than `maxLength` characters. The
 * resolution stops at the limit, so a list that would build a huge body costs
 * no more than the limit to refuse.
 */
export function personalizedBodyExceeds(
	content: string,
	variables: Record<string, unknown>,
	options: { escape: EscapePolicy },
	maxLength: number
): boolean {
	return (
		resolveSendRegions(content, variables, regionFill(variables, options), { maxLength }) === null
	);
}

/**
 * The template a send renders once its regions are resolved, with the tokens
 * still in it: what decides which variables the send needs. A repeated region
 * appears once, for its first entry, since every entry uses the same tokens.
 */
export function resolvedTemplate(content: string, variables: Record<string, unknown>): string {
	return (
		resolveSendRegions(content, variables, (segment) => segment, { firstEntryOnly: true }) ?? ''
	);
}

/**
 * The `{{unsubscribe_link}}` variable: the recipient's own unsubscribe page,
 * the URL the footer links. Templates migrated from other tools often carry
 * the placeholder. It is defined only where the send has a footer; elsewhere
 * it renders like any unknown variable. A value the caller already supplies
 * (a transactional API call's data variable of that name) is kept.
 */
export const UNSUBSCRIBE_LINK_VARIABLE = 'unsubscribe_link';

export function withUnsubscribeLink(
	variables: Record<string, unknown>,
	unsubscribeUrl: string | undefined
): Record<string, unknown> {
	if (!unsubscribeUrl) return variables;
	const supplied = variables[UNSUBSCRIBE_LINK_VARIABLE];
	if (supplied !== undefined && supplied !== null && supplied !== '') return variables;
	return { ...variables, [UNSUBSCRIBE_LINK_VARIABLE]: unsubscribeUrl };
}

/**
 * An automation step personalizes its content before the intake, but its
 * footer URLs are signed later, in the worker. The step therefore keeps the
 * `{{unsubscribe_link}}` token as written, and the worker's composition
 * resolves it next to the footer.
 */
export function automationVariables(contactInfo: Record<string, unknown>): Record<string, unknown> {
	return { ...contactInfo, [UNSUBSCRIBE_LINK_VARIABLE]: `{{${UNSUBSCRIBE_LINK_VARIABLE}}}` };
}
