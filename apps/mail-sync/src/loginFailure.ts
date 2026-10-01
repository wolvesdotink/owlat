/**
 * Telling wrong credentials apart from a provider that refused a login for now.
 *
 * ImapFlow sets `authenticationFailed` on EVERY tagged NO/BAD answer to LOGIN or
 * AUTHENTICATE, whatever the server said, and its message is always the
 * generic 'Command failed'. Gmail answers LOGIN with a NO for reasons that have
 * nothing to do with the password — `[UNAVAILABLE] Temporary System Problem`,
 * `[ALERT] Too many simultaneous connections`, bandwidth limits — and now and
 * then with `[AUTHENTICATIONFAILED] Invalid credentials` for an app password
 * that works again a minute later. Parking the account on the first of those
 * was terminal: `auth_error` is not connectable, so a shared team inbox stopped
 * receiving mail until someone re-entered a password that had never changed.
 *
 * So the worker only believes a rejection once it has lasted
 * AUTH_REJECTION_GRACE_MS, retrying on the ordinary backoff in between, and a
 * reply that names itself transient never counts as a rejection at all.
 */

/** How long a login has to keep being rejected before the credentials are presumed wrong. */
export const AUTH_REJECTION_GRACE_MS = 15 * 60 * 1000;

/** RFC 5530 response codes that mean "not now", not "not you". */
const TRANSIENT_RESPONSE_CODES = new Set([
	'UNAVAILABLE',
	'INUSE',
	'LIMIT',
	'OVERQUOTA',
	'SERVERBUG',
]);

/** The same, said in words by providers that put it in the text (Gmail's [ALERT]s). */
const TRANSIENT_TEXT = [
	'too many simultaneous connections',
	'temporary system problem',
	'temporarily unavailable',
	'try again later',
	'exceeded command or bandwidth limits',
];

interface ImapErrorFields {
	authenticationFailed?: boolean;
	serverResponseCode?: string;
	responseText?: string;
}

function fields(err: unknown): ImapErrorFields {
	return err !== null && typeof err === 'object' ? (err as ImapErrorFields) : {};
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * The error as it should be shown on the account: ImapFlow's message plus the
 * server's own reply, which is the only part that says what actually happened.
 */
export function describeConnectError(err: unknown): string {
	const message = errorText(err);
	const { serverResponseCode, responseText } = fields(err);
	const reply = [serverResponseCode ? `[${serverResponseCode}]` : '', responseText ?? '']
		.join(' ')
		.trim();
	return reply && !message.includes(reply) ? `${message}: ${reply}` : message;
}

/** The server refused the login but said it is a temporary condition. */
function isTransientRefusal(err: unknown): boolean {
	const { serverResponseCode, responseText } = fields(err);
	if (serverResponseCode && TRANSIENT_RESPONSE_CODES.has(serverResponseCode.toUpperCase())) {
		return true;
	}
	const text = `${errorText(err)} ${responseText ?? ''}`.toLowerCase();
	return TRANSIENT_TEXT.some((phrase) => text.includes(phrase));
}

/**
 * "The server rejected these credentials", as opposed to a transient drop or a
 * refusal the server itself calls temporary. A rejection is still only
 * presumed final once it persists (AUTH_REJECTION_GRACE_MS).
 *
 * The XOAUTH2 path says different things to the password path: Gmail answers a
 * dead or unauthorized token with `[AUTHENTICATIONFAILED] Invalid credentials
 * (Failure)` and a revoked grant with `invalid_grant`. Matching those too keeps
 * an expired Google authorization from looping on exponential backoff forever
 * instead of surfacing the "Reconnect with Google" prompt the user must act on.
 */
export function isAuthError(err: unknown): boolean {
	if (isTransientRefusal(err)) return false;
	if (fields(err).authenticationFailed) return true;
	const msg = errorText(err).toLowerCase();
	return (
		msg.includes('authentication failed') ||
		msg.includes('authenticationfailed') ||
		msg.includes('invalid credentials') ||
		msg.includes('login failed') ||
		msg.includes('[alert] invalid') ||
		// XOAUTH2: the SASL exchange failed, or the grant behind the token is gone.
		msg.includes('invalid_grant') ||
		msg.includes('invalid status code for xoauth2') ||
		msg.includes('xoauth2 authentication failed')
	);
}
