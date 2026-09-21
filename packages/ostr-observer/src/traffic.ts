/**
 * Windowed aggregation with the §7.4 k-anonymity floor.
 *
 * The accumulator eats one record per inbound message and emits, per subject,
 * the `traffic-summary` draft the registry scores volume and auth hygiene from.
 * It holds no message-level state and no recipient addresses: recipients are
 * counted through opaque tokens the app salts, and nothing that enters here can
 * be read back out of what leaves.
 *
 * THE WIDENING RULE. A subject whose window does not clear the k-thresholds is
 * never published — it is HELD, its counters stay in the accumulator, and the
 * next emit call folds it into a wider window ([earliest held start, latest
 * end]) until the thresholds are met. Publication is not delayed for tidiness:
 * an observer publishing "1 message from example.com, 1 recipient" IS the
 * single-user exposure the privacy floor exists to prevent.
 *
 * HELD IS NOT FOREVER. A held subject costs memory, costs bytes in the
 * persisted blob, and — because it holds salted recipient tokens — is retained
 * evidence, which §7.2 caps at ~90 days. One entry per connecting IP means a
 * botnet with a million source addresses would otherwise mint a million
 * permanent, unpublishable subjects. Two bounds answer that: a
 * {@link TrafficAccumulatorOptions.maxSubjects} cap that evicts the smallest
 * held subjects first, and {@link TrafficAccumulator.dropHeldBefore}, the
 * retention prune the app calls with `now - retention`.
 *
 * ATTRIBUTION NEEDS A VERIFIED SIGNATURE. `d=` is free to write, so a signing
 * domain is credited only when the signature actually verified (§7.1) — see
 * {@link MessageObservation.signingDomainVerified}. A forged `d=` lands under
 * the connecting IP, where it belongs, and nowhere else.
 *
 * THE SINGLE-MAILBOX CAVEAT (§7.4). Widening cannot save a one-mailbox
 * observer: the observer identity is the user identity, so any window it
 * publishes names that person as the recipient, no matter how wide. Feeding
 * recipient tokens makes that visible here — distinct recipients stays at 1
 * forever, so every subject is held forever — but the real gate is
 * `assertObserverEligible`, which hard-disables observer mode below the mailbox
 * threshold before a single observation is taken.
 */
import {
	compareRfc3339,
	isChronological,
	isRfc3339,
	type AttestationWindow,
	type SubjectRef,
	type TrafficSummaryBody,
} from '@owlat/ostr-core';
import { bounceRateBucket, logScaleBucket } from './buckets.js';
import { resolveKThresholds, type KThresholdOverrides } from './thresholds.js';
import {
	emptyTotals,
	restoreSubjects,
	type SubjectTotals,
	type SubjectTotalsState,
	type TrafficAccumulatorState,
} from './trafficState.js';
import { normalizeDomain, normalizeIp, subjectKey, type AttestationDraft } from './types.js';

/** One inbound message as the accumulator sees it. */
export interface MessageObservation {
	/** The DKIM `d=`, when the message carried a signature. Credited only if the
	 *  signature verified — see {@link signingDomainVerified}. */
	signingDomain?: string;
	/**
	 * Whether the signature over {@link signingDomain} actually VERIFIED.
	 *
	 * Defaults to {@link dkimPass} when omitted, which is right for a caller
	 * whose `dkimPass` means "this `d=` verified". Set it explicitly when the two
	 * differ: an app whose `dkimPass` means "DMARC-aligned DKIM" would otherwise
	 * throw away a perfectly good, verified, non-aligned `d=`.
	 */
	signingDomainVerified?: boolean;
	/** The connecting client's IP. */
	ip: string;
	spfPass: boolean;
	dkimPass: boolean;
	dmarcPass: boolean;
	/** Inbound connection used TLS. */
	tls: boolean;
	/** Envelope recipients this instance accepted for the message. */
	recipientCount: number;
	/** The message bounced (or was rejected after acceptance). */
	bounced: boolean;
	/**
	 * Opaque, per-observer-stable tokens for those recipients — salted hashes of
	 * the local mailbox identity, never addresses. Supply them whenever the store
	 * can: WITHOUT tokens the accumulator cannot tell 10 000 messages to one
	 * mailbox from 10 000 messages to 10 000 mailboxes, and the k-anonymity floor
	 * degrades from "enough distinct people" to a bare volume floor.
	 */
	recipients?: readonly string[];
}

/** A subject the thresholds refused to publish, with what it is still short. */
export interface HeldSubject {
	subject: SubjectRef;
	/** The window this subject is accumulating over — it grows every emit. */
	window: AttestationWindow;
	messages: number;
	uniqueRecipients: number;
	shortfall: { messages: number; recipients: number };
}

export interface TrafficEmission {
	emitted: AttestationDraft<TrafficSummaryBody>[];
	held: HeldSubject[];
}

export interface EmitTrafficInput {
	/** RFC 3339 UTC start of the window just closed. */
	windowFrom: string;
	/** RFC 3339 UTC end of it. */
	windowTo: string;
	/** Operator overrides for the §7.4 floors. Raise-only: values below
	 *  {@link DEFAULT_K_THRESHOLDS} are clamped back up to it. */
	kThresholds?: KThresholdOverrides;
}

export interface TrafficAccumulatorOptions {
	/**
	 * Most subjects to carry unpublished traffic for. Past it the smallest held
	 * subjects are evicted first: they are the furthest from ever clearing the
	 * k-floor, so they are the cheapest traffic to forget and the most likely to
	 * be flood noise in the first place.
	 */
	maxSubjects?: number;
}

/** Default held-subject cap. Comfortably above the distinct sending domains and
 *  peer IPs a real instance sees in a retention window, far below what a source
 *  address flood would mint. */
export const DEFAULT_MAX_HELD_SUBJECTS = 50_000;

/** Fraction of the cap left occupied after an eviction pass, so a flood pays
 *  one sort per 10% of the cap rather than one per message. */
const EVICTION_KEEP_RATIO = 0.9;

function resolveMaxSubjects(requested: number | undefined): number {
	return typeof requested === 'number' && Number.isSafeInteger(requested) && requested > 0
		? requested
		: DEFAULT_MAX_HELD_SUBJECTS;
}

/** A usable accepted-recipient count: a positive safe integer. Junk is counted
 *  under `unattributedRecipients` rather than silently folded to zero. */
function isRecipientCount(count: number | undefined): count is number {
	return typeof count === 'number' && Number.isSafeInteger(count) && count > 0;
}

/** Distinct recipients where tokens were supplied, the accepted-recipient sum
 *  otherwise (an upper bound: it cannot understate exposure). */
function uniqueRecipients(totals: SubjectTotals): number {
	return totals.recipientTokenSet === null ? totals.recipientTotal : totals.recipientTokenSet.size;
}

/**
 * Per-subject counters for one observation window.
 *
 * A message credits up to two subjects: the signing domain (when DKIM verified
 * one) and the connecting IP (always). They are scored as separate parties
 * (plan D2) and cross the k-threshold independently — a domain sending through
 * many IPs publishes while each individual IP may still be held.
 */
export class TrafficAccumulator {
	readonly #subjects = new Map<string, SubjectTotals>();
	readonly #maxSubjects: number;
	#dropped = 0;
	#unverifiedAttributions = 0;
	#unattributedRecipients = 0;
	#evicted = 0;

	constructor(options?: TrafficAccumulatorOptions) {
		this.#maxSubjects = resolveMaxSubjects(options?.maxSubjects);
	}

	/** Observations credited to no subject: neither a creditable signing domain
	 *  nor a parseable IP. Non-zero here means the caller is feeding junk. */
	get dropped(): number {
		return this.#dropped;
	}

	/** Signing domains refused because the signature did not verify — a forged
	 *  `d=` is the expected cause, and a caller whose `dkimPass` means something
	 *  narrower than "this signature verified" is the other. */
	get unverifiedAttributions(): number {
		return this.#unverifiedAttributions;
	}

	/** Observations whose `recipientCount` was not a usable count and therefore
	 *  contributed nothing to the recipient floor. */
	get unattributedRecipients(): number {
		return this.#unattributedRecipients;
	}

	/** Held subjects discarded to stay under {@link TrafficAccumulatorOptions.maxSubjects}. */
	get evicted(): number {
		return this.#evicted;
	}

	/** Subjects currently carrying unpublished traffic. */
	get size(): number {
		return this.#subjects.size;
	}

	observe(observation: MessageObservation): void {
		const domain = normalizeDomain(observation.signingDomain);
		const ip = normalizeIp(observation.ip);
		const verified = observation.signingDomainVerified ?? observation.dkimPass === true;
		if (domain !== undefined && !verified) this.#unverifiedAttributions++;
		const creditDomain = domain !== undefined && verified;
		if (!creditDomain && ip === undefined) {
			this.#dropped++;
			return;
		}
		if (!isRecipientCount(observation.recipientCount)) this.#unattributedRecipients++;
		if (creditDomain) this.#credit({ domain }, observation);
		if (ip !== undefined) this.#credit({ ip }, observation);
		if (this.#subjects.size > this.#maxSubjects) this.#evictSmallest();
	}

	#credit(subject: SubjectRef, observation: MessageObservation): void {
		const key = subjectKey(subject);
		let totals = this.#subjects.get(key);
		if (totals === undefined) {
			totals = emptyTotals(subject);
			this.#subjects.set(key, totals);
		}
		totals.messages++;
		if (observation.spfPass) totals.spfPass++;
		if (observation.dkimPass) totals.dkimPass++;
		if (observation.dmarcPass) totals.dmarcPass++;
		if (observation.tls) totals.tlsInbound++;
		if (observation.bounced) totals.bounced++;
		const count = observation.recipientCount;
		if (isRecipientCount(count)) totals.recipientTotal += count;
		const tokens = observation.recipients;
		if (tokens !== undefined) {
			totals.recipientTokenSet ??= new Set<string>();
			for (const token of tokens) {
				if (typeof token === 'string' && token.length > 0) totals.recipientTokenSet.add(token);
			}
		}
	}

	/** Drop the smallest held subjects down to 90% of the cap. Sorting by
	 *  message count keeps whatever is closest to publishable; ties fall back to
	 *  insertion order, so the oldest of two equal subjects goes first. */
	#evictSmallest(): void {
		const keep = Math.max(1, Math.floor(this.#maxSubjects * EVICTION_KEEP_RATIO));
		const ordered = [...this.#subjects.entries()].sort((a, b) => a[1].messages - b[1].messages);
		const excess = ordered.length - keep;
		for (let i = 0; i < excess; i++) {
			const entry = ordered[i];
			if (entry === undefined) break;
			this.#subjects.delete(entry[0]);
			this.#evicted++;
		}
	}

	/**
	 * Forget every subject whose held traffic starts strictly before `cutoff`,
	 * with its recipient tokens — the §7.2 retention prune, in the shape of
	 * `MemoryReportDedupeStore.prune`: the caller passes `now - retention`,
	 * because no clock lives in this package.
	 *
	 * Subjects that have never been through an emit carry no `heldFrom` and are
	 * left alone: they belong to the window still being filled.
	 *
	 * @throws RangeError if `cutoff` is not an RFC 3339 UTC timestamp.
	 */
	dropHeldBefore(cutoff: string): number {
		if (!isRfc3339(cutoff)) throw new RangeError('cutoff must be an RFC 3339 UTC timestamp');
		let removed = 0;
		for (const [key, totals] of this.#subjects) {
			if (totals.heldFrom === undefined) continue;
			if (compareRfc3339(totals.heldFrom, cutoff) < 0) {
				this.#subjects.delete(key);
				removed++;
			}
		}
		return removed;
	}

	/**
	 * Close a window: emit a draft per subject that clears the thresholds, hold
	 * the rest for a wider one.
	 *
	 * Emitted subjects are consumed — their counters reset, so a message is
	 * attested exactly once. Held subjects keep theirs and remember the earliest
	 * unpublished window start, which is the `from` their eventual draft carries.
	 *
	 * @throws RangeError if the window bounds are not chronological RFC 3339 UTC
	 * timestamps: an unorderable window would make every later widening wrong.
	 */
	emitTrafficSummaries(input: EmitTrafficInput): TrafficEmission {
		const { windowFrom, windowTo } = input;
		if (!isRfc3339(windowFrom) || !isRfc3339(windowTo) || !isChronological(windowFrom, windowTo)) {
			throw new RangeError('window must be [from, to] as chronological RFC 3339 UTC timestamps');
		}
		const thresholds = resolveKThresholds(input.kThresholds);
		const emitted: AttestationDraft<TrafficSummaryBody>[] = [];
		const held: HeldSubject[] = [];

		for (const key of [...this.#subjects.keys()].sort()) {
			const totals = this.#subjects.get(key) as SubjectTotals;
			const from =
				totals.heldFrom !== undefined && compareRfc3339(totals.heldFrom, windowFrom) < 0
					? totals.heldFrom
					: windowFrom;
			const window: AttestationWindow = { from, to: windowTo };
			const recipients = uniqueRecipients(totals);
			if (totals.messages < thresholds.minMessages || recipients < thresholds.minRecipients) {
				totals.heldFrom = from;
				held.push({
					subject: totals.subject,
					window,
					messages: totals.messages,
					uniqueRecipients: recipients,
					shortfall: {
						messages: Math.max(thresholds.minMessages - totals.messages, 0),
						recipients: Math.max(thresholds.minRecipients - recipients, 0),
					},
				});
				continue;
			}
			emitted.push({
				kind: 'traffic-summary',
				subject: totals.subject,
				window,
				body: {
					messages: totals.messages,
					spfPass: totals.spfPass,
					dkimPass: totals.dkimPass,
					dmarcPass: totals.dmarcPass,
					tlsInbound: totals.tlsInbound,
					uniqueRecipientsBucket: logScaleBucket(recipients),
					bounceRateBucket: bounceRateBucket(totals.bounced, totals.messages),
				},
			});
			this.#subjects.delete(key);
		}
		return { emitted, held };
	}

	/** Snapshot for durable storage: a held window can span days, and losing it
	 *  at restart would silently republish or silently drop traffic. */
	serialize(): TrafficAccumulatorState {
		const subjects: SubjectTotalsState[] = [];
		for (const key of [...this.#subjects.keys()].sort()) {
			const { recipientTokenSet, ...state } = this.#subjects.get(key) as SubjectTotals;
			subjects.push(
				recipientTokenSet === null ? state : { ...state, recipientTokens: [...recipientTokenSet] }
			);
		}
		return { v: 1, subjects };
	}

	/**
	 * Rehydrate persisted state, validating it first ({@link restoreSubjects}).
	 *
	 * @throws RangeError if the blob is not `v: 1` with a subject array.
	 */
	static restore(
		state: TrafficAccumulatorState,
		options?: TrafficAccumulatorOptions
	): TrafficAccumulator {
		const accumulator = new TrafficAccumulator(options);
		for (const [key, totals] of restoreSubjects(state)) accumulator.#subjects.set(key, totals);
		return accumulator;
	}
}

export type { SubjectTotalsState, TrafficAccumulatorState } from './trafficState.js';
