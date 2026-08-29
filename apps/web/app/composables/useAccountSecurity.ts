/**
 * The BetterAuth half of the sign-in and security page (plan idea 57).
 *
 * Sessions and two-factor live in the BetterAuth plane, not in Convex, so none
 * of this goes through `useConvexQuery` / `useBackendOperation` the way the rest
 * of preferences does — there is no reactive subscription to lean on and every
 * mutation has to be followed by an explicit re-read.
 *
 * Two composables, because the two halves fail differently: a session list that
 * will not load is a degraded page, while a two-factor call that fails is a
 * dialog that must stay open with the reason attached. Both return a discrimi-
 * nated `SecurityResult` instead of throwing, so the caller renders the failure
 * where the user is looking rather than in a global toast.
 *
 * Copy stays out of here on purpose: BetterAuth's `error.message` is English
 * server prose and is never shown; the caller picks a catalog message from the
 * outcome.
 */

import { authClient } from '~/lib/auth-client';
import {
	countOtherSessions,
	toActiveSessionRows,
	type ActiveSessionRow,
	type AuthSessionRecord,
} from '~/utils/accountSessions';

/** Every action returns this rather than throwing: failures are rendered, not caught. */
export type SecurityResult<T = undefined> =
	| { ok: true; data: T }
	| { ok: false; code: SecurityFailure };

/**
 * The failures the UI distinguishes. `wrong-password` and `invalid-code` are
 * the two the user can fix by trying again, so they must never collapse into
 * the generic bucket — "Something went wrong" next to a password field is the
 * single most useless thing a security page can say.
 */
export type SecurityFailure = 'wrong-password' | 'invalid-code' | 'failed';

function fail(code: SecurityFailure = 'failed'): { ok: false; code: SecurityFailure } {
	return { ok: false, code };
}

function ok<T>(data: T): { ok: true; data: T } {
	return { ok: true, data };
}

/**
 * BetterAuth reports a rejected password and a rejected code as plain 400s that
 * differ only by error code, so the mapping is by code — not by message, which
 * is server prose and would break the moment it were reworded.
 */
function classify(error: { code?: string | undefined } | null | undefined): SecurityFailure {
	const code = error?.code ?? '';
	if (code === 'INVALID_PASSWORD' || code === 'INVALID_EMAIL_OR_PASSWORD') return 'wrong-password';
	if (code.includes('INVALID_CODE') || code.includes('INVALID_BACKUP_CODE')) return 'invalid-code';
	return 'failed';
}

/**
 * Active sessions: the list, and the two ways to end one.
 *
 * `currentToken` is a getter rather than a value because the session token
 * ROTATES underneath this page — completing TOTP enrolment issues a new session
 * — and a stale token would leave the row the user is sitting on unmarked and
 * therefore revocable.
 */
export function useAccountSessions(currentToken: () => string | null | undefined) {
	const records = ref<AuthSessionRecord[]>([]);
	const isLoading = ref(true);
	const hasLoadError = ref(false);

	const sessions = computed<ActiveSessionRow[]>(() =>
		toActiveSessionRows(records.value, { currentToken: currentToken() ?? null })
	);
	const otherSessionCount = computed(() => countOtherSessions(sessions.value));

	async function refresh() {
		isLoading.value = true;
		try {
			const result = await authClient.listSessions();
			if (result.error || !result.data) {
				hasLoadError.value = true;
				return;
			}
			hasLoadError.value = false;
			records.value = result.data as unknown as AuthSessionRecord[];
		} catch {
			hasLoadError.value = true;
		} finally {
			isLoading.value = false;
		}
	}

	/**
	 * Revoking is always followed by a re-read rather than by splicing the row
	 * out locally: the server is the only thing that knows whether the token was
	 * still live, and an optimistic removal would claim a device was signed out
	 * when the call had in fact failed.
	 */
	async function revoke(token: string): Promise<SecurityResult> {
		try {
			const result = await authClient.revokeSession({ token });
			if (result.error) return fail(classify(result.error));
			await refresh();
			return ok(undefined);
		} catch {
			return fail();
		}
	}

	async function revokeOthers(): Promise<SecurityResult> {
		try {
			const result = await authClient.revokeOtherSessions();
			if (result.error) return fail(classify(result.error));
			await refresh();
			return ok(undefined);
		} catch {
			return fail();
		}
	}

	return { sessions, otherSessionCount, isLoading, hasLoadError, refresh, revoke, revokeOthers };
}

/** What `two-factor/enable` hands back: the QR payload and the one-time codes. */
export type TotpEnrolmentPayload = { totpURI: string; backupCodes: string[] };

/**
 * TOTP enrolment, confirmation, teardown and backup-code rotation.
 *
 * Enabling is TWO steps on purpose and the second one is not optional:
 * `two-factor/enable` writes an UNVERIFIED secret and leaves the account
 * unchanged, and only `verify-totp` flips `twoFactorEnabled`. Shipping step one
 * alone would tell the user 2FA is on while sign-in still ignored it.
 */
export function useTwoFactorEnrolment() {
	async function begin(password: string): Promise<SecurityResult<TotpEnrolmentPayload>> {
		try {
			const result = await authClient.twoFactor.enable({ password });
			if (result.error || !result.data) return fail(classify(result.error));
			return ok({
				totpURI: result.data.totpURI,
				backupCodes: [...result.data.backupCodes],
			});
		} catch {
			return fail();
		}
	}

	async function confirm(code: string): Promise<SecurityResult> {
		try {
			const result = await authClient.twoFactor.verifyTotp({ code });
			if (result.error) return fail(classify(result.error));
			return ok(undefined);
		} catch {
			return fail();
		}
	}

	async function disable(password: string): Promise<SecurityResult> {
		try {
			const result = await authClient.twoFactor.disable({ password });
			if (result.error) return fail(classify(result.error));
			return ok(undefined);
		} catch {
			return fail();
		}
	}

	async function regenerateBackupCodes(password: string): Promise<SecurityResult<string[]>> {
		try {
			const result = await authClient.twoFactor.generateBackupCodes({ password });
			if (result.error || !result.data) return fail(classify(result.error));
			return ok([...result.data.backupCodes]);
		} catch {
			return fail();
		}
	}

	return { begin, confirm, disable, regenerateBackupCodes };
}
