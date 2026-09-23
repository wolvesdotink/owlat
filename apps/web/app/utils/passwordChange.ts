/**
 * The client-side check before "Change password" asks the server: the new
 * password meets the shared minimum and the confirmation matches. Module scope,
 * so the problem travels as a catalog key with its parameters.
 */
import { meetsMinPasswordLength, MIN_PASSWORD_LENGTH } from '@owlat/shared/passwordPolicy';

export interface PasswordChangeProblem {
	key: string;
	params?: Record<string, unknown>;
}

export function passwordChangeProblem(
	newPassword: string,
	confirmPassword: string
): PasswordChangeProblem | null {
	if (!meetsMinPasswordLength(newPassword)) {
		return {
			key: 'dashboard.preferences.account.passwordTooShort',
			params: { min: MIN_PASSWORD_LENGTH },
		};
	}
	if (newPassword !== confirmPassword) {
		return { key: 'dashboard.preferences.account.passwordsDoNotMatch' };
	}
	return null;
}
