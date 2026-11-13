import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ActionCtx } from '../../_generated/server';
import { createAuthOptions } from '../auth';

/**
 * Wiring contract for the change-login-email flow.
 *
 * BetterAuth 1.6.11 applies an email change only after a confirmation link is
 * followed, and for the *verified* path it is a TWO-hop flow:
 *   1. user.changeEmail.sendChangeEmailConfirmation → link to the CURRENT address
 *   2. emailVerification.sendVerificationEmail       → link to the NEW address
 * The change commits only when the second link is followed. If the
 * emailVerification block is missing the flow dead-ends and the email never
 * changes (the seeded owner is emailVerified:true, so the primary admin would be
 * unable to change their login email at all).
 *
 * Unverified accounts (invited members who sign up without a verification flow)
 * skip the first hop: with updateEmailWithoutVerification:false they must NOT
 * change silently — BetterAuth routes them straight to
 * emailVerification.sendVerificationEmail on the NEW address, so the change only
 * lands once that link is followed.
 *
 * These tests assert the option shape + that each callback delivers to the
 * correct address, which is exactly the contract the missing-block regression
 * broke. The ctx is never touched (we only read the static options), so a bare
 * cast is sufficient.
 */
const ctx = {} as ActionCtx;

type CapturedSend = { to: string; from: string; subject: string; html: string };

// Auth emails now route through `ctx.runAction(internal.maintenance.systemMail.sendSystemEmail, …)`
// (the Send system email module), so capture the action args rather than a raw
// MTA fetch. Returns a ctx whose runAction records each send.
function ctxWithCapture(): { ctx: ActionCtx; sends: CapturedSend[] } {
	const sends: CapturedSend[] = [];
	const captureCtx = {
		runAction: vi.fn(async (_ref: unknown, params: CapturedSend) => {
			sends.push(params);
			return undefined;
		}),
	} as unknown as ActionCtx;
	return { ctx: captureCtx, sends };
}

beforeEach(() => {
	vi.stubEnv('MTA_API_URL', 'https://mta.test');
	vi.stubEnv('MTA_API_KEY', 'test-key');
	vi.stubEnv('DEFAULT_FROM_DOMAIN', 'mail.example.com');
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe('change-login-email wiring', () => {
	it('keeps updateEmailWithoutVerification disabled so the change is never silent/immediate', () => {
		const opts = createAuthOptions(ctx);
		expect(opts.user.changeEmail.enabled).toBe(true);
		// The crux: with this false, no account (verified or not) can have its
		// login identity moved without following a link to an owned inbox.
		expect(opts.user.changeEmail.updateEmailWithoutVerification).toBe(false);
	});

	it('hop 1 (sendChangeEmailConfirmation) emails the CURRENT address', async () => {
		const { ctx: captureCtx, sends } = ctxWithCapture();
		const opts = createAuthOptions(captureCtx);

		await opts.user.changeEmail.sendChangeEmailConfirmation({
			user: { name: 'Owner', email: 'current@example.com' },
			newEmail: 'new@example.com',
			url: 'https://app.example.com/verify-email?token=hop1',
		});

		expect(sends).toHaveLength(1);
		const send = sends[0]!;
		// Approval goes to the address already on file, not the claimed one.
		expect(send.to).toBe('current@example.com');
		expect(send.subject).toContain('Confirm your new email');
		expect(send.html).toContain('https://app.example.com/verify-email?token=hop1');
		// References the new address being claimed.
		expect(send.html).toContain('new@example.com');
	});

	it('hop 2 (sendVerificationEmail) emails the NEW address — BetterAuth passes user.email as the claimed one', async () => {
		const { ctx: captureCtx, sends } = ctxWithCapture();
		const opts = createAuthOptions(captureCtx);

		// BetterAuth invokes sendVerificationEmail with user.email ALREADY set to
		// the new address (update-user.mjs / email-verification.mjs spread
		// `...session.user, email: newEmail`).
		// The change-email token carries `updateTo`, the address being claimed;
		// that is what tells this hop apart from a new account's confirmation.
		const payload = Buffer.from(
			JSON.stringify({ email: 'current@example.com', updateTo: 'new@example.com' })
		).toString('base64url');
		await opts.emailVerification!.sendVerificationEmail({
			user: { name: 'Owner', email: 'new@example.com' },
			url: 'https://app.example.com/verify-email?token=hop2',
			token: `header.${payload}.signature`,
		});

		expect(sends).toHaveLength(1);
		const send = sends[0]!;
		// The link that actually commits the change is delivered to the address
		// being claimed, proving ownership.
		expect(send.to).toBe('new@example.com');
		expect(send.subject).toContain('Verify your new login email');
		expect(send.html).toContain('https://app.example.com/verify-email?token=hop2');
		expect(send.html).toContain('new@example.com');
	});
});

/**
 * Every auth mail hook takes its From from the one system sender. With none
 * configured, the hook fails with a configuration error, as it does with no
 * transport, rather than sending under a domain the operator does not own.
 */
describe('auth mail sender', () => {
	function invitationCtx() {
		const sends: CapturedSend[] = [];
		const runMutation = vi.fn(async () => undefined);
		const captureCtx = {
			runAction: vi.fn(async (_ref: unknown, params: CapturedSend) => {
				sends.push(params);
				return undefined;
			}),
			runMutation,
			runQuery: vi.fn(async () => null),
		} as unknown as ActionCtx;
		return { ctx: captureCtx, sends, runMutation };
	}

	const hooks = {
		'password reset': (opts: ReturnType<typeof createAuthOptions>) =>
			opts.emailAndPassword.sendResetPassword({
				user: { email: 'member@example.com' },
				token: 'reset-token',
			}),
		'change-email confirmation': (opts: ReturnType<typeof createAuthOptions>) =>
			opts.user.changeEmail.sendChangeEmailConfirmation({
				user: { email: 'member@example.com' },
				newEmail: 'new@example.com',
				url: 'https://app.example.com/verify-email?token=t',
			}),
		verification: (opts: ReturnType<typeof createAuthOptions>) =>
			opts.emailVerification!.sendVerificationEmail({
				user: { email: 'member@example.com' },
				url: 'https://app.example.com/verify-email?token=t',
				token: 'header.e30.signature',
			}),
		invitation: (opts: ReturnType<typeof createAuthOptions>) => {
			const plugin = opts.plugins.find((p) => p.id === 'organization') as unknown as {
				options: {
					sendInvitationEmail: (data: unknown) => Promise<void>;
				};
			};
			return plugin.options.sendInvitationEmail({
				email: 'invitee@example.com',
				organization: { id: 'org-1', name: 'Acme' },
				inviter: { user: { name: 'Owner', email: 'owner@example.com' } },
				invitation: { id: 'inv-1', role: 'editor' },
			});
		},
	};

	it.each(Object.entries(hooks))('sends the %s mail from the configured sender', async (_, run) => {
		const { ctx: captureCtx, sends } = invitationCtx();
		await run(createAuthOptions(captureCtx));
		expect(sends.map((send) => send.from)).toEqual(['Owlat <noreply@mail.example.com>']);
	});

	it.each(Object.entries(hooks))(
		'refuses the %s mail when no sender is configured',
		async (_, run) => {
			vi.stubEnv('DEFAULT_FROM_DOMAIN', '');
			vi.stubEnv('DEFAULT_FROM_EMAIL', '');
			const { ctx: captureCtx, sends, runMutation } = invitationCtx();
			await expect(run(createAuthOptions(captureCtx))).rejects.toThrow(/DEFAULT_FROM_DOMAIN/);
			expect(sends).toEqual([]);
			// The invitation's resend cooldown is not spent on a mail that never left.
			expect(runMutation).not.toHaveBeenCalled();
		}
	);
});
