import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ActionCtx } from '../../_generated/server';
import { createAuthOptions } from '../auth';

/**
 * Wiring contract for the change-login-email flow (PR #166).
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

// Auth emails now route through `ctx.runAction(internal.systemMail.sendSystemEmail, …)`
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

	it('configures BOTH hops of the verified two-step flow', () => {
		const opts = createAuthOptions(ctx);
		// Hop 1 (verified): confirmation to the current address.
		expect(typeof opts.user.changeEmail.sendChangeEmailConfirmation).toBe('function');
		// Hop 2 (verified) / sole hop (unverified): verification to the new
		// address. Without this BetterAuth dead-ends and the email never changes.
		expect(typeof opts.emailVerification?.sendVerificationEmail).toBe('function');
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
		await opts.emailVerification!.sendVerificationEmail({
			user: { name: 'Owner', email: 'new@example.com' },
			url: 'https://app.example.com/verify-email?token=hop2',
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
