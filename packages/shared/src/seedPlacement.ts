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
 * corroboration from the deferral or the bounce gate.
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

/** `sp_` + 22 base32-ish chars. Opaque, fixed width, no embedded meaning. */
const SEED_PROBE_ID_PATTERN = /^sp_[0-9a-z]{22}$/;

export function isSeedProbeId(value: string): boolean {
	return SEED_PROBE_ID_PATTERN.test(value);
}

// ============ PLACEMENT CLASSIFICATION ============

export const SEED_PLACEMENTS = ['inbox', 'category', 'spam', 'missing'] as const;
export type SeedPlacement = (typeof SEED_PLACEMENTS)[number];

export interface SeedFolderClassification {
	placement: SeedPlacement;
	/**
	 * Present only for `category`: the Gmail tab (Promotions, Updates, …) or,
	 * for any other provider, the non-inbox non-spam folder the probe was
	 * filtered into. Folder NAMES are metadata; mailbox CONTENTS are never
	 * carried by this module.
	 */
	categoryLabel?: string;
}

/** Spam/junk folder names across the providers an operator can realistically seed. */
const SPAM_FOLDER_NAMES = new Set([
	'spam',
	'junk',
	'junk e-mail',
	'junk email',
	'junkmail',
	'bulk',
	'bulk mail',
	'unwanted',
	'quarantine',
]);

/** Gmail tab labels, in the two shapes IMAP surfaces them. */
const GMAIL_CATEGORY_LABELS: Record<string, string> = {
	promotions: 'Promotions',
	updates: 'Updates',
	forums: 'Forums',
	social: 'Social',
	personal: 'Personal',
};

/**
 * Strip the provider-specific folder-hierarchy prefixes so `[Gmail]/Spam`,
 * `INBOX.Junk` and `Junk E-mail` all normalize to a comparable leaf name.
 */
function normalizeFolderName(folderName: string): string {
	let name = folderName.trim();
	// Gmail's IMAP namespace: "[Gmail]/Spam", "[Google Mail]/Spam".
	name = name.replace(/^\[(?:gmail|google mail)\]\//i, '');
	// Dovecot/Courier style INBOX-rooted hierarchies: "INBOX.Junk", "INBOX/Junk".
	name = name.replace(/^inbox[./]/i, '');
	// Gmail category LABELS arrive as "CATEGORY_PROMOTIONS".
	name = name.replace(/^category[_/]/i, '');
	return name.toLowerCase().replace(/[_-]+/g, ' ').trim();
}

/**
 * Classify one probe observation.
 *
 * `folderName` is `null`/`undefined` when the poller walked every folder of the
 * seed mailbox and did not find the probe at all — MISSING, the most alarming
 * outcome and the one no other signal in the system surfaces.
 *
 * An unrecognised, non-spam folder is reported as `category`: the message was
 * accepted but filtered away from the inbox, which is the same operational
 * meaning as a Gmail tab.
 */
export function classifySeedFolder(
	folderName: string | null | undefined,
	provider: DestinationProviderKey
): SeedFolderClassification {
	if (folderName === null || folderName === undefined || folderName.trim() === '') {
		return { placement: 'missing' };
	}

	const normalized = normalizeFolderName(folderName);
	if (normalized === '' || normalized === 'inbox') {
		return { placement: 'inbox' };
	}
	if (SPAM_FOLDER_NAMES.has(normalized)) {
		return { placement: 'spam' };
	}
	if (provider === 'gmail') {
		const label = GMAIL_CATEGORY_LABELS[normalized];
		if (label !== undefined) {
			return label === 'Personal'
				? { placement: 'inbox' }
				: { placement: 'category', categoryLabel: label };
		}
	}
	return { placement: 'category', categoryLabel: folderName.trim() };
}

// ============ ROLL-UP (STATUS, NEVER A NUMBER) ============

export interface SeedObservation {
	provider: DestinationProviderKey;
	placement: SeedPlacement;
}

/**
 * Below this many classified probes for a provider the roll-up refuses to
 * render a verdict at all (D10 — `insufficient_data` HOLDS; it never nudges a
 * decision in either direction).
 */
export const SEED_MIN_OBSERVATIONS = 3;

/** Share of probes that must reach the inbox or a tab for a provider to read healthy. */
const SEED_REACHED_THRESHOLD = 0.8;

export type SeedPlacementStatus =
	/** Fewer than SEED_MIN_OBSERVATIONS classified probes — no verdict. */
	| 'insufficient_data'
	/** Effectively everything reached the inbox or a tab. */
	| 'inbox_dominant'
	/** Some probes are being filtered to spam or vanishing. */
	| 'mixed'
	/** NOTHING reached the inbox: a provider-wide collapse. SUSPECT until corroborated. */
	| 'collapse_suspected';

/**
 * What a seed reading is worth. D14/D17 — say the quiet part out loud: seeds
 * are never high confidence, so the only values are `none` and `low`.
 */
export type SeedConfidence = 'none' | 'low';

/**
 * The per-provider roll-up. Deliberately carries NO rate, percentage, or
 * per-placement count: `sampleSize` is the number of MAILBOXES observed (the
 * honesty input for `insufficient_data`), not a placement measurement. The UI
 * and the controller both read `status`.
 */
export interface SeedProviderRollup {
	provider: DestinationProviderKey;
	status: SeedPlacementStatus;
	sampleSize: number;
	confidence: SeedConfidence;
	/** True when at least one probe could not be found in ANY folder. */
	anyMissing: boolean;
}

export function summarizeSeedProvider(
	provider: DestinationProviderKey,
	observations: readonly SeedObservation[]
): SeedProviderRollup {
	const mine = observations.filter((o) => o.provider === provider);
	const sampleSize = mine.length;
	const anyMissing = mine.some((o) => o.placement === 'missing');

	if (sampleSize < SEED_MIN_OBSERVATIONS) {
		return {
			provider,
			status: 'insufficient_data',
			sampleSize,
			confidence: 'none',
			anyMissing,
		};
	}

	const reached = mine.filter((o) => o.placement === 'inbox' || o.placement === 'category').length;
	const status: SeedPlacementStatus =
		reached === 0
			? 'collapse_suspected'
			: reached / sampleSize >= SEED_REACHED_THRESHOLD
				? 'inbox_dominant'
				: 'mixed';

	return { provider, status, sampleSize, confidence: 'low', anyMissing };
}

export function summarizeSeedPlacement(
	observations: readonly SeedObservation[]
): SeedProviderRollup[] {
	const providers = new Set<DestinationProviderKey>();
	for (const observation of observations) providers.add(observation.provider);
	return [...providers].map((provider) => summarizeSeedProvider(provider, observations));
}

// ============ THE CORROBORATION RULE (D17) ============

/**
 * The other two outcome gates' current readings. A seed collapse across eight
 * mailboxes is not, on its own, permitted to halve a healthy deployment's
 * share — a real placement collapse shows up in deferrals or bounces too.
 */
export interface SeedCorroboration {
	deferralGateBreached: boolean;
	bounceGateBreached: boolean;
}

export type SeedTripwireAction = 'hold' | 'act';

export interface SeedTripwireResolution {
	action: SeedTripwireAction;
	reason:
		| 'insufficient_seed_sample'
		| 'seeds_reaching_inbox'
		| 'seeds_mixed_no_collapse'
		| 'seed_collapse_awaiting_corroboration'
		| 'seed_collapse_corroborated';
}

export function resolveSeedTripwire(
	rollup: SeedProviderRollup,
	corroboration: SeedCorroboration
): SeedTripwireResolution {
	switch (rollup.status) {
		case 'insufficient_data':
			return { action: 'hold', reason: 'insufficient_seed_sample' };
		case 'inbox_dominant':
			return { action: 'hold', reason: 'seeds_reaching_inbox' };
		case 'mixed':
			return { action: 'hold', reason: 'seeds_mixed_no_collapse' };
		case 'collapse_suspected':
			return corroboration.deferralGateBreached || corroboration.bounceGateBreached
				? { action: 'act', reason: 'seed_collapse_corroborated' }
				: { action: 'hold', reason: 'seed_collapse_awaiting_corroboration' };
	}
}

// ============ GATE 5 ============

export type SeedGateVerdict = 'pass' | 'fail' | 'insufficient_data';

export interface SeedGateResult {
	verdict: SeedGateVerdict;
	reason: string;
	confidence: SeedConfidence;
	/** Providers whose collapse is corroborated — the human-readable "what broke". */
	failedProviders: DestinationProviderKey[];
	/** Providers sitting on an UNcorroborated collapse; surfaced, never acted on. */
	suspectProviders: DestinationProviderKey[];
}

/**
 * Gate 5 of the AIMD controller. With no seed mailboxes connected — the
 * default for a fresh install — this returns `insufficient_data` and the
 * controller HOLDS (D10): the gate can neither advance nor retreat the share.
 */
export function evaluateSeedPlacementGate(input: {
	rollups: readonly SeedProviderRollup[];
	corroboration: SeedCorroboration;
}): SeedGateResult {
	const usable = input.rollups.filter((r) => r.status !== 'insufficient_data');
	if (usable.length === 0) {
		return {
			verdict: 'insufficient_data',
			reason:
				input.rollups.length === 0 ? 'no_seed_mailboxes_connected' : 'insufficient_seed_sample',
			confidence: 'none',
			failedProviders: [],
			suspectProviders: [],
		};
	}

	const failedProviders: DestinationProviderKey[] = [];
	const suspectProviders: DestinationProviderKey[] = [];
	for (const rollup of usable) {
		const resolution = resolveSeedTripwire(rollup, input.corroboration);
		if (resolution.action === 'act') failedProviders.push(rollup.provider);
		else if (resolution.reason === 'seed_collapse_awaiting_corroboration') {
			suspectProviders.push(rollup.provider);
		}
	}

	if (failedProviders.length > 0) {
		return {
			verdict: 'fail',
			reason: `seed_collapse_corroborated:${failedProviders.join(',')}`,
			confidence: 'low',
			failedProviders,
			suspectProviders,
		};
	}

	return {
		verdict: 'pass',
		reason:
			suspectProviders.length > 0
				? `seed_collapse_awaiting_corroboration:${suspectProviders.join(',')}`
				: 'seeds_reaching_inbox',
		confidence: 'low',
		failedProviders: [],
		suspectProviders,
	};
}

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
