/**
 * The account password policy, stated once.
 *
 * Every surface that sets a password reads these: the server's BetterAuth
 * config (`apps/api/convex/auth/auth.ts`), the web register and reset forms,
 * and the setup wizard's admin step. Before this module the numbers were
 * restated per screen and had drifted apart (10 on the server, register and
 * reset; 12 in the wizard), so the same person met two different rules.
 *
 * Sign-in deliberately does not read the minimum: checking a password is the
 * server's job, and an account created under an older rule must still be able
 * to sign in.
 */

/** Shortest password any account may set. */
export const MIN_PASSWORD_LENGTH = 12;

/** Longest password any account may set (BetterAuth rejects longer ones). */
export const MAX_PASSWORD_LENGTH = 128;

/** Whether `password` is long enough to be set as an account password. */
export function meetsMinPasswordLength(password: string): boolean {
	return password.length >= MIN_PASSWORD_LENGTH;
}
