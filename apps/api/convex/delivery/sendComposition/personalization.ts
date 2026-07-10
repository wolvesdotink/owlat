import { escapeHtml } from '@owlat/shared/html';
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
export type EscapePolicy = 'plain' | 'html' | 'header';

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
 * Replace `{{var}}` (and `{{var|'fallback'}}`) tokens in a string with values
 * from a variable record. Supports the `{{name|'fallback'}}` fallback syntax.
 *
 * The fallback string follows the same escape policy as the value — when
 * `escape: 'html'`, both substituted values and fallbacks are HTML-escaped.
 * This matches the pre-deepening worker behaviour for fallbacks.
 *
 * Missing variables, `undefined`, `null`, and empty-string values all
 * trigger the fallback path (or `''` if no fallback declared).
 */
export function personalize(
	content: string,
	variables: Record<string, unknown>,
	options: { escape: EscapePolicy }
): string {
	return content.replace(/\{\{(\w+)(?:\|'([^']*)')?\}\}/g, (_match, variable, fallback) => {
		const value = variables[variable as keyof typeof variables];
		if (value !== undefined && value !== null && value !== '') {
			return applyEscape(String(value), options.escape);
		}
		return fallback ? applyEscape(fallback, options.escape) : '';
	});
}

/**
 * Plain (no-escape) personalization. Compat surface used by the bridging
 * re-exports in `lib/emailHelpers.ts` and `automations/steps/shared/personalize.ts`
 * during the deepening migration. New call sites should call `personalize`
 * directly with an explicit `escape` argument.
 */
export function replaceVariablesPlain(content: string, variables: Record<string, unknown>): string {
	return personalize(content, variables, { escape: 'plain' });
}

/**
 * HTML-escaping personalization. Compat surface used by the bridging
 * re-export in `emailWorker.ts` during the deepening migration. New call
 * sites should call `personalize` directly with an explicit `escape`
 * argument.
 */
export function replaceVariablesHtml(content: string, variables: Record<string, unknown>): string {
	return personalize(content, variables, { escape: 'html' });
}
