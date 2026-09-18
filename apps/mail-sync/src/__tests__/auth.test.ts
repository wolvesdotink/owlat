/**
 * Mechanism selection — the one decision both protocols make from the same
 * credentials.
 *
 * A Google-connected account arrives with empty password fields and a live
 * access token; an app-password account arrives with the reverse. Getting this
 * backwards on either protocol is silent: ImapFlow would send LOGIN with an
 * empty password (a generic auth failure that looks like a wrong password), so
 * the shape of the returned config is asserted rather than inferred.
 */

import { describe, expect, it } from 'vitest';
import { imapAuth, smtpAuth } from '../auth.js';
import { isAuthError } from '../connection.js';

describe('imapAuth', () => {
	it('uses XOAUTH2 when an access token is present', () => {
		expect(imapAuth({ user: 'me@gmail.com', pass: '', accessToken: 'ya29.TOKEN' })).toEqual({
			user: 'me@gmail.com',
			accessToken: 'ya29.TOKEN',
		});
	});

	it('uses the password when there is no token', () => {
		expect(imapAuth({ user: 'me@example.com', pass: 'app-password' })).toEqual({
			user: 'me@example.com',
			pass: 'app-password',
		});
	});

	it('treats an empty token as absent (never authenticates with an empty bearer)', () => {
		expect(imapAuth({ user: 'me@example.com', pass: 'app-password', accessToken: '' })).toEqual({
			user: 'me@example.com',
			pass: 'app-password',
		});
	});

	it('prefers the token over a password when both are set', () => {
		expect(imapAuth({ user: 'me@gmail.com', pass: 'stale', accessToken: 'ya29.TOKEN' })).toEqual({
			user: 'me@gmail.com',
			accessToken: 'ya29.TOKEN',
		});
	});
});

describe('smtpAuth', () => {
	it('selects the same mechanism as imapAuth for the same credentials', () => {
		expect(smtpAuth({ user: 'me@gmail.com', pass: '', accessToken: 'ya29.TOKEN' })).toEqual({
			credentials: { username: 'me@gmail.com', accessToken: 'ya29.TOKEN' },
		});
		expect(smtpAuth({ user: 'me@example.com', pass: 'app-password' })).toEqual({
			credentials: { username: 'me@example.com', password: 'app-password' },
		});
	});
});

describe('isAuthError', () => {
	it('recognises the XOAUTH2 failures Gmail returns', () => {
		expect(isAuthError(new Error('[AUTHENTICATIONFAILED] Invalid credentials (Failure)'))).toBe(
			true
		);
		expect(isAuthError(new Error('invalid_grant'))).toBe(true);
		expect(isAuthError(new Error('Invalid status code for XOAUTH2'))).toBe(true);
	});

	it('still recognises ImapFlow’s own flag and the password-path messages', () => {
		expect(isAuthError({ authenticationFailed: true })).toBe(true);
		expect(isAuthError(new Error('LOGIN failed'))).toBe(true);
	});

	it('leaves a transient network drop retryable', () => {
		expect(isAuthError(new Error('ECONNRESET'))).toBe(false);
		expect(isAuthError(new Error('socket timeout'))).toBe(false);
	});
});
