/**
 * Re-authenticate the CURRENT session against its own password.
 *
 * A live session proves "this browser was logged in at some point". Some actions
 * need more than that — they need "the person at the keyboard right now knows
 * the password" — because the consequence of getting them wrong is permanent.
 * Sealed Mail's member recovery-kit download (plan idea 55) is the first such
 * action: it hands over the private key that opens someone's sealed mail, and an
 * unlocked laptop must not be enough.
 *
 * This is deliberately NOT a sign-in. It issues no session, sets no cookie and
 * returns nothing but a boolean, so a caller cannot accidentally turn a
 * confirmation prompt into a credential-stuffing endpoint that mints sessions.
 * It reads the caller's `credential` account through BetterAuth's own internal
 * adapter and compares with BetterAuth's own hasher, so the comparison uses the
 * exact algorithm and parameters that hashed the password in the first place —
 * re-implementing that here is how a re-auth check silently stops working after
 * a hashing upgrade.
 *
 * A user with no `credential` account (invited but never set a password, or an
 * account that only ever authenticated another way) FAILS CLOSED: there is no
 * password to prove, so nothing is proven.
 *
 * The rate limit lives with the caller, not here — see `e2ee/memberKeys.ts` and
 * `e2ee/recoveryKitGate.ts`, which throttle BEFORE this function is reached so a
 * guesser never gets to spend a password hash.
 */

import type { ActionCtx } from '../_generated/server';
import { createAuth } from './auth';

/**
 * The slice of BetterAuth's internal context this file uses. Declared
 * structurally because the published `$context` type does not surface the
 * internal adapter; naming exactly what we touch keeps the cast honest and makes
 * an upstream shape change a compile error at ONE line instead of a silent
 * `undefined` that would quietly answer "verified" to everything.
 */
interface BetterAuthInternals {
	internalAdapter: {
		findAccounts: (userId: string) => Promise<{ providerId: string; password?: string | null }[]>;
	};
	password: {
		verify: (input: { hash: string; password: string }) => Promise<boolean>;
	};
}

/**
 * Verify `password` against the calling identity's own stored credential.
 * Returns false — never throws — for an anonymous caller, a user with no
 * password credential, or a mismatch, so the caller decides what a failure means
 * (and records it for the rate limiter).
 */
export async function verifyCurrentUserPassword(
	ctx: ActionCtx,
	password: string
): Promise<boolean> {
	// An empty password is never valid; short-circuiting also keeps a blank
	// submit from reaching the hasher at all.
	if (!password) return false;
	const identity = await ctx.auth.getUserIdentity();
	const userId = typeof identity?.subject === 'string' ? identity.subject : null;
	if (!userId) return false;

	try {
		const auth = createAuth(ctx);
		const internals = (await auth.$context) as unknown as BetterAuthInternals;
		const accounts = await internals.internalAdapter.findAccounts(userId);
		const credential = accounts.find((account) => account.providerId === 'credential');
		const hash = credential?.password;
		// Fail closed: no credential account means there is no password to prove.
		if (!hash) return false;
		return await internals.password.verify({ hash, password });
	} catch {
		// A misconfigured or unreachable auth context must read as "not verified",
		// never as "verified" — this gate stands in front of a private key.
		return false;
	}
}
