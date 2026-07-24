/** One delivery may be deferred by the MTA for up to four days. */
export const GOVERNED_MTA_MAX_MESSAGE_AGE_MS = 4 * 24 * 60 * 60 * 1000;

/** Convex snapshots outlive the MTA queue by this clock/retry safety margin. */
export const ROUTING_REENTRY_CLOCK_SKEW_MS = 60 * 60 * 1000;
export const ROUTING_REENTRY_TOKEN_TTL_MS =
	GOVERNED_MTA_MAX_MESSAGE_AGE_MS + ROUTING_REENTRY_CLOCK_SKEW_MS;

/** Includes the initial attempt. Attempt 8 is terminal and never creates attempt 9. */
export const MAX_GOVERNED_ROUTING_ATTEMPTS = 8;

// AES-GCM ciphertext contains the bound Send/org/attempt locator. Keep this
// bounded at every transport edge without constraining normal Convex IDs.
export const ROUTING_REENTRY_TOKEN_MAX_LENGTH = 512;
export const ROUTING_WORK_ATTEMPT_ID_MAX_LENGTH = 128;
