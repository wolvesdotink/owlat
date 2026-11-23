import { afterEach, describe, expect, it, vi } from 'vitest';
import de from '~~/i18n/locales/de.json';
import { createTestI18n } from '~/__tests__/i18n';
import { authErrorCopy, signInErrorCopy } from '~/utils/authErrorCopy';

const i18n = createTestI18n();
i18n.global.setLocaleMessage('de', de);

function translator(locale: 'en' | 'de') {
	return (key: string, named?: Record<string, unknown>) => {
		i18n.global.locale.value = locale;
		return named ? i18n.global.t(key, named) : i18n.global.t(key);
	};
}

const en = translator('en');
const deT = translator('de');

/** Each code the installed better-auth returns on these flows, with the sentence it reads as. */
const KNOWN: Array<[code: string, en: string, de: string]> = [
	['INVALID_EMAIL', 'Enter a valid email address.', 'Gib eine gültige E-Mail-Adresse ein.'],
	['PASSWORD_TOO_SHORT', 'This password is too short.', 'Dieses Passwort ist zu kurz.'],
	['PASSWORD_TOO_LONG', 'This password is too long.', 'Dieses Passwort ist zu lang.'],
	[
		'EMAIL_NOT_VERIFIED',
		'Confirm your email address first. The link is in the email we sent you.',
		'Bestätige zuerst deine E-Mail-Adresse. Den Link findest du in der E-Mail, die wir dir geschickt haben.',
	],
	[
		'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL',
		'An account with this email address already exists. Sign in instead.',
		'Mit dieser E-Mail-Adresse gibt es schon ein Konto. Melde dich stattdessen an.',
	],
	[
		'REGISTRATION_INVITE_ONLY',
		'You can only register on this instance with an invitation. Ask an admin to invite you.',
		'Auf dieser Instanz kannst du dich nur mit einer Einladung registrieren. Bitte jemanden mit Admin-Rechten, dich einzuladen.',
	],
	[
		'INVALID_TOKEN',
		'This link has expired or was already used. Request a new one.',
		'Dieser Link ist abgelaufen oder wurde schon verwendet. Fordere einen neuen an.',
	],
	[
		'INVITATION_NOT_FOUND',
		'This invitation has expired or was already used.',
		'Diese Einladung ist abgelaufen oder wurde schon verwendet.',
	],
	[
		'USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION',
		'This person already has an open invitation.',
		'Diese Person hat schon eine offene Einladung.',
	],
	[
		'YOU_ARE_NOT_ALLOWED_TO_DELETE_THIS_MEMBER',
		'Your role does not allow this.',
		'Deine Rolle erlaubt das nicht.',
	],
	[
		'YOU_CANNOT_LEAVE_THE_ORGANIZATION_WITHOUT_AN_OWNER',
		'The workspace needs an owner. Transfer ownership first.',
		'Der Workspace braucht einen Eigentümer. Übertrage zuerst die Eigentümerschaft.',
	],
];

afterEach(() => {
	vi.restoreAllMocks();
});

describe('authErrorCopy', () => {
	it.each(KNOWN)('%s reads as a sentence in English and German', (code, enText, deText) => {
		const error = { code, message: 'English text from the library', status: 400 };
		expect(authErrorCopy(en, error, 'shared.useAuth.signUpFailed')).toBe(enText);
		expect(authErrorCopy(deT, error, 'shared.useAuth.signUpFailed')).toBe(deText);
	});

	it('fills the address into the wrong-recipient sentence', () => {
		const error = { code: 'YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION', status: 403 };
		expect(
			authErrorCopy(deT, error, 'invite.accept.errors.acceptFailed', {
				email: 'ada@owlat.example',
			})
		).toBe(
			'Diese Einladung ging an eine andere Adresse als ada@owlat.example. Melde dich mit der eingeladenen Adresse an, um sie anzunehmen.'
		);
	});

	it('shows the flow’s translated fallback for an unknown code, never the library’s message', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const error = { code: 'SOMETHING_NEW', message: 'Something new went wrong', status: 400 };
		expect(authErrorCopy(deT, error, 'shared.useAuth.signUpFailed')).toBe(
			'Registrierung fehlgeschlagen'
		);
		expect(authErrorCopy(en, { message: 'No code at all' }, 'shared.useAuth.signUpFailed')).toBe(
			'Sign up failed'
		);
		// A code that happens to name an object property is still unknown.
		expect(authErrorCopy(en, { code: 'constructor' }, 'shared.useAuth.signUpFailed')).toBe(
			'Sign up failed'
		);
		// The library's text stays available for support, in the console only.
		expect(warn).toHaveBeenCalledWith(
			'[auth] unmapped error',
			expect.objectContaining({ code: 'SOMETHING_NEW', message: 'Something new went wrong' })
		);
	});

	it('reads a rate-limited request, which better-auth sends without a code', () => {
		const error = { status: 429, message: 'Too many requests. Please try again later.' };
		expect(authErrorCopy(deT, error, 'shared.useAuth.resetPasswordFailed')).toBe(
			'Zu viele Versuche. Warte ein paar Minuten und versuch es dann noch einmal.'
		);
	});
});

describe('signInErrorCopy', () => {
	const WRONG_CREDENTIALS_DE = 'E-Mail-Adresse oder Passwort stimmt nicht.';

	it('says the same sentence for an unknown account and a wrong password', () => {
		// better-auth answers both with INVALID_EMAIL_OR_PASSWORD today; the codes
		// that would tell them apart must not tell them apart here either.
		const sentences = [
			'INVALID_EMAIL_OR_PASSWORD',
			'USER_NOT_FOUND',
			'INVALID_PASSWORD',
			'CREDENTIAL_ACCOUNT_NOT_FOUND',
			'ACCOUNT_NOT_FOUND',
			'INVALID_USER',
			'USER_EMAIL_NOT_FOUND',
		].map((code) =>
			signInErrorCopy(deT, { code, status: 401, message: 'Invalid email or password' })
		);
		expect(new Set(sentences)).toEqual(new Set([WRONG_CREDENTIALS_DE]));
		expect(signInErrorCopy(en, { code: 'INVALID_EMAIL_OR_PASSWORD', status: 401 })).toBe(
			'The email address or password is not correct.'
		);
	});

	it('names no account in a rate-limit answer', () => {
		const sentence = signInErrorCopy(deT, { status: 429 });
		expect(sentence).toBe(
			'Zu viele Versuche. Warte ein paar Minuten und versuch es dann noch einmal.'
		);
		expect(sentence).not.toMatch(/Konto|Adresse/);
	});

	it('keeps account-specific copy from other flows off the sign-in form', () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		// A code that confirms an account exists falls back to the generic line.
		for (const code of ['USER_ALREADY_EXISTS', 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL']) {
			expect(signInErrorCopy(deT, { code, status: 422 })).toBe('Anmeldung fehlgeschlagen');
		}
	});
});
