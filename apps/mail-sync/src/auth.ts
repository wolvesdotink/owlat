/**
 * How this worker authenticates to a user's mailbox — one decision, two
 * protocols.
 *
 * An external account is either password-backed (an IMAP/SMTP app password) or
 * OAuth-backed (Google sign-in, where Convex mints a short-lived access token
 * per credential fetch from a stored refresh token). The choice is made HERE,
 * from the shape of the credentials, so IMAP and SMTP can never disagree about
 * which mechanism an account uses and a new call site cannot quietly default to
 * the password.
 *
 * A non-empty access token always wins: on an OAuth account the password fields
 * are empty strings by construction, and both servers speak SASL XOAUTH2.
 */

import type { AuthConfig } from '@owlat/smtp-client';

/** What either protocol needs to pick a mechanism. */
export interface ProtocolAuthSource {
	user: string;
	pass: string;
	accessToken?: string;
}

/** ImapFlow's two auth shapes: XOAUTH2 bearer, or LOGIN/PLAIN password. */
export type ImapAuthConfig = { user: string; accessToken: string } | { user: string; pass: string };

function hasAccessToken(source: ProtocolAuthSource): source is ProtocolAuthSource & {
	accessToken: string;
} {
	return typeof source.accessToken === 'string' && source.accessToken !== '';
}

/**
 * ImapFlow auth. Given `{ user, accessToken }` it issues `AUTHENTICATE XOAUTH2`;
 * given `{ user, pass }` it logs in with the password.
 */
export function imapAuth(source: ProtocolAuthSource): ImapAuthConfig {
	return hasAccessToken(source)
		? { user: source.user, accessToken: source.accessToken }
		: { user: source.user, pass: source.pass };
}

/**
 * `@owlat/smtp-client` auth — the SMTP twin of {@link imapAuth}, so the two
 * protocols select their mechanism by the same rule.
 */
export function smtpAuth(source: ProtocolAuthSource): AuthConfig {
	return hasAccessToken(source)
		? { credentials: { username: source.user, accessToken: source.accessToken } }
		: { credentials: { username: source.user, password: source.pass } };
}
