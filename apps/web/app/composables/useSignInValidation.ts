/**
 * Field validation for a password sign-in form.
 *
 * The web sign-in page and the desktop connect handshake ask for the same two
 * fields and must reject the same input with the same per-field messages. The
 * connect page used to accept any non-empty email with one combined message;
 * the rules live here so the two cannot drift again.
 */
import { reactive, type Ref } from 'vue';
import { isValidEmail } from '@owlat/shared';

export function useSignInValidation(email: Ref<string>, password: Ref<string>) {
	const { t } = useI18n();

	const errors = reactive({ email: '', password: '' });

	function validateEmail(): boolean {
		if (!email.value) {
			errors.email = t('auth.validation.emailRequired');
			return false;
		}
		if (!isValidEmail(email.value)) {
			errors.email = t('auth.validation.emailInvalid');
			return false;
		}
		errors.email = '';
		return true;
	}

	// Signing in only needs a password to check. Its length is the server's call:
	// an account created under an older minimum must still be able to sign in.
	function validatePassword(): boolean {
		if (!password.value) {
			errors.password = t('auth.validation.passwordRequired');
			return false;
		}
		errors.password = '';
		return true;
	}

	/** Validate both fields, so every error shows at once rather than one per submit. */
	function validate(): boolean {
		const emailValid = validateEmail();
		const passwordValid = validatePassword();
		return emailValid && passwordValid;
	}

	return { errors, validateEmail, validatePassword, validate };
}
