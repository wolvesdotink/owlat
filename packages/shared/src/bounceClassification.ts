/**
 * Free-text bounce classification shared by the Resend webhook adapter and the
 * MTA bounce engine, so the hard/soft pattern lists can't drift. (The MTA also
 * applies RFC 3464 DSN-code precedence + ARF complaint detection, which it keeps
 * locally; this is the free-text heuristic both paths need.)
 *
 * Defaults to 'soft' for ambiguous text — the safer fallback, since 'hard'
 * permanently blocklists the address. A message matching BOTH a hard and a soft
 * pattern is treated as soft.
 */

/** Patterns for addresses that are permanently undeliverable. */
export const HARD_BOUNCE_PATTERNS =
	/does not exist|user unknown|invalid address|rejected|no such user|mailbox not found|account disabled|account has been disabled|address rejected|recipient rejected|no mailbox|user not found|mailbox unavailable|relay denied|relay not permitted|5\.1\.1/i;

/** Patterns for temporary failures (retryable, no blocklist). */
export const SOFT_BOUNCE_PATTERNS =
	/mailbox full|quota exceeded|over quota|try again later|temporarily|too many connections|rate limit|service unavailable|connection timed out|greylisted|greylist|try again|resources temporarily|4\.\d\.\d/i;

/**
 * Classify free-text bounce content as 'hard' (permanent) or 'soft' (temporary).
 * Soft wins ties and is the default for unrecognized text.
 */
export function classifyBounceMessage(text: string): 'hard' | 'soft' {
	const isHard = HARD_BOUNCE_PATTERNS.test(text);
	const isSoft = SOFT_BOUNCE_PATTERNS.test(text);
	return isHard && !isSoft ? 'hard' : 'soft';
}
