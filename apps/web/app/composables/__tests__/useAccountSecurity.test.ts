import { describe, expect, it, beforeEach, vi } from 'vitest';
import { ref } from 'vue';
import { useAccountSessions, useTwoFactorEnrolment } from '~/composables/useAccountSecurity';

/**
 * BetterAuth's client is the only thing these composables talk to, so it is the
 * only thing mocked. Each method returns better-fetch's `{ data, error }`
 * envelope — the shape the composables branch on — and never throws, except
 * where a test deliberately makes it throw.
 */
const listSessions = vi.fn();
const revokeSession = vi.fn();
const revokeOtherSessions = vi.fn();
const enable = vi.fn();
const verifyTotp = vi.fn();
const disable = vi.fn();
const generateBackupCodes = vi.fn();

vi.mock('~/lib/auth-client', () => ({
	authClient: {
		listSessions: () => listSessions(),
		revokeSession: (body: { token: string }) => revokeSession(body),
		revokeOtherSessions: () => revokeOtherSessions(),
		twoFactor: {
			enable: (body: unknown) => enable(body),
			verifyTotp: (body: unknown) => verifyTotp(body),
			disable: (body: unknown) => disable(body),
			generateBackupCodes: (body: unknown) => generateBackupCodes(body),
		},
	},
}));

const WIRE_SESSIONS = [
	{
		id: 'a',
		token: 'tok_a',
		createdAt: '2026-08-01T09:00:00.000Z',
		updatedAt: '2026-08-01T09:00:00.000Z',
		expiresAt: '2026-09-01T09:00:00.000Z',
		ipAddress: '203.0.113.4',
		userAgent: 'Mozilla/5.0 (Windows NT 10.0) Firefox/135.0',
	},
	{
		id: 'b',
		token: 'tok_current',
		createdAt: '2026-08-02T09:00:00.000Z',
		updatedAt: '2026-08-02T09:00:00.000Z',
		expiresAt: '2026-09-02T09:00:00.000Z',
		ipAddress: null,
		userAgent: null,
	},
];

beforeEach(() => {
	vi.clearAllMocks();
	listSessions.mockResolvedValue({ data: WIRE_SESSIONS, error: null });
	revokeSession.mockResolvedValue({ data: { status: true }, error: null });
	revokeOtherSessions.mockResolvedValue({ data: { status: true }, error: null });
});

describe('useAccountSessions', () => {
	it('starts loading and settles once the list arrives', async () => {
		const account = useAccountSessions(() => 'tok_current');
		expect(account.isLoading.value).toBe(true);

		await account.refresh();

		expect(account.isLoading.value).toBe(false);
		expect(account.hasLoadError.value).toBe(false);
		expect(account.sessions.value).toHaveLength(2);
	});

	/**
	 * The token getter is called on every read rather than captured once: TOTP
	 * enrolment ROTATES the session mid-page, and a captured token would leave
	 * the row the user is sitting on unmarked — and therefore revocable.
	 */
	it('re-reads the current token instead of capturing it', async () => {
		// A ref, because that is what the page passes through: the getter closes
		// over `currentSession`, so reading it INSIDE the computed is what makes
		// the rotation propagate.
		const token = ref('tok_a');
		const account = useAccountSessions(() => token.value);
		await account.refresh();
		expect(account.sessions.value[0]!.token).toBe('tok_a');

		token.value = 'tok_current';
		expect(account.sessions.value[0]!.token).toBe('tok_current');
		expect(account.otherSessionCount.value).toBe(1);
	});

	it('flags a failed load rather than showing an empty list', async () => {
		listSessions.mockResolvedValue({ data: null, error: { code: 'INTERNAL' } });
		const account = useAccountSessions(() => null);

		await account.refresh();

		expect(account.hasLoadError.value).toBe(true);
		expect(account.isLoading.value).toBe(false);
		expect(account.sessions.value).toEqual([]);
	});

	it('flags a thrown load the same way, and stops loading', async () => {
		listSessions.mockRejectedValue(new Error('offline'));
		const account = useAccountSessions(() => null);

		await account.refresh();

		expect(account.hasLoadError.value).toBe(true);
		expect(account.isLoading.value).toBe(false);
	});

	it('revokes by TOKEN, which is the handle the endpoint takes', async () => {
		const account = useAccountSessions(() => 'tok_current');
		await account.refresh();

		const result = await account.revoke('tok_a');

		expect(result).toEqual({ ok: true, data: undefined });
		expect(revokeSession).toHaveBeenCalledWith({ token: 'tok_a' });
	});

	/**
	 * The row is never spliced out locally — only the server knows whether the
	 * token was still live, and an optimistic removal would claim a device was
	 * signed out when the call had in fact failed.
	 */
	it('re-reads the list after a successful revoke', async () => {
		const account = useAccountSessions(() => 'tok_current');
		await account.refresh();
		expect(listSessions).toHaveBeenCalledTimes(1);

		await account.revoke('tok_a');

		expect(listSessions).toHaveBeenCalledTimes(2);
	});

	it('does NOT re-read after a failed revoke, and reports the failure', async () => {
		revokeSession.mockResolvedValue({ data: null, error: { code: 'INTERNAL' } });
		const account = useAccountSessions(() => 'tok_current');
		await account.refresh();

		const result = await account.revoke('tok_a');

		expect(result).toEqual({ ok: false, code: 'failed' });
		expect(listSessions).toHaveBeenCalledTimes(1);
	});

	it('reports a thrown revoke as a failure instead of propagating it', async () => {
		revokeSession.mockRejectedValue(new Error('offline'));
		const account = useAccountSessions(() => 'tok_current');

		await expect(account.revoke('tok_a')).resolves.toEqual({ ok: false, code: 'failed' });
	});

	it('signs out the other sessions and re-reads', async () => {
		const account = useAccountSessions(() => 'tok_current');
		await account.refresh();

		const result = await account.revokeOthers();

		expect(result.ok).toBe(true);
		expect(revokeOtherSessions).toHaveBeenCalledTimes(1);
		expect(listSessions).toHaveBeenCalledTimes(2);
	});
});

describe('useTwoFactorEnrolment', () => {
	it('returns the enrolment payload from a successful enable', async () => {
		enable.mockResolvedValue({
			data: { totpURI: 'otpauth://totp/Owlat:ada?secret=ABCD', backupCodes: ['one', 'two'] },
			error: null,
		});

		const result = await useTwoFactorEnrolment().begin('correct horse');

		expect(enable).toHaveBeenCalledWith({ password: 'correct horse' });
		expect(result).toEqual({
			ok: true,
			data: { totpURI: 'otpauth://totp/Owlat:ada?secret=ABCD', backupCodes: ['one', 'two'] },
		});
	});

	/**
	 * "Wrong password" must never collapse into the generic bucket: it is one of
	 * only two failures the user can act on, and "Something went wrong" beside a
	 * password field is the least useful thing a security page can say.
	 */
	it('distinguishes a rejected password from a generic failure', async () => {
		enable.mockResolvedValue({ data: null, error: { code: 'INVALID_PASSWORD' } });
		expect(await useTwoFactorEnrolment().begin('nope')).toEqual({
			ok: false,
			code: 'wrong-password',
		});

		enable.mockResolvedValue({ data: null, error: { code: 'INTERNAL_SERVER_ERROR' } });
		expect(await useTwoFactorEnrolment().begin('nope')).toEqual({ ok: false, code: 'failed' });
	});

	it('distinguishes a rejected code from a generic failure', async () => {
		verifyTotp.mockResolvedValue({ data: null, error: { code: 'INVALID_CODE' } });
		expect(await useTwoFactorEnrolment().confirm('000000')).toEqual({
			ok: false,
			code: 'invalid-code',
		});
	});

	it('classifies by error CODE, never by the server message', async () => {
		// The message is English server prose that is never shown; a classifier
		// keyed on it would break the moment it were reworded.
		verifyTotp.mockResolvedValue({
			data: null,
			error: { code: 'SOMETHING_ELSE', message: 'Invalid password' },
		});
		expect(await useTwoFactorEnrolment().confirm('123456')).toEqual({
			ok: false,
			code: 'failed',
		});
	});

	it('confirms a code through verifyTotp', async () => {
		verifyTotp.mockResolvedValue({ data: { status: true }, error: null });

		expect(await useTwoFactorEnrolment().confirm('123456')).toEqual({ ok: true, data: undefined });
		expect(verifyTotp).toHaveBeenCalledWith({ code: '123456' });
	});

	it('disables with the account password', async () => {
		disable.mockResolvedValue({ data: { status: true }, error: null });

		expect(await useTwoFactorEnrolment().disable('correct horse')).toEqual({
			ok: true,
			data: undefined,
		});
		expect(disable).toHaveBeenCalledWith({ password: 'correct horse' });
	});

	it('hands back a fresh set of backup codes', async () => {
		generateBackupCodes.mockResolvedValue({
			data: { status: true, backupCodes: ['aaa', 'bbb'] },
			error: null,
		});

		expect(await useTwoFactorEnrolment().regenerateBackupCodes('correct horse')).toEqual({
			ok: true,
			data: ['aaa', 'bbb'],
		});
	});

	it('reports a thrown two-factor call as a failure instead of propagating it', async () => {
		enable.mockRejectedValue(new Error('offline'));

		await expect(useTwoFactorEnrolment().begin('x')).resolves.toEqual({
			ok: false,
			code: 'failed',
		});
	});
});
