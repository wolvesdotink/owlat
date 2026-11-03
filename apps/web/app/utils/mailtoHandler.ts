/**
 * Owlat as this browser's handler for `mailto:` links (Preferences → This
 * device). The browser opens a clicked link at {@link MAILTO_HANDLER_PATH},
 * with the whole link in place of `%s`, and the compose page reads it from
 * `?mailto=`.
 *
 * `registerProtocolHandler` only reports a refusal it can make on the spot (a
 * non-HTTPS page, a handler URL on another origin) by throwing. Whether the
 * person then allowed it, and whether it is still registered later, no browser
 * lets a page find out, so the settings card can say "asked", never "on".
 */

/** The compose route the browser opens; `%s` is the browser's placeholder for the link. */
export const MAILTO_HANDLER_PATH = '/dashboard/compose?mailto=%s';

export type MailtoHandlerSupport =
	| 'supported'
	/** Browsers only accept a handler from an HTTPS page (or localhost). */
	| 'insecure'
	/** Safari and most mobile browsers have no `registerProtocolHandler`. */
	| 'unsupported';

export interface MailtoHandlerEnvironment {
	isSecureContext: boolean;
	registerProtocolHandler?: unknown;
}

export function mailtoHandlerSupport(env: MailtoHandlerEnvironment): MailtoHandlerSupport {
	if (typeof env.registerProtocolHandler !== 'function') return 'unsupported';
	if (!env.isSecureContext) return 'insecure';
	return 'supported';
}

/**
 * Ask the browser to open `mailto:` links in Owlat at `origin`. False when the
 * browser refused outright; true means only that it took the request.
 */
export function requestMailtoHandler(
	target: { registerProtocolHandler(scheme: string, url: string): void },
	origin: string
): boolean {
	try {
		target.registerProtocolHandler('mailto', `${origin}${MAILTO_HANDLER_PATH}`);
		return true;
	} catch {
		return false;
	}
}
