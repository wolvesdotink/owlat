/**
 * The second-factor stage of a sign-in form.
 *
 * Two surfaces sign a user in with a password: the web sign-in page and the
 * desktop connect handshake, which runs in the system browser and hands a
 * one-time token back to the app. Both get the same answer from BetterAuth when
 * the account has TOTP enabled — HTTP 200, `{ twoFactorRedirect: true }`, no
 * session — and both therefore need the same second stage. It lives here rather
 * than in either page because the first version of this shipped on the sign-in
 * page alone, and the connect page silently dead-ended: the form reset itself
 * and waited for a session the server was never going to send.
 *
 * The state lives here and the markup in `components/auth/TwoFactorStageForm.vue`.
 * This holds no strings and touches no auth client; what a page has to clean up
 * on its own side (the password it kept, the error it showed) it passes in as
 * hooks, so both pages leave the stage the same way.
 */

import { computed, ref } from 'vue';

import { isCompleteTotpCode, normalizeTotpCode } from '~/utils/accountTwoFactor';

/** Which leg of the sign-in the form is showing. */
export type TwoFactorStage = 'credentials' | 'two-factor';

/**
 * The factor being redeemed. A backup code is the fallback for a lost
 * authenticator — a different endpoint, not a different code format.
 */
export type TwoFactorMethod = 'totp' | 'backup-code';

interface TwoFactorChallengeHooks {
	/** After `reset()`: drop what the credentials leg kept (the password, the error). */
	onReset?: () => void;
	/** After `switchMethod()`: drop anything that described the previous factor. */
	onSwitch?: () => void;
}

export function useTwoFactorChallenge(hooks: TwoFactorChallengeHooks = {}) {
	const stage = ref<TwoFactorStage>('credentials');
	const code = ref('');
	const useBackupCode = ref(false);

	const method = computed<TwoFactorMethod>(() => (useBackupCode.value ? 'backup-code' : 'totp'));

	/**
	 * A code is submittable at exactly six digits — unless it is a backup code,
	 * whose length and alphabet are the server's business.
	 */
	const canSubmit = computed(() =>
		useBackupCode.value ? code.value.length > 0 : isCompleteTotpCode(code.value)
	);

	/**
	 * Backup codes must NOT be filtered down to their digits; only the TOTP field
	 * is normalised, which is why the input is bound through here instead of
	 * `v-model`.
	 */
	function onCodeInput(value: string) {
		code.value = useBackupCode.value ? value.trim() : normalizeTotpCode(value);
	}

	/** The password was accepted and the server is holding the session. */
	function challenge() {
		stage.value = 'two-factor';
		code.value = '';
		useBackupCode.value = false;
	}

	/** Swap authenticator for backup code, dropping whatever was half-typed. */
	function switchMethod() {
		useBackupCode.value = !useBackupCode.value;
		code.value = '';
		hooks.onSwitch?.();
	}

	/** Back to the credentials form, with nothing from the challenge left over. */
	function reset() {
		stage.value = 'credentials';
		code.value = '';
		useBackupCode.value = false;
		hooks.onReset?.();
	}

	return {
		stage,
		code,
		useBackupCode,
		method,
		canSubmit,
		onCodeInput,
		challenge,
		switchMethod,
		reset,
	};
}

export type TwoFactorChallenge = ReturnType<typeof useTwoFactorChallenge>;
