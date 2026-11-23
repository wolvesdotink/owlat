/**
 * The auth server's refusals in the reader's language.
 *
 * better-auth answers every refusal with an English `message` and a stable
 * `code`. The message is never shown: it is English whatever the locale, so
 * the copy comes from the code, and an unknown code reads as the calling
 * flow's own fallback line. The library's text goes to the console for
 * support.
 *
 * The codes are the ones better-auth (`@better-auth/core` error codes, the
 * organization plugin's routes) and Owlat's registration gate
 * (`apps/api/convex/auth/registrationGate.ts`) return on the flows that call
 * this. A rate-limited request is a 429 without a code.
 */

/** The `error` of a better-auth client result. */
export type AuthClientError = {
	code?: string;
	message?: string;
	status?: number;
	statusText?: string;
};

type Translate = (key: string, named?: Record<string, unknown>) => string;

const KEY_FOR_CODE: Readonly<Record<string, string>> = {
	INVALID_EMAIL_OR_PASSWORD: 'invalidCredentials',
	INVALID_EMAIL: 'invalidEmail',
	PASSWORD_TOO_SHORT: 'passwordTooShort',
	PASSWORD_TOO_LONG: 'passwordTooLong',
	EMAIL_NOT_VERIFIED: 'emailNotVerified',
	USER_ALREADY_EXISTS: 'accountExists',
	USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: 'accountExists',
	EMAIL_PASSWORD_SIGN_UP_DISABLED: 'signUpDisabled',
	REGISTRATION_INVITE_ONLY: 'inviteOnly',
	REGISTRATION_SETUP_REQUIRED: 'setupRequired',
	INVALID_TOKEN: 'linkInvalid',
	INVITATION_NOT_FOUND: 'invitationNotFound',
	YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION: 'wrongRecipient',
	USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION: 'alreadyMember',
	USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION: 'alreadyInvited',
	YOU_ARE_NOT_ALLOWED_TO_INVITE_USERS_TO_THIS_ORGANIZATION: 'notAllowed',
	YOU_ARE_NOT_ALLOWED_TO_CANCEL_THIS_INVITATION: 'notAllowed',
	YOU_ARE_NOT_ALLOWED_TO_DELETE_THIS_MEMBER: 'notAllowed',
	YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_MEMBER: 'notAllowed',
	YOU_ARE_NOT_ALLOWED_TO_INVITE_USER_WITH_THIS_ROLE: 'roleNotAllowed',
	MEMBER_NOT_FOUND: 'memberNotFound',
	INVITATION_LIMIT_REACHED: 'invitationLimit',
	ORGANIZATION_MEMBERSHIP_LIMIT_REACHED: 'membershipLimit',
	YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER: 'lastOwner',
	YOU_CANNOT_LEAVE_THE_ORGANIZATION_WITHOUT_AN_OWNER: 'lastOwner',
};

const TOO_MANY_REQUESTS = 429;

/**
 * Sign-in must not tell a stranger whether an address has an account. These
 * are the codes that could say "no such account" or "wrong password"; they all
 * read as one sentence.
 */
const ACCOUNT_IDENTITY_CODES = new Set([
	'INVALID_EMAIL_OR_PASSWORD',
	'USER_NOT_FOUND',
	'INVALID_PASSWORD',
	'CREDENTIAL_ACCOUNT_NOT_FOUND',
	'ACCOUNT_NOT_FOUND',
	'INVALID_USER',
	'USER_EMAIL_NOT_FOUND',
]);

/**
 * The only other sign-in answers with their own sentence. Each says nothing
 * about whether the account exists: the address format and the password length
 * are checked before the lookup, and better-auth reports an unconfirmed address
 * only after the password matched. Anything else on the sign-in form reads as
 * the generic line, so a code from another flow ("account exists") cannot
 * leak onto it.
 */
const SIGN_IN_CODES = new Set(['INVALID_EMAIL', 'PASSWORD_TOO_LONG', 'EMAIL_NOT_VERIFIED']);

function logUnmapped(error: AuthClientError): void {
	console.warn('[auth] unmapped error', {
		code: error.code,
		status: error.status,
		message: error.message,
	});
}

/**
 * The sentence for a refusal. `fallbackKey` is the calling flow's own line for
 * a code this map does not know; `named` fills a sentence's placeholders.
 */
export function authErrorCopy(
	t: Translate,
	error: AuthClientError,
	fallbackKey: string,
	named?: Record<string, unknown>
): string {
	const key = error.code ? KEY_FOR_CODE[error.code] : undefined;
	if (key) return named ? t(`shared.authErrors.${key}`, named) : t(`shared.authErrors.${key}`);
	if (error.status === TOO_MANY_REQUESTS) return t('shared.authErrors.tooManyAttempts');
	logUnmapped(error);
	return t(fallbackKey);
}

/** The sign-in form's sentence for a refusal, which never confirms an account. */
export function signInErrorCopy(t: Translate, error: AuthClientError): string {
	if (error.code && ACCOUNT_IDENTITY_CODES.has(error.code)) {
		return t('shared.authErrors.invalidCredentials');
	}
	if (error.status === TOO_MANY_REQUESTS) return t('shared.authErrors.tooManyAttempts');
	if (error.code && SIGN_IN_CODES.has(error.code)) {
		return authErrorCopy(t, error, 'shared.useAuth.signInFailed');
	}
	logUnmapped(error);
	return t('shared.useAuth.signInFailed');
}
