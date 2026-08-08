/**
 * Is the return-path host allowed to be a RELAY's envelope sender? (plan G-08)
 *
 * Deliberately apart from `./smtp/returnPath.ts`, which builds the VERP address
 * and therefore imports `node:crypto`. This decision is read by the ROUTING
 * seam — a plain Convex module, not a `'use node'` one — so it must stay free
 * of the Node runtime. Pure: no clock, no env, no db; every input is a
 * parameter.
 */

/**
 * How long a published return-path SPF proof is trusted before the stamp is
 * withdrawn. DNS an operator changed a month ago is not evidence about today's
 * authorisation.
 */
export const RETURN_PATH_SPF_PROOF_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** A verification result for the return-path host's generated SPF record. */
export interface ReturnPathSpfProof {
	readonly verified: boolean;
	readonly lastChecked: number;
	/** What the checker actually read at the host, when it recorded it. */
	readonly foundValue?: string | undefined;
}

export interface ReturnPathAuthorizationInput {
	/** The resolved return-path host (per-domain override, else the global env). */
	readonly host: string | undefined;
	/** The configured relay-authorisation terms (`MTA_RETURN_PATH_RELAY_SPF`). */
	readonly relaySpfTerms: readonly string[];
	/** The SPF value we GENERATED for that host, if the domain carries one. */
	readonly generatedSpfValue: string | undefined;
	/** The verification result for that generated record, if it was checked. */
	readonly proof: ReturnPathSpfProof | undefined;
	readonly now: number;
}

/**
 * Does the return-path host actually authorise the RELAY to use it as an
 * envelope sender?
 *
 * The generated return-path SPF record authorises the MTA pool IPs. Stamping
 * `bounce+…@<host>` on a send that leaves through a third-party relay makes the
 * receiver evaluate SPF for that host against the RELAY's IP, so without this
 * gate the act of measuring the relay arm would fail its SPF, remove DMARC's
 * SPF leg, and degrade the very reputation under measurement — biasing the
 * bounce comparison in the opposite direction from the one this feature exists
 * to correct.
 *
 * So the stamp requires PUBLISHED, VERIFIED evidence: every configured relay
 * term must appear in the record actually observed at the host (the observed
 * value wins over the one we generated — the operator may not have published
 * our latest), that check must have passed, and it must be recent.
 *
 * Total and fail-closed: a missing host, no configured terms, an unverified,
 * stale or clock-skewed proof all return `false`, which means "do not stamp" —
 * a degraded measurement, never an error and never a blocked send (plan D2).
 */
export function returnPathAuthorizesRelay(input: ReturnPathAuthorizationInput): boolean {
	if (!input.host || input.relaySpfTerms.length === 0) return false;
	const proof = input.proof;
	if (!proof?.verified) return false;
	const age = input.now - proof.lastChecked;
	if (!Number.isFinite(age) || age < 0 || age >= RETURN_PATH_SPF_PROOF_MAX_AGE_MS) return false;
	const record = proof.foundValue ?? input.generatedSpfValue;
	if (!record) return false;
	// Whole-token comparison: `include:relay.example.com` must not be satisfied
	// by `include:relay.example.com.evil` appearing as a substring.
	const tokens = new Set(record.toLowerCase().split(/\s+/).filter(Boolean));
	return input.relaySpfTerms.every((term) => tokens.has(term.trim().toLowerCase()));
}
