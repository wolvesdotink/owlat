/**
 * Open Sender Trust Registry — OBSERVER-side state (plan §7, ADR-0058).
 *
 * The consumer half of OSTR needs no storage at all: a tier rides in on the
 * webhook and lands in `mailMessages.ostrTier`. The observer half is the
 * opposite — it turns a user's "mark as spam" into a signed, permanently logged
 * attestation, and everything between those two events has to survive a
 * restart, a held window, and a challenge months later. That is what these
 * tables are.
 *
 * They exist ONLY under observer mode (`OSTR_OBSERVER_ENABLED`), which ships
 * off and is hard-disabled below the §7.4 mailbox floor. On the default
 * deployment every table here stays empty forever.
 *
 * THE PRIVACY LINE RUNS THROUGH THIS FILE. `ostrEvidence` holds the DKIM
 * evidence bundle: the `h=`-signed headers VERBATIM, which in practice means
 * Subject and To. That is precisely the data the public record may never carry,
 * and the plan's answer is not redaction (redacting a signed header makes the
 * signature unverifiable) but custody: the bundle never leaves this deployment,
 * only its hash is committed, and it is deleted after ~90 days
 * (`ostr/retention.ts`). `ostrReportQueue` carries the same rule one step
 * further — the reporting mailbox appears only as a salted, per-instance token,
 * never as a user id, because the queue feeds an attestation path and a raw
 * user id must not be one keying mistake away from a public log.
 *
 * Retention (§7.2) is therefore a correctness property, not housekeeping: a
 * report may not be re-admitted once its bundle is gone, so `ostrReportQueue`
 * rows outlive their emission (they ARE the dedupe memory) and both tables are
 * pruned on the same cutoff.
 */

import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { ostrDkimEvidenceValidator } from '../ostr/signals';

export const ostrTables = {
	/**
	 * Per-message DKIM evidence, exactly as the MTA captured it at verification
	 * time (`mailboxPayload.ostrDkimEvidence`).
	 *
	 * Captured at DELIVERY rather than at report time by necessity:
	 * `dnsKeyRecordTxt` and `verifiedAt` cannot be reconstructed from the stored
	 * `.eml` once the sender rotates its key, and the whole point of §7.5 is
	 * that evidence stays adjudicable after the key has left DNS. A message
	 * delivered before observer mode was switched on simply has no row, and no
	 * report about it is admissible — an accepted cost, not a bug.
	 *
	 * The bundle is NOT built here. `@owlat/ostr-observer`'s
	 * `buildEvidenceBundle` (and, under it, `@owlat/ostr-core`'s admissibility
	 * rules) decides whether these bytes are evidence at all, and it runs on the
	 * report path so an inadmissible signature costs a report, never a delivery.
	 *
	 * THE ROW DELIBERATELY OUTLIVES ITS MESSAGE. There is no cascade on message
	 * deletion, so `messageId` may dangle after a user deletes the mail: once a
	 * bundle's hash has been committed into a published batch, deleting the
	 * bundle makes that batch unanswerable at challenge time (§7.2.4), which
	 * costs this observer's standing and discards evidence other people relied
	 * on. The row is bounded anyway — the retention prune takes it on the ~90-day
	 * cutoff whatever happened to the message, and the org wipe takes it
	 * immediately (`lib/tenantTables.ts`), which are the two deletions that
	 * actually have to be honoured.
	 */
	ostrEvidence: defineTable({
		messageId: v.id('mailMessages'),
		/** The mailbox the message was delivered to — the retention cascade's
		 *  handle, and the mailbox whose salted token reports it. */
		mailboxId: v.id('mailboxes'),
		/** The wire contract from `ostr/signals.ts`, stored whole. Narrowed for
		 *  shape at the webhook boundary; admissibility is judged later. */
		evidence: ostrDkimEvidenceValidator,
		createdAt: v.number(),
	})
		.index('by_message', ['messageId'])
		.index('by_created_at', ['createdAt']),

	/**
	 * Captured spam reports awaiting a publishable window.
	 *
	 * A row is written when a user junks a message whose evidence cleared
	 * admissibility. It is NOT deleted when the batch is published — it is
	 * stamped `emittedAt` and kept, because the row is also the durable
	 * `ReportDedupeStore`: a DKIM signature is replayable, and the same
	 * (Message-ID, `bh=`) pair must stay "seen" for exactly as long as its
	 * bundle exists (§7.3). The retention prune deletes both together.
	 *
	 * Rows with `emittedAt` unset are the k-floor's hold-back queue: a subject
	 * short of the report or distinct-reporter threshold keeps its rows pending
	 * and is folded into a wider window next time (§7.4).
	 */
	ostrReportQueue: defineTable({
		/** The accused — the bundle's `d=`, folded. v1 batches domain subjects
		 *  only; an IP subject needs the connection record, which lives on the
		 *  MTA side of the wire, not here. */
		subjectDomain: v.string(),
		/** The message this report is about — the link an opening walks:
		 *  `ostrBatchCommitments.bundleHashes[i]` → this row (`by_bundle_hash`) →
		 *  `ostrEvidence` (`by_message`). Without it, answering a challenge would
		 *  mean re-hashing every retained bundle to find one leaf. Optional
		 *  because the row outlives the message (see `ostrEvidence`), and a
		 *  dangling id is a lookup that finds nothing rather than a broken row. */
		messageId: v.optional(v.id('mailMessages')),
		/** Lowercase hex SHA-256 of the JCS-canonical evidence bundle — the
		 *  Merkle leaf. The bundle itself is in `ostrEvidence`. */
		bundleHash: v.string(),
		/**
		 * Opaque, per-instance-stable token for the REPORTING mailbox: an HMAC
		 * under `INSTANCE_SECRET`, never a user id and never an address. The
		 * batch builder counts distinct tokens to enforce the second half of the
		 * k-floor and then discards them; nothing derived from this field ever
		 * reaches an attestation body.
		 */
		reporterToken: v.string(),
		/** `reportDedupeKey(messageId, bodyHash)` — a digest, so this table is
		 *  not a searchable index of anyone's mail. */
		dedupeKey: v.string(),
		/**
		 * RFC 3339 capture instant, the form the observer package's dedupe store
		 * retains by, and the ONLY record of how far back a held batch reaches:
		 * a report held across several windows is published beside the window it
		 * was published in, so this is what says when it was actually taken.
		 * `createdAt` is the same moment in epoch millis, for the prune's index.
		 */
		capturedAt: v.string(),
		/** Set once the report has been committed into a published batch. Unset
		 *  ⇒ still held (§7.4). */
		emittedAt: v.optional(v.number()),
		/** The batch this report was committed into. Set with `emittedAt`, and
		 *  the reverse of `ostrBatchCommitments.bundleHashes`. */
		batchId: v.optional(v.id('ostrBatchCommitments')),
		createdAt: v.number(),
	})
		.index('by_dedupe_key', ['dedupeKey'])
		.index('by_emitted_and_subject', ['emittedAt', 'subjectDomain'])
		.index('by_bundle_hash', ['bundleHash'])
		.index('by_created_at', ['createdAt']),

	/**
	 * What each PUBLISHED `spam-report-batch` committed to (§7.2.4).
	 *
	 * A batch on the wire is a count and a Merkle root. It becomes evidence only
	 * if the observer can OPEN it: a monitor samples indices and gets back the
	 * bundle at each position plus its inclusion proof. A root cannot be
	 * re-derived from a set, and a list in a different order produces proofs
	 * that fail against the published root — so the ORDERED hash list is
	 * published-side state, kept here, and it is unrecoverable if it is not
	 * written down at publication time. An unanswerable batch is a discarded
	 * batch plus an observer standing penalty, on the record.
	 *
	 * Retention couples this to the bundles: openings need `ostrEvidence`, so the
	 * same ~90-day cutoff prunes both, and the plan's challenge deadline (T ≈ 14
	 * days, §7.6) sits well inside it.
	 *
	 * The endpoint that SERVES an opening is not built yet — `answerChallenge`
	 * in `@owlat/ostr-observer` is ready for it and this table is its input. The
	 * data is retained now because it cannot be reconstructed later.
	 */
	ostrBatchCommitments: defineTable({
		/** The subject the batch accused, as published. */
		subjectDomain: v.string(),
		/** The window the batch and its traffic-summary both carry (§7.3). */
		windowFrom: v.string(),
		windowTo: v.string(),
		/** The published `body.commitment` — the Merkle root over the hashes
		 *  below, in exactly this order. */
		commitmentHex: v.string(),
		/** The committed bundle hashes, in commitment order. An opening names an
		 *  index into this array. */
		bundleHashes: v.array(v.string()),
		createdAt: v.number(),
	})
		.index('by_subject_and_window', ['subjectDomain', 'windowFrom', 'windowTo'])
		.index('by_created_at', ['createdAt']),

	/**
	 * `KeyObservationStore` (§7.5): what this observer has seen of each
	 * (domain, selector, key), and which window it last published about.
	 *
	 * Keys leave DNS; some senders publish retired private keys on purpose to
	 * make old signatures deniable. Both are legitimate and both destroy
	 * challenge-time verification against live DNS, so the key as seen is
	 * logged once and adjudication happens against the log.
	 */
	ostrKeyObservations: defineTable({
		domain: v.string(),
		selector: v.string(),
		/** `sha256:<hex>` comparable identity from `normalizeObservedKey` — two
		 *  observers that saw one key agree on it whichever spelling they hold. */
		keyId: v.string(),
		/** The spelling published in the body: base64 SPKI DER when the record
		 *  gave one (a digest cannot re-verify a signature), the digest else. */
		publicKey: v.string(),
		firstSeen: v.string(),
		lastSeen: v.string(),
		/** Sticky: the claim is that the chain validated at SOME point inside
		 *  [firstSeen, lastSeen], which is what matters at challenge time. */
		isDnssecValidated: v.boolean(),
		/** `window.to` of the last window an attestation was emitted for — the
		 *  rate limit that keeps a public log from carrying a per-message
		 *  record. */
		lastEmittedWindowTo: v.optional(v.string()),
		updatedAt: v.number(),
	}).index('by_key', ['domain', 'selector', 'keyId']),

	/**
	 * Cross-submission ledger (§9.1): one row per signed attestation, carrying
	 * which logs took it and which still owe an acceptance.
	 *
	 * Attestations go to at least two logs so one operator's outage — or one
	 * operator's misbehaviour — loses nothing. A single-log failure is expected
	 * traffic, so it is recorded rather than thrown: the next window re-posts
	 * `pendingLogUrls` before it builds anything new.
	 */
	ostrSubmissionLog: defineTable({
		/** The attestation's `kind`, denormalized for operator-visible reads. */
		kind: v.string(),
		/** The subject as published (`domain` or `ip`) — public information by
		 *  construction; the body carries it too. */
		subject: v.string(),
		windowFrom: v.optional(v.string()),
		windowTo: v.optional(v.string()),
		/**
		 * The signed attestation, JSON. Kept verbatim because a retry must post
		 * the SAME bytes: the signature covers the canonical form, and
		 * re-deriving the document from consumed accumulator state is not
		 * possible. Versioned per the schema-evolution rule — see
		 * `CURRENT_OSTR_ATTESTATION_BLOB_VERSION` in `lib/constants.ts`.
		 */
		attestationJson: v.string(),
		attestationJsonVersion: v.optional(v.number()),
		acceptedLogUrls: v.array(v.string()),
		/** Logs that have not accepted it yet. Empty ⇒ `isSettled`. */
		pendingLogUrls: v.array(v.string()),
		/** Last transport/rejection message, clamped. Diagnostics only. */
		lastError: v.optional(v.string()),
		attempts: v.number(),
		/**
		 * Set when a row was settled by GIVING UP rather than by acceptance —
		 * `OSTR_MAX_SUBMISSION_ATTEMPTS` reached with logs still owing. Without a
		 * cap a permanently bad `OSTR_LOG_URLS` entry (a typo, a decommissioned
		 * log) grows this table forever while the same oldest rows are retried
		 * and everything behind them starves. An abandoned row keeps its
		 * `pendingLogUrls` and `lastError` — it is the operator-visible record of
		 * what this observer said it published and where it never arrived — and
		 * then ages out with the rest.
		 */
		isAbandoned: v.optional(v.boolean()),
		isSettled: v.boolean(),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index('by_settled_and_created', ['isSettled', 'createdAt'])
		.index('by_created_at', ['createdAt']),

	/**
	 * The observer's singleton run state: the serialized `TrafficAccumulator`
	 * and the watermark of the last closed window.
	 *
	 * A held subject can span days, and the accumulator is the only thing that
	 * knows which traffic has already been attested. Losing it would silently
	 * republish or silently drop traffic, so the package hands out a
	 * `serialize()`/`restore()` pair and this row is where it lives.
	 */
	ostrObserverState: defineTable({
		/** `TrafficAccumulatorState` as JSON — see
		 *  `CURRENT_OSTR_ACCUMULATOR_STATE_VERSION` in `lib/constants.ts`. */
		accumulatorState: v.string(),
		accumulatorStateVersion: v.optional(v.number()),
		/** RFC 3339 end of the last window this observer closed. Unset ⇒ the
		 *  first window starts one window-length ago. */
		lastWindowTo: v.optional(v.string()),
		/**
		 * RFC 3339 start of the earliest window whose traffic has been counted but
		 * never offered for publication — set while the instance has no signing
		 * identity, cleared the first time a window is actually emitted.
		 *
		 * The accumulator's own `heldFrom` only widens windows it has already
		 * refused to publish. A pass that never calls `emitTrafficSummaries` (no
		 * key configured) leaves no such mark, so without this the first published
		 * summary after the key is fixed would claim a week of traffic inside one
		 * hour — an overstated rate in a signed document.
		 */
		unpublishedFrom: v.optional(v.string()),
		updatedAt: v.number(),
	}),
};
