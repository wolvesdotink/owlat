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

import { coreSendProviderCatalogEntry } from '@owlat/shared/sendProviderCatalog';

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

/**
 * The same skeleton, ORDERED BY THE CATALOG ENTRY (the seams plan's D1/D5):
 * the active kind's `requiredEnvVars`, in the order it declares them, filtered
 * to the ones the status query reports missing.
 *
 * The two lists are the same fact reached two ways — the backend's
 * `requiredEnv` is itself derived from the entry — so ordering by the entry
 * changes nothing today and keeps the operator's remedy in the order the
 * provider's own documentation and the `.env.example` list them, rather than in
 * whatever order a query happened to answer in.
 *
 * ANY REPORTED NAME THE ENTRY DOES NOT DECLARE IS STILL EMITTED, after the
 * declared ones. That is deliberately the fail-OPEN direction, and it is the
 * right one here: this is a remedy list, and dropping a variable the deployment
 * genuinely needs would leave an operator pasting a block that still cannot
 * send, with nothing on the page saying what is missing. An unknown kind — a
 * transport this build does not carry — falls back to the reported list whole,
 * for the same reason.
 */
export function buildProviderEnvSkeleton(
	kind: string | null | undefined,
	missingVarNames: readonly string[]
): string {
	const declared = coreSendProviderCatalogEntry(kind ?? undefined)?.requiredEnvVars ?? [];
	const missing = new Set(missingVarNames.map((name) => name.trim()).filter((name) => name !== ''));
	const ordered = declared.filter((name) => missing.has(name));
	const undeclared = [...missing].filter((name) => !declared.includes(name));
	return buildDeliveryEnvSnippet([...ordered, ...undeclared]);
}
