import { describe, expect, it } from 'vitest';
import { MIN_PASSWORD_LENGTH } from '@owlat/shared/passwordPolicy';
import { createTestI18n } from '~/__tests__/i18n';
import { passwordChangeProblem } from '../passwordChange';

const { t } = createTestI18n().global;

describe('passwordChangeProblem', () => {
	const long = 'x'.repeat(MIN_PASSWORD_LENGTH);

	it('refuses a new password under the shared minimum, saying the minimum', () => {
		const short = 'x'.repeat(MIN_PASSWORD_LENGTH - 1);
		const problem = passwordChangeProblem(short, short);
		expect(problem?.key).toBe('dashboard.preferences.account.passwordTooShort');
		expect(t(problem!.key, problem!.params ?? {})).toContain(String(MIN_PASSWORD_LENGTH));
	});

	it('refuses a confirmation that does not match', () => {
		expect(passwordChangeProblem(long, `${long}y`)?.key).toBe(
			'dashboard.preferences.account.passwordsDoNotMatch'
		);
	});

	it('lets a long enough, confirmed password through', () => {
		expect(passwordChangeProblem(long, long)).toBeNull();
	});
});
