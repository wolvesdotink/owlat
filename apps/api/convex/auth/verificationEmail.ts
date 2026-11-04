import {
	generateAccountVerificationHtml,
	generateNewEmailVerificationHtml,
} from '../lib/systemEmails';

/**
 * Which email BetterAuth's single `sendVerificationEmail` hook should send.
 *
 * The hook serves two flows that need different words: confirming a new
 * account's address (sign-up, a resend, a sign-in attempt while unverified)
 * and the final hop of a login-email change. BetterAuth passes no flag, but it
 * signs the change-email token with `updateTo`, the address being claimed, and
 * the account tokens without it. The token was minted by this server a moment
 * ago, so its payload is read here without checking the signature; nothing is
 * authorized on it, it only picks the copy.
 */
export function verificationEmailFor(params: {
	user: { name?: string; email: string };
	url: string;
	token: string;
}): { subject: string; html: string } {
	const displayName = params.user.name || params.user.email;
	if (isEmailChangeToken(params.token)) {
		return {
			subject: 'Verify your new login email — Owlat',
			html: generateNewEmailVerificationHtml(displayName, params.user.email, params.url),
		};
	}
	return {
		subject: 'Confirm your email address — Owlat',
		html: generateAccountVerificationHtml(displayName, params.user.email, params.url),
	};
}

function isEmailChangeToken(token: string): boolean {
	const payload = token.split('.')[1];
	if (!payload) return false;
	try {
		const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
		const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
		const claims: unknown = JSON.parse(atob(padded));
		return (
			typeof claims === 'object' &&
			claims !== null &&
			typeof (claims as { updateTo?: unknown }).updateTo === 'string'
		);
	} catch {
		return false;
	}
}
