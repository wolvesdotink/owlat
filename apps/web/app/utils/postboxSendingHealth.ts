/**
 * The personal sending-health verdict (plan idea 12).
 *
 * Readiness panels, the deliverability dashboard and Postmaster data all live
 * behind the admin hub. A regular member whose mail quietly lands in spam — or
 * bounces outright — has no signal at all. This module derives the small card
 * that gives them one, from three facts they are already allowed to see:
 *
 *  - is MY sending domain verified,
 *  - is the active transport aligned for MY From address,
 *  - how many of MY recent sends failed, and what the newest failure said.
 *
 * MEMBER-SCOPED BY CONSTRUCTION, and that is why this does not simply call
 * `deriveDeliveryReadiness`. That verdict answers "can this INSTANCE send?" from
 * the org-wide transport summary and domain table, and every gate it produces
 * links to `/dashboard/admin/delivery/*` — pages a member cannot open, offering
 * fixes a member cannot apply. The card here asks the member's own question
 * instead, off `mail.identities.listSendAsIdentities` (their address) and
 * `mail.mailbox.sendingHealth` (their sent folder). It reuses that
 * module's vocabulary — `ReadinessLevel`, `ReadinessGateStatus`, `HealthTone`,
 * `LocalizedText` — and the `senderAuthDisplay` registry's copy, so the two
 * surfaces stay recognisably one system, and it deliberately carries NO action
 * link: a member's next step is a sentence, not a route they'd be bounced from.
 *
 * Pure and DOM-free; every line is a catalog key resolved at the render
 * boundary.
 */

import type { OutboundAlignmentState } from '@owlat/shared';
import type { HealthTone } from '~/utils/healthTone';
import type { ReadinessLevel } from '~/utils/deliveryReadiness';
import type { LocalizedText, ReadinessGateStatus } from '~/utils/readinessGate';
import { senderAuthDisplay } from '~/utils/senderAlignment';
import { explainBounce } from '~/utils/postboxBounceCatalog';

/** The member's own From identity, as `listSendAsIdentities` annotates it. */
export interface SendingHealthIdentity {
	address: string;
	domainVerified: boolean;
	alignment: OutboundAlignmentState;
	alignmentReason?: string | null;
}

/** The bounce half — `mail.mailbox.sendingHealth.getSendingHealth`, verbatim. */
export interface SendingHealthStats {
	sends: number;
	attempts: number;
	accepted: number;
	bounced: number;
	failed: number;
	pending: number;
	latestFailure: {
		address: string;
		state: 'bounced' | 'failed';
		at: number;
		bounceMessage?: string;
		errorCode?: string;
	} | null;
}

export interface SendingHealthInput {
	/** Null while the identity query is still in flight, or when there is none. */
	identity: SendingHealthIdentity | null;
	/** Null while the stats query is still in flight. */
	stats: SendingHealthStats | null;
}

export type SendingHealthGateKey = 'domain' | 'alignment' | 'bounces';

export interface SendingHealthGate {
	key: SendingHealthGateKey;
	title: LocalizedText;
	detail: LocalizedText;
	status: ReadinessGateStatus;
	tone: HealthTone;
}

export interface SendingHealth {
	level: ReadinessLevel;
	tone: HealthTone;
	headline: LocalizedText;
	/** The single next thing to do, or an all-clear line. */
	nextStep: LocalizedText;
	gates: SendingHealthGate[];
	/**
	 * Failures over attempts in the recent window, or null when there is not
	 * enough evidence to put a number on it. Never a percentage over three sends:
	 * "33% of your mail bounces" off one bad address is a scare, not a signal.
	 */
	ratio: { failures: number; attempts: number } | null;
}

const KEY = 'shared.postboxSendingHealth';

/**
 * Below this many attempts a ratio says nothing, so the card reports the raw
 * counts and skips the percentage entirely.
 */
const MIN_ATTEMPTS_FOR_RATIO = 10;

/** Above this share of failures the bounce gate goes red rather than amber. */
const SERIOUS_FAILURE_SHARE = 0.2;

const LEVEL_TONE: Record<ReadinessLevel, HealthTone> = {
	ready: 'success',
	incomplete: 'warning',
	blocked: 'error',
};

const LEVEL_HEADLINE: Record<ReadinessLevel, LocalizedText> = {
	ready: `${KEY}.headline.ready`,
	incomplete: `${KEY}.headline.incomplete`,
	blocked: `${KEY}.headline.blocked`,
};

/**
 * "Is the address I send from verified?" — the same fact, and the same words,
 * the composer's From-picker chip already shows, taken from the shared
 * `senderAuthDisplay` registry so the card and the picker can never disagree
 * about whether sending from this address is off.
 */
function domainGate(identity: SendingHealthIdentity | null): SendingHealthGate {
	if (!identity) {
		return {
			key: 'domain',
			title: `${KEY}.gates.domain.title`,
			detail: `${KEY}.gates.domain.unknown`,
			status: 'pending',
			tone: 'neutral',
		};
	}
	if (identity.domainVerified) {
		return {
			key: 'domain',
			title: `${KEY}.gates.domain.title`,
			detail: { key: `${KEY}.gates.domain.verified`, params: { address: identity.address } },
			status: 'ready',
			tone: 'success',
		};
	}
	const display = senderAuthDisplay({ verified: false, alignment: identity.alignment });
	return {
		key: 'domain',
		title: `${KEY}.gates.domain.title`,
		detail: display.detail ?? `${KEY}.gates.domain.unknown`,
		status: 'attention',
		tone: 'error',
	};
}

/**
 * "Does the transport sign and bounce my mail as MY domain?" — a misalignment is
 * the quiet spam-folder cause a member would otherwise never see. An `unknown`
 * alignment stays a caution and never an accusation: nothing was verified to
 * fail, so nothing is claimed to have failed.
 */
function alignmentGate(identity: SendingHealthIdentity | null): SendingHealthGate {
	if (!identity || !identity.domainVerified) {
		// Nothing to align until the domain itself is settled — staying `pending`
		// keeps a half-finished setup from reading as two separate breakages.
		return {
			key: 'alignment',
			title: `${KEY}.gates.alignment.title`,
			detail: `${KEY}.gates.alignment.awaitingDomain`,
			status: 'pending',
			tone: 'neutral',
		};
	}
	const display = senderAuthDisplay({
		verified: true,
		alignment: identity.alignment,
		reason: identity.alignmentReason,
	});
	if (identity.alignment === 'aligned') {
		return {
			key: 'alignment',
			title: `${KEY}.gates.alignment.title`,
			detail: `${KEY}.gates.alignment.aligned`,
			status: 'ready',
			tone: 'success',
		};
	}
	return {
		key: 'alignment',
		title: `${KEY}.gates.alignment.title`,
		detail: display.detail ?? `${KEY}.gates.alignment.aligned`,
		status: identity.alignment === 'misaligned' ? 'attention' : 'pending',
		tone: display.tone,
	};
}

/** Failures over attempts in the recent window. */
function failureCount(stats: SendingHealthStats): number {
	return stats.bounced + stats.failed;
}

/**
 * "How much of my recent mail actually landed?" — counts, then a share only once
 * there are enough attempts for a share to mean anything.
 */
function bouncesGate(stats: SendingHealthStats | null): SendingHealthGate {
	if (!stats) {
		return {
			key: 'bounces',
			title: `${KEY}.gates.bounces.title`,
			detail: `${KEY}.gates.bounces.unknown`,
			status: 'pending',
			tone: 'neutral',
		};
	}
	if (stats.attempts === 0) {
		// A mailbox that has not sent anything is not unhealthy, it is untested.
		return {
			key: 'bounces',
			title: `${KEY}.gates.bounces.title`,
			detail: `${KEY}.gates.bounces.nothingSent`,
			status: 'pending',
			tone: 'neutral',
		};
	}
	const failures = failureCount(stats);
	if (failures === 0) {
		return {
			key: 'bounces',
			title: `${KEY}.gates.bounces.title`,
			detail: { key: `${KEY}.gates.bounces.allAccepted`, params: { sends: stats.sends } },
			status: 'ready',
			tone: 'success',
		};
	}
	const isSerious =
		stats.attempts >= MIN_ATTEMPTS_FOR_RATIO && failures / stats.attempts >= SERIOUS_FAILURE_SHARE;
	return {
		key: 'bounces',
		title: `${KEY}.gates.bounces.title`,
		detail: {
			key: `${KEY}.gates.bounces.someFailed`,
			params: { failures, attempts: stats.attempts },
		},
		status: 'attention',
		tone: isSerious ? 'error' : 'warning',
	};
}

/**
 * The single next thing to do.
 *
 * Ordered by how much it costs the user to be wrong about it: an unverified
 * domain means sending is genuinely off, a misalignment means the mail is going
 * to spam, and only then does the newest concrete failure get the floor — where
 * the bounce catalog's own next action is a far better instruction than "you
 * have bounces" ever is.
 */
function nextStep(
	identity: SendingHealthIdentity | null,
	stats: SendingHealthStats | null,
	gates: SendingHealthGate[]
): LocalizedText {
	const gate = (key: SendingHealthGateKey) => gates.find((g) => g.key === key);
	if (identity && !identity.domainVerified) return gate('domain')!.detail;
	if (identity?.alignment === 'misaligned') return gate('alignment')!.detail;
	const failure = stats?.latestFailure;
	if (failure) {
		const explanation = explainBounce({
			bounceMessage: failure.bounceMessage,
			errorCode: failure.errorCode,
		});
		return explanation.action ?? explanation.summary;
	}
	const unresolved = gates.find((gate) => gate.status !== 'ready');
	return unresolved ? unresolved.detail : `${KEY}.nextStep.allClear`;
}

/** Derive the card's one verdict. */
export function deriveSendingHealth(input: SendingHealthInput): SendingHealth {
	const { identity, stats } = input;
	const gates = [domainGate(identity), alignmentGate(identity), bouncesGate(stats)];
	const failures = stats ? failureCount(stats) : 0;

	let level: ReadinessLevel;
	if (identity && !identity.domainVerified) {
		// Sending from this address is genuinely off — not a deliverability risk,
		// a hard stop.
		level = 'blocked';
	} else if (!identity || identity.alignment !== 'aligned' || failures > 0) {
		// Misaligned, unverifiable, or something really did fail. An `unknown`
		// alignment counts: we could not confirm this transport signs as the
		// member's domain, and claiming "all good" off an unconfirmed check is the
		// one thing this card must never do.
		level = 'incomplete';
	} else {
		// Verified, aligned, nothing failed. A mailbox that has simply not sent
		// anything yet lands HERE rather than in `incomplete`: untested is not
		// unhealthy, and greeting a new member with a warning would be a lie.
		level = 'ready';
	}

	return {
		level,
		tone: LEVEL_TONE[level],
		headline: LEVEL_HEADLINE[level],
		nextStep: nextStep(identity, stats, gates),
		gates,
		ratio:
			stats && stats.attempts >= MIN_ATTEMPTS_FOR_RATIO
				? { failures, attempts: stats.attempts }
				: null,
	};
}
