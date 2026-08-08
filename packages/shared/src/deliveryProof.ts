/** Relay DNS/provider proof must be renewed before routing may rely on it. */
export const SES_RELAY_PROOF_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The same bound for a Mandrill sending-domain identity — and deliberately a
 * much tighter one (7 days vs. SES's 30).
 *
 * SES's proof is assembled from our OWN DNS crawl of a handful of records, so
 * refreshing it costs a batch of live lookups and the horizon is set by what we
 * can afford to re-observe. Mandrill's is one `senders/check-domain` call that
 * Mandrill answers from its own DNS view, so the daily sweep can keep it fresh
 * for the price of one HTTP request per domain — and a proof that cheap has no
 * excuse to be a month old before routing stops trusting it. Seven days is the
 * outage headroom: a multi-day Mandrill API outage does not strand a live relay,
 * a week-long one does (fail closed, which is the right direction for "may we
 * hand this From domain to a third party?").
 */
export const MANDRILL_RELAY_PROOF_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
