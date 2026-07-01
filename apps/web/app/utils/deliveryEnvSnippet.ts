/**
 * Delivery "cannot send" remedy — build a copy-paste `.env` skeleton from the
 * MISSING required-env-var names reported by `api.delivery.status.getStatus`.
 *
 * The Settings → Delivery status card knows only the NAMES of the variables the
 * active provider needs and whether each is present (a boolean — the query
 * never returns a credential value). When the instance can't send, this turns
 * that list into an actionable, paste-ready `.env` block: one `NAME=` line per
 * missing variable, values left blank for the operator to fill in.
 *
 * Secret hygiene: this is strictly names-only. It never reads, echoes, or
 * infers a secret value — the emitted lines always end at the `=`. Given an
 * empty set (nothing missing) it returns an empty string so the caller renders
 * no snippet at all.
 */

/**
 * Build a `.env` skeleton (one `NAME=` line per missing variable, empty values)
 * from a list of missing env var names. Returns `''` when nothing is missing so
 * callers can `v-if` the whole snippet away.
 *
 * Names are de-duplicated and blank entries dropped; order is preserved.
 */
export function buildDeliveryEnvSnippet(missingVarNames: readonly string[]): string {
	const seen = new Set<string>();
	const lines: string[] = [];
	for (const raw of missingVarNames) {
		const name = raw.trim();
		if (!name || seen.has(name)) continue;
		seen.add(name);
		lines.push(`${name}=`);
	}
	return lines.join('\n');
}
