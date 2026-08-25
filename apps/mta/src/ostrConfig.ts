/**
 * OSTR (Open Sender Trust Registry) configuration, parsed out of the
 * environment (plan §12.2).
 *
 * Split out of `config.ts` — like `daneConfig.ts` and `ehloConfig.ts` — to keep
 * that module under the file-size gate. `loadConfig` calls {@link loadOstrConfig}
 * and spreads the result, so the boot-time validation order is unchanged.
 *
 * Everything here is off unless the operator opted in, and a malformed value
 * fails the BOOT rather than silently disabling the signal — the fail-open
 * contract covers lookups at runtime, not typos in the env file.
 */

export interface OstrConfig {
	/**
	 * Consume OSTR (Open Sender Trust Registry) tier signal on the inbound path
	 * (plan §12.2). Off by default: an instance that has not chosen an aggregator
	 * must issue no OSTR lookups at all. The tier is a SIGNAL, never a gate — it
	 * rides along to Convex on the mailbox payload and never changes an SMTP reply.
	 */
	ostrEnabled: boolean;
	/**
	 * DNS zone apex the tier lookups are made under, e.g. `ostr.owlat.app`. The
	 * FALLBACK path: a query publishes to the aggregator, and to every resolver
	 * between, who is sending this instance mail, so it is asked only for a
	 * subject the local signed snapshot has no entry for (spec 08 §8.3).
	 */
	ostrZone?: string;
	/**
	 * Aggregator base URL. Its signed snapshot is the PREFERRED lookup path —
	 * the same answer out of a file the instance already holds, leaking nothing.
	 * Required together with {@link OstrConfig.ostrAggregatorPublicKey}.
	 */
	ostrAggregatorUrl?: string;
	/**
	 * Aggregator ed25519 public key (base64) that signs its snapshots. Without it
	 * a snapshot cannot be verified, so it is not usable — hence required
	 * together with the URL rather than optional beside it.
	 */
	ostrAggregatorPublicKey?: string;
	/**
	 * Observer mode: capture DKIM verification evidence (§7.2) for messages this
	 * instance accepts, so a later spam report can be substantiated. Env-gated,
	 * never feature-flagged — it changes what leaves the building.
	 */
	ostrObserverEnabled: boolean;
	/** Per-lookup timeout (ms). A slower answer is discarded, never awaited. */
	ostrLookupTimeoutMs: number;
}

/**
 * Whether `value` parses as an absolute `http:`/`https:` URL. `new URL` throws
 * on anything else, and a base URL that cannot be parsed would otherwise only
 * surface as a fetch failure hours after the boot that accepted it.
 */
function isHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === 'http:' || url.protocol === 'https:';
	} catch {
		return false;
	}
}

/** Parse and validate the `OSTR_*` environment, or throw at boot. */
export function loadOstrConfig(
	optionalEnv: (key: string, defaultValue: string) => string
): OstrConfig {
	const ostrEnabled = optionalEnv('OSTR_ENABLED', 'false') === 'true';
	const ostrZone = process.env['OSTR_ZONE']?.trim().toLowerCase() || undefined;
	if (ostrZone && !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(ostrZone)) {
		throw new Error('OSTR_ZONE must be a DNS hostname');
	}
	const ostrLookupTimeoutMs = parseInt(optionalEnv('OSTR_LOOKUP_TIMEOUT_MS', '2000'), 10);
	if (!Number.isFinite(ostrLookupTimeoutMs) || ostrLookupTimeoutMs <= 0) {
		throw new Error('OSTR_LOOKUP_TIMEOUT_MS must be a positive number of milliseconds');
	}
	const ostrAggregatorUrl = process.env['OSTR_AGGREGATOR_URL']?.trim() || undefined;
	const ostrAggregatorPublicKey = process.env['OSTR_AGGREGATOR_PUBLIC_KEY']?.trim() || undefined;
	// Required TOGETHER (the `googlePostmaster` triple's rule, for the same
	// reason): a snapshot whose signature cannot be checked is not a snapshot,
	// and a key with nowhere to fetch from silently buys nothing.
	if ((ostrAggregatorUrl === undefined) !== (ostrAggregatorPublicKey === undefined)) {
		throw new Error('OSTR_AGGREGATOR_URL and OSTR_AGGREGATOR_PUBLIC_KEY are required together');
	}
	if (ostrAggregatorUrl !== undefined && !isHttpUrl(ostrAggregatorUrl)) {
		throw new Error('OSTR_AGGREGATOR_URL must be an http(s) URL');
	}
	// Opting in without naming somewhere to ask would boot a happy MX that
	// silently produces no tier for any message, forever. Fail the boot instead.
	if (ostrEnabled && ostrZone === undefined && ostrAggregatorUrl === undefined) {
		throw new Error(
			'OSTR_ENABLED=true requires OSTR_ZONE (DNS lookups) and/or ' +
				'OSTR_AGGREGATOR_URL + OSTR_AGGREGATOR_PUBLIC_KEY (signed snapshot)'
		);
	}

	return {
		ostrEnabled,
		ostrZone,
		ostrAggregatorUrl,
		ostrAggregatorPublicKey,
		ostrObserverEnabled: optionalEnv('OSTR_OBSERVER_ENABLED', 'false') === 'true',
		ostrLookupTimeoutMs,
	};
}
