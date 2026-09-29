/**
 * Failed-login policy for Postbox app passwords, shared by every limiter that
 * enforces it: the Convex `mail/authRateLimit.ts` table (SMTP submission and
 * IMAP, via `verify`) and the IMAP server's Redis limiter in front of it.
 *
 * Both count failures in the same sliding window, per mailbox address and per
 * client IP (keyed with `ipRateLimitKey`, so an IPv6 client counts per /64).
 */

/** Sliding window over which failed logins are counted. */
export const MAIL_AUTH_FAILURE_WINDOW_MS = 60_000;

/** Failed logins per mailbox address within the window before it is throttled. */
export const MAIL_AUTH_FAILURES_PER_ADDRESS = 5;

/** Failed logins per client IP within the window before it is throttled. */
export const MAIL_AUTH_FAILURES_PER_IP = 50;
