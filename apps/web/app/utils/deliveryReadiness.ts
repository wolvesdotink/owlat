import type { HealthTone } from '~/utils/healthTone';

/**
 * The single source of truth for "can this instance actually send mail, and if
 * not, what is missing?".
 *
 * Go-live for a self-hosted Owlat has two halves that used to be asserted in two
 * different places — the setup wizard / delivery config (a transport) and the
 * domains page (a verified, authenticated sending domain) — and the self-host
 * onboarding banner independently re-listed both as if the wizard never ran. This
 * helper is where the two halves finally meet: it DERIVES one combined readiness
 * verdict from the real backend state (`getTransportSummary.canSend` +
 * `getDeliveryDomainTable`), so the Delivery hub leads with it and the onboarding
 * banner can defer its pre-send steps to this one place instead of duplicating
 * them.
 *
 * Kept DOM- and DB-free (pure primitives in, plain data out) so the gate → state
 * mapping is unit-testable without mounting anything or reaching the Convex
 * client.
 */

/**
 * The readiness gates, in the order the panel renders them. `mta-sts` is a
 * conditional gate — it appears only when the deployment is publishing an
 * MTA-STS policy in `enforce` mode whose DNS/policy isn't verified yet, so that
 * an unfinished inbound-TLS hardening step is surfaced without adding noise to
 * deployments that don't publish a policy.
 */
export type ReadinessGateKey = 'transport' | 'domain' | 'authentication' | 'mta-sts';

/**
 * A gate's state:
 *  - `ready`     — satisfied.
 *  - `attention` — needs an action from the operator (a fix link is offered).
 *  - `pending`   — waiting on something external (DNS propagation) or not yet
 *                  applicable; no action the operator can take right now.
 */
export type ReadinessGateStatus = 'ready' | 'attention' | 'pending';

export interface ReadinessGate {
	key: ReadinessGateKey;
	/** Human title of the gate. */
	title: string;
	/** One plain-language line on where this gate stands. No jargon, no lecture. */
	detail: string;
	status: ReadinessGateStatus;
	/** Shared health tone → token classes (see `healthTone.ts`). */
	tone: HealthTone;
	/** In-app route that resolves this gate, or `null` when there's nothing to do. */
	actionHref: string | null;
	/** Label for the fix link, or `null` when `actionHref` is `null`. */
	actionLabel: string | null;
}

/** Overall readiness level for the panel's headline chip. */
export type ReadinessLevel = 'ready' | 'blocked' | 'incomplete';

export interface DeliveryReadiness {
	/** The real gate: transport configured AND a verified sending domain. */
	canSend: boolean;
	level: ReadinessLevel;
	tone: HealthTone;
	/** Headline verdict, e.g. "Ready to send". */
	headline: string;
	/** One sentence naming the single next thing to do (or an all-clear line). */
	summary: string;
	gates: ReadinessGate[];
}

/** The derived facts the readiness verdict is computed from. */
export interface ReadinessInput {
	/**
	 * The real send-path gate — `getTransportSummary.canSend`, itself
	 * `isDeliveryConfigured` on the backend. True only when a usable transport
	 * (provider + credentials, or an advanced route) is configured.
	 */
	transportConfigured: boolean;
	/** Whether any sending domain is configured at all. */
	hasDomains: boolean;
	/** Whether at least one sending domain has fully verified. */
	domainVerified: boolean;
	/** For the best-configured domain: are SPF, DKIM AND DMARC all present? */
	authComplete: boolean;
	/** Auth record names still missing for that domain, in display order. */
	authMissing: string[];
	/**
	 * The deployment is publishing an MTA-STS policy in `enforce` mode, but the
	 * `_mta-sts` TXT record / served policy isn't verified yet. Optional and
	 * defaults to "no warning" — deployments that publish nothing (the default)
	 * or are still in `testing` leave it unset, so this never touches their
	 * verdict. When true it downgrades an otherwise-ready instance to a warning:
	 * enforce without the record in place can bounce inbound mail from senders
	 * that honour the policy.
	 */
	mtaStsEnforceWithoutRecord?: boolean;
}

/**
 * The transport half of the two go-live sources: the non-secret
 * `getTransportSummary` — only `canSend` (the real send-path gate) matters here.
 */
export interface ReadinessTransportSummary {
	canSend: boolean;
}

/**
 * The domain half: one row of `getDeliveryDomainTable`, narrowed to the two
 * facts readiness needs — whether it's verified and which auth records are still
 * missing. Structural on purpose so this stays free of the Convex client.
 */
export interface ReadinessDomainRow {
	status: 'registering' | 'pending' | 'verified' | 'failed';
	missing: string[];
}

/**
 * The MTA-STS half: the deployment's current inbound-TLS publishing state,
 * narrowed to the two facts readiness needs. Structural on purpose (no import of
 * the shared `MtaStsMode`) so this stays a pure primitive-in helper. Optional —
 * a viewer who can't read the admin-gated guidance (or a deployment that
 * publishes nothing) passes `null` and the MTA-STS gate never appears.
 */
export interface ReadinessMtaStsSource {
	/** Current publishing mode (`none` | `testing` | `enforce`). */
	mode: 'none' | 'testing' | 'enforce';
	/** The `_mta-sts` record + served policy verified live against what we serve. */
	recordVerified: boolean;
}

/**
 * Fold the live query results into the flat `ReadinessInput` the verdict is
 * derived from. This is the small piece of real derivation the panel used to do
 * inline: which domain we report authentication against, plus the conditional
 * MTA-STS warning.
 *
 * `getDeliveryDomainTable` returns rows already sorted most-active first, so we
 * report auth against the most-active VERIFIED domain (the one mail actually
 * sends from), falling back to the most-active configured domain before any has
 * verified, and to nothing at all when there are no domains yet.
 *
 * `mtaSts` is the admin-only inbound-TLS state: only `enforce` published WITHOUT
 * the record verified sets `mtaStsEnforceWithoutRecord` (and thus the warning);
 * `none`/`testing`, an already-verified record, or a `null` source (non-admin or
 * no policy) leave it unset so nothing changes for those deployments.
 */
export function readinessInputFromSources(
	summary: ReadinessTransportSummary,
	rows: readonly ReadinessDomainRow[],
	mtaSts?: ReadinessMtaStsSource | null
): ReadinessInput {
	const verified = rows.filter((row) => row.status === 'verified');
	const primary = verified[0] ?? rows[0] ?? null;
	return {
		transportConfigured: summary.canSend,
		hasDomains: rows.length > 0,
		domainVerified: verified.length > 0,
		authComplete: primary ? primary.missing.length === 0 : false,
		authMissing: primary?.missing ?? [],
		mtaStsEnforceWithoutRecord:
			mtaSts != null && mtaSts.mode === 'enforce' && !mtaSts.recordVerified,
	};
}

const DOMAINS_HREF = '/dashboard/delivery/domains';
const CONFIG_HREF = '/dashboard/delivery/config';

/** The transport gate: reads the same `canSend` the send path itself uses. */
function transportGate(input: ReadinessInput): ReadinessGate {
	if (input.transportConfigured) {
		return {
			key: 'transport',
			title: 'Sending transport',
			detail: 'A delivery transport is configured, so mail has a way out.',
			status: 'ready',
			tone: 'success',
			actionHref: null,
			actionLabel: null,
		};
	}
	return {
		key: 'transport',
		title: 'Sending transport',
		detail: 'No transport is configured yet, so nothing can be sent.',
		status: 'attention',
		tone: 'error',
		actionHref: CONFIG_HREF,
		actionLabel: 'Set up sending',
	};
}

/** The sending-domain gate: needs a domain, then that domain to verify. */
function domainGate(input: ReadinessInput): ReadinessGate {
	if (input.domainVerified) {
		return {
			key: 'domain',
			title: 'Sending domain',
			detail: 'Your sending domain is verified, so mail comes from your own address.',
			status: 'ready',
			tone: 'success',
			actionHref: null,
			actionLabel: null,
		};
	}
	if (input.hasDomains) {
		return {
			key: 'domain',
			title: 'Sending domain',
			detail: 'Your domain is added but not verified yet — DNS changes can take a little while.',
			status: 'pending',
			tone: 'warning',
			actionHref: DOMAINS_HREF,
			actionLabel: 'Check verification',
		};
	}
	return {
		key: 'domain',
		title: 'Sending domain',
		detail: 'Add a sending domain so mail comes from your own address, not a shared one.',
		status: 'attention',
		tone: 'warning',
		actionHref: DOMAINS_HREF,
		actionLabel: 'Add a domain',
	};
}

/** The email-authentication gate (SPF · DKIM · DMARC on the sending domain). */
function authenticationGate(input: ReadinessInput): ReadinessGate {
	// Nothing to authenticate until a domain exists — stay pending, not red, so a
	// brand-new instance doesn't read as broken before the domain step is even done.
	if (!input.hasDomains) {
		return {
			key: 'authentication',
			title: 'Email authentication',
			detail: 'SPF, DKIM and DMARC are checked once you add a sending domain.',
			status: 'pending',
			tone: 'neutral',
			actionHref: null,
			actionLabel: null,
		};
	}
	if (input.authComplete) {
		return {
			key: 'authentication',
			title: 'Email authentication',
			detail: 'SPF, DKIM and DMARC are all in place — inboxes can trust your mail.',
			status: 'ready',
			tone: 'success',
			actionHref: null,
			actionLabel: null,
		};
	}
	const missing = input.authMissing.length > 0 ? input.authMissing.join(', ') : 'SPF, DKIM, DMARC';
	return {
		key: 'authentication',
		title: 'Email authentication',
		detail: `Add ${missing} so mailboxes trust your mail and it lands in the inbox.`,
		status: 'attention',
		tone: 'warning',
		actionHref: DOMAINS_HREF,
		actionLabel: 'Set up records',
	};
}

/**
 * The MTA-STS gate — surfaced only when `enforce` is published without the
 * record verified. A warning (not a hard block): the instance can still send;
 * the risk is on the INBOUND side, where senders honouring the policy may bounce
 * mail until the record + served policy are live.
 */
function mtaStsGate(): ReadinessGate {
	return {
		key: 'mta-sts',
		title: 'Inbound TLS policy (MTA-STS)',
		detail:
			'MTA-STS is set to enforce, but its DNS record isn’t in place yet — publish it so senders can require encrypted delivery.',
		status: 'attention',
		tone: 'warning',
		actionHref: DOMAINS_HREF,
		actionLabel: 'Publish record',
	};
}

const LEVEL_TONE: Record<ReadinessLevel, HealthTone> = {
	ready: 'success',
	incomplete: 'warning',
	blocked: 'error',
};

const LEVEL_HEADLINE: Record<ReadinessLevel, string> = {
	ready: 'Ready to send',
	incomplete: 'Ready to send — finish setup',
	blocked: 'Not ready to send',
};

/**
 * Derive the one combined readiness verdict.
 *
 * `canSend` is the honest gate — a transport AND a verified sending domain — so
 * the panel never claims "ready" while a real send would fail. Email
 * authentication is a deliverability gate, not a hard block: with a transport and
 * a verified domain the instance CAN send, but until SPF/DKIM/DMARC are in place
 * that mail is at risk, which is exactly the `incomplete` state.
 */
export function deriveDeliveryReadiness(input: ReadinessInput): DeliveryReadiness {
	const gates = [transportGate(input), domainGate(input), authenticationGate(input)];
	// The MTA-STS gate is conditional: only publishing `enforce` without the
	// record verified adds it, so a deployment that publishes nothing sees the
	// same three gates as before.
	if (input.mtaStsEnforceWithoutRecord) {
		gates.push(mtaStsGate());
	}

	const canSend = input.transportConfigured && input.domainVerified;

	let level: ReadinessLevel;
	if (!canSend) {
		level = 'blocked';
	} else if (!input.authComplete || input.mtaStsEnforceWithoutRecord) {
		// CAN send, but something deliverability-adjacent is unfinished — either
		// SPF/DKIM/DMARC or the enforced inbound MTA-STS record.
		level = 'incomplete';
	} else {
		level = 'ready';
	}

	// The summary names the single most important next step: the first gate that
	// isn't ready (transport → domain → authentication), or an all-clear line.
	const nextGate = gates.find((gate) => gate.status !== 'ready');
	const summary =
		level === 'ready'
			? 'Everything checks out — this instance can send.'
			: (nextGate?.detail ?? LEVEL_HEADLINE[level]);

	return {
		canSend,
		level,
		tone: LEVEL_TONE[level],
		headline: LEVEL_HEADLINE[level],
		summary,
		gates,
	};
}
