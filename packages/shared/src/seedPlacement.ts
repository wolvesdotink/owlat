/**
 * Seed mailbox placement — the PURE decision core (D15).
 *
 * A handful of operator-owned consumer mailboxes (Gmail, Outlook, Yahoo,
 * iCloud, plus regional providers) receive a SHADOW COPY of a send; an IMAP
 * poller later finds the probe and reports which folder it landed in. This
 * module owns every decision made from that observation: folder → placement
 * classification, the per-provider roll-up, the corroboration rule, gate 5's
 * verdict, and the probe-hygiene plan.
 *
 * D17 — A TRIPWIRE, NOT A GAUGE. Five to ten brand-new consumer mailboxes are
 * far too small a sample for a percentage anyone should quote, and fresh
 * consumer accounts with no engagement history are filtered more harshly than
 * real subscribers. Everything this module returns to a caller is therefore a
 * STATUS, never a rate: no field of any exported result type is a placement
 * percentage. Detecting a COLLAPSE (mostly-inbox → mostly-spam/missing) is the
 * correct use, and it is actionable at any sample size — but a provider-wide
 * collapse across ALL seeds is SUSPECT and may not act on its own: it requires
 * corroboration from the deferral or the bounce gate. Uncorroborated, it HOLDS
 * the gate (`insufficient_data`) rather than passing it — it may not pull the
 * share down, and it certainly may not help pull it up.
 *
 * GATE 5 IS TWO CLAUSES, per the plan's signal table: the own arm's reached
 * share must clear `SEED_REACHED_THRESHOLD` (90 %) AND, when a reference
 * transport carried probes of its own, sit within `SEED_REFERENCE_TOLERANCE`
 * (5 pp) of it. Standalone there is no reference arm, the second clause is
 * `no_reference_arm`, and the absolute clause is the whole gate (D3).
 *
 * D2 — ADDITIVE-ONLY. Zero seed mailboxes is a SUPPORTED CONFIGURATION. It
 * yields `insufficient_data` and nothing else: no error, no warning, no
 * "setup incomplete" nag, and no effect on any share or pace decision.
 *
 * No clock reads, no I/O: `now` and every input are parameters.
 */

import type { DestinationProviderKey } from './deliverabilityRouting';

// ============ PROBE IDENTITY ============

/**
 * The header the shadow copy carries so the IMAP poller can find it again.
 * Its value is an OPAQUE probe id — never a recipient address, a contact id,
 * a campaign name, or any other PII (the probe lands in an operator mailbox,
 * and the header must be safe if it is ever forwarded on).
 */
export const SEED_PROBE_HEADER = 'X-Owlat-Seed-Probe';

/**
 * `sp_` + 22 LOWERCASE HEX chars — exactly what `newProbeId`
 * (`delivery/seedShadowCopy.ts`) mints from a hyphen-stripped UUIDv4. The
 * accepted set is deliberately no wider than the minted set: `isSeedProbeId` is
 * load-bearing at two PUBLIC tracking endpoints, where "which ids do we treat
 * as a probe" must be an exact answer rather than a superset.
 */
const SEED_PROBE_ID_PATTERN = /^sp_[0-9a-f]{22}$/;

export function isSeedProbeId(value: string): boolean {
	return SEED_PROBE_ID_PATTERN.test(value);
}

/**
 * How many seed mailboxes one organization may connect.
 *
 * D17 sizes a seed set at 5-10 per provider, and EVERY send drops a full
 * shadow copy into EVERY seed — the cost of a seed is linear in send volume,
 * so an unbounded set is a self-inflicted volume problem, not a better
 * measurement. The limit is enforced at CONNECT time (`mail/externalAccountsSeed
 * .ts`) rather than by silently truncating the read page: dropping seeds
 * without a word would make the roll-up quietly ignore mailboxes the operator
 * believes are being measured.
 */
export const SEED_ACCOUNTS_PER_ORG_LIMIT = 50;

/**
 * One seed mailbox's outstanding probe work — the WIRE CONTRACT between the
 * Convex poller surface (`analytics/seedProbePoller.listSeedProbeWork`) and the
 * mail-sync worker that walks the mailbox. Declared here, once, because both
 * ends are separate deployables: two hand-kept copies of a wire shape drift.
 *
 * Carries no credential and nothing from inside a mailbox — an address the
 * worker must connect to, and opaque probe ids to look for.
 */
export interface SeedProbeWorkItem {
	organizationId: string;
	accountId: string;
	address: string;
	provider: DestinationProviderKey;
	/** Probes dispatched, settled, and still unclassified. */
	probeIds: string[];
	/** Probes past the give-up horizon — report MISSING without searching. */
	expiredProbeIds: string[];
	/** Advisory nudge; never a blocking warning (D2). */
	rotationReminderDue: boolean;
	/**
	 * The ONLY hosts the hygiene click may be issued against — this deployment's
	 * own tracking/site origins. The click target is chosen from links found
	 * inside a message sitting in a mailbox we do not control the server of, so
	 * the allowed set is supplied by the backend rather than inferred from the
	 * content. An empty list means "click nothing".
	 */
	clickHosts: string[];
}

/**
 * One PAGE of seed work. The sweep is cursored rather than a bounded top-N:
 * a fixed page with no cursor starves whichever organizations sort last on a
 * multi-org deployment, permanently and silently. The worker holds `cursor`
 * between ticks and starts over when the sweep reports `isDone`.
 */
export interface SeedProbeWorkPage {
	items: SeedProbeWorkItem[];
	cursor: string | null;
	isDone: boolean;
}

// ============ PLACEMENT CLASSIFICATION ============

// Folder naming is provider-specific and long enough to own a file; the
// classification core lives in the sibling and is re-exported here so
// `@owlat/shared/seedPlacement` stays the one import surface.
export {
	SEED_PLACEMENTS,
	classifySeedFolder,
	type SeedPlacement,
	type SeedFolderClassification,
} from './seedPlacementFolders';
import type { SeedPlacement } from './seedPlacementFolders';

// ============ ROLL-UP, CORROBORATION AND GATE 5 ============

// The roll-up, the corroboration rule and gate 5 are long enough to own a file;
// they live in the sibling and are re-exported here so
// `@owlat/shared/seedPlacement` stays the one import surface.
export {
	SEED_COLLAPSE_THRESHOLD,
	SEED_MIN_OBSERVATIONS,
	SEED_REACHED_THRESHOLD,
	SEED_REFERENCE_TOLERANCE,
	evaluateSeedPlacementGate,
	resolveSeedTripwire,
	summarizeSeedPlacement,
	summarizeSeedProvider,
	type SeedConfidence,
	type SeedCorroboration,
	type SeedGateResult,
	type SeedGateVerdict,
	type SeedObservation,
	type SeedPlacementStatus,
	type SeedProviderRollup,
	type SeedReferenceStatus,
	type SeedTransportArm,
	type SeedTripwireAction,
	type SeedTripwireResolution,
} from './seedPlacementGate';

// ============ PROBE HYGIENE (part of the feature, not a follow-up) ============

/** A seed that never opens anything trains the provider to distrust us. */
export const SEED_CLICK_PROBABILITY = 0.2;
/** Consumer mailboxes go stale; prompt the operator to rotate roughly quarterly. */
export const SEED_ROTATION_INTERVAL_MS = 90 * 24 * 60 * 60 * 1000;

export interface SeedHygienePlan {
	markRead: boolean;
	click: boolean;
}

/**
 * What the poller should do with a probe it just classified.
 *
 * `clickRoll` is a caller-supplied uniform [0,1) draw — randomness stays
 * outside the pure core so the plan is exhaustively testable.
 */
export function planSeedHygiene(input: {
	placement: SeedPlacement;
	alreadyMarkedRead: boolean;
	alreadyClicked: boolean;
	clickRoll: number;
}): SeedHygienePlan {
	// A probe that was never found cannot be opened or clicked.
	if (input.placement === 'missing') {
		return { markRead: false, click: false };
	}
	const markRead = !input.alreadyMarkedRead;
	const click = !input.alreadyClicked && input.clickRoll < SEED_CLICK_PROBABILITY;
	return { markRead, click };
}

export function shouldRemindSeedRotation(input: {
	connectedAt: number;
	lastRemindedAt?: number;
	now: number;
}): boolean {
	const since = input.lastRemindedAt ?? input.connectedAt;
	return input.now - since >= SEED_ROTATION_INTERVAL_MS;
}

// ============ SAFE LOGGING ============

/**
 * The ONLY shape a seed account may be logged in. Credentials live in the
 * shipped sealed envelope on `externalMailAccounts` and are never read here;
 * the seed ADDRESS is an operator mailbox but is still an email address, so it
 * is reduced to its provider + domain. Mailbox CONTENTS never appear at all.
 */
export interface SeedAccountLogView {
	accountId: string;
	provider: DestinationProviderKey;
	domain: string;
}

export function toSeedAccountLogView(input: {
	accountId: string;
	provider: DestinationProviderKey;
	address: string;
}): SeedAccountLogView {
	const at = input.address.lastIndexOf('@');
	return {
		accountId: input.accountId,
		provider: input.provider,
		domain: at === -1 ? '' : input.address.slice(at + 1).toLowerCase(),
	};
}
