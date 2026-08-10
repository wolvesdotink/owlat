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
 *
 * MANDRILL IS NO LONGER THE ONLY READER. Every bundled plugin relay's proof is
 * bounded by this value too: `PLUGIN_RELAY_PROOF_MAX_AGE_MS` in
 * `apps/api/convex/domains/providers/plugin/state.ts` is DEFINED as this constant,
 * because that tier's evidence is renewed exactly the same way (one HTTP call a
 * daily sweep repeats) and so has exactly the same argument behind its bound.
 * Shortening this after a Mandrill incident therefore also shortens how long a
 * third-party plugin relay may be handed a customer's From domain — which is
 * usually the right direction, but it is a decision about both tiers rather than
 * one. The alias is pinned by that file's own suite, so changing it deliberately
 * is one edit and changing it accidentally is a test failure.
 */
export const MANDRILL_RELAY_PROOF_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
