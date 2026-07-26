/**
 * Provider-compliance thresholds shown by the API and documentation.
 *
 * Keep these separate from Owlat's stricter internal circuit-breaker policy:
 * they describe the Gmail proximity indicator and the provider unsubscribe
 * honor window, not MTA enforcement.
 */
const HOUR_MS = 60 * 60 * 1000;

export const GMAIL_BULK_SENDER_THRESHOLD = 5_000;
export const GMAIL_PROXIMITY_WARNING_THRESHOLD = 4_000;
export const UNSUBSCRIBE_HONOR_WINDOW_MS = 48 * HOUR_MS;
