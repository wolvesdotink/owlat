/**
 * Spam-report batches (plan §7.2 step 3, §7.3).
 *
 * What reaches the log is never a report: it is a count plus a Merkle
 * commitment over the evidence-bundle hashes, in the observer's own report
 * order. On appeal or monitor challenge the challenger picks indices against
 * that fixed commitment and the observer opens exactly those bundles — to the
 * adjudicating monitors, never to the accused (§7.2.4). Keep the ordered hash
 * list this module returns: without it there is nothing to open (`challenge.ts`).
 *
 * A BATCH TRAVELS WITH ITS DENOMINATOR. Complaint rate is reports ÷ volume, so
 * an observer that publishes "40 reports about example.com" while quietly
 * omitting "…out of 900 000 messages" has manufactured a 100% complaint rate
 * for free. §7.3 answers it structurally: a `spam-report-batch` is admissible
 * only alongside the same observer's `traffic-summary` for the same subject and
 * the same window. {@link buildReportedWindow} is where that rule is enforced —
 * it takes both or it returns nothing, and it also refuses a batch claiming more
 * reports than the summary attests messages, which is the same lie told in one
 * document instead of two.
 *
 * THE EVIDENCE MUST NAME THE ACCUSED. Every committed bundle carries the `d=`
 * it was signed by; a batch about `a.example` whose bundles were signed by
 * `b.example` is a grouping bug that only surfaces at challenge time, as a
 * discarded batch plus an observer standing penalty (§7.2.4). It is five lines
 * to make impossible, so it is refused here instead.
 *
 * THE K-FLOOR HAS TWO HALVES. Enough reports AND enough distinct reporters
 * (§7.4): three reports from one mailbox tell the accused that one particular
 * person at this observer complained. Reporter tokens are opaque and salted,
 * exactly like recipient tokens, and — unlike the bundle hashes — never enter
 * the commitment; they are counted and discarded.
 */
import {
	commitToBundles,
	parseHash,
	type AttestationWindow,
	type SpamReportBatchBody,
	type SubjectRef,
	type TrafficSummaryBody,
} from '@owlat/ostr-core';
import { resolveKThresholds, type KThresholdOverrides } from './thresholds.js';
import { normalizeDomain, sameSubject, sameWindow, type AttestationDraft } from './types.js';

/** One report's evidence, as the batch builder needs it. */
export interface SpamReportEntry {
	/** Lowercase hex `bundleHash` from `buildEvidenceBundle`. */
	bundleHash: string;
	/** The bundle's `signingDomain` (`d=`) — what binds this evidence to the
	 *  accused. `buildEvidenceBundle` returns it on the bundle it hashed. */
	signingDomain?: string;
	/** Opaque, per-observer-stable token for the reporting mailbox — a salted
	 *  hash, never an address, and never published. */
	reporter?: string;
}

export interface SpamReportBatchInput {
	subject: SubjectRef;
	window: AttestationWindow;
	/** The window's reports, in report order. Order is part of the commitment:
	 *  an opening names an index in it. */
	bundles: readonly SpamReportEntry[];
}

export type SpamBatchRefusal =
	/** No evidence bundles: an empty batch commits to the empty-tree root, which
	 *  no opening can ever satisfy. */
	| 'no-bundles'
	/** A hash that is not a lowercase hex SHA-256 digest. */
	| 'invalid-bundle-hash'
	/** The same bundle committed twice — dedupe at capture missed a replay. */
	| 'duplicate-bundle-hash'
	/** A committed bundle was signed by a domain other than the subject. */
	| 'evidence-subject-mismatch'
	/** A report with no reporter token: the distinct-reporter floor cannot be
	 *  evaluated, and an unevaluable floor is not a floor. */
	| 'missing-reporter-token'
	/** The §7.3 rule: no traffic-summary for this window. */
	| 'missing-traffic-summary'
	/** The summary is about a different party. */
	| 'subject-mismatch'
	/** The summary covers a different window. */
	| 'window-mismatch'
	/** More reports than the observer's own attested volume for the subject. */
	| 'reports-exceed-attested-messages'
	/** Fewer reports than the k-threshold: held, not published (§7.4). */
	| 'below-report-threshold'
	/** Enough reports, too few distinct reporters: held (§7.4). */
	| 'below-reporter-threshold';

/** How far a held batch is from publishable — the batch-side counterpart of
 *  `HeldSubject.shortfall`, so an operator UI can say "two more reporters". */
export interface SpamBatchHold {
	reports: number;
	minReports: number;
	reporters: number;
	minReporters: number;
}

export type SpamReportBatchResult =
	| {
			ok: true;
			draft: AttestationDraft<SpamReportBatchBody>;
			commitmentHex: string;
			/** The committed list, in commitment order — RETAIN IT: challenge
			 *  openings are indices into exactly this list (§7.2.4). */
			bundleHashes: string[];
			/** Distinct reporter tokens behind the batch. Never published. */
			reporters: number;
	  }
	| { ok: false; reason: SpamBatchRefusal };

/**
 * Commit to a window's evidence bundles and draft the `spam-report-batch`.
 *
 * The draft is NOT publishable on its own — pass it through
 * {@link buildReportedWindow} with the matching traffic-summary. Nothing here
 * touches a bundle: the observer keeps those, and only their hashes are
 * committed.
 *
 * For a `{ domain }` subject every entry must name that domain. For an
 * `{ ip }` subject the signing domains are deliberately not checked: the
 * accused party is the connecting address, the bundles under it may legitimately
 * carry many `d=` values (or none that matches), and what binds them to the IP
 * is the observer's own connection record, not the signature.
 */
export function buildSpamReportBatch(input: SpamReportBatchInput): SpamReportBatchResult {
	const bundles = input.bundles;
	if (!Array.isArray(bundles) || bundles.length === 0) return { ok: false, reason: 'no-bundles' };
	const subjectDomain = normalizeDomain(input.subject?.domain);

	const leaves: Buffer[] = [];
	const bundleHashes: string[] = [];
	const seen = new Set<string>();
	const reporters = new Set<string>();
	for (const entry of bundles) {
		const hex = typeof entry?.bundleHash === 'string' ? entry.bundleHash : '';
		const hash = parseHash(hex);
		if (hash === undefined) return { ok: false, reason: 'invalid-bundle-hash' };
		if (seen.has(hex)) return { ok: false, reason: 'duplicate-bundle-hash' };
		if (subjectDomain !== undefined && normalizeDomain(entry.signingDomain) !== subjectDomain) {
			return { ok: false, reason: 'evidence-subject-mismatch' };
		}
		const reporter = entry.reporter;
		if (typeof reporter !== 'string' || reporter === '') {
			return { ok: false, reason: 'missing-reporter-token' };
		}
		reporters.add(reporter);
		seen.add(hex);
		bundleHashes.push(hex);
		leaves.push(hash);
	}

	const commitment = commitToBundles(leaves);
	return {
		ok: true,
		commitmentHex: commitment.rootHex,
		bundleHashes,
		reporters: reporters.size,
		draft: {
			kind: 'spam-report-batch',
			subject: input.subject,
			window: input.window,
			// One leaf per report: the batch size IS `reports`, which is what makes
			// challenge indices sampled from [0, reports) meaningful.
			body: { reports: commitment.treeSize, commitment: commitment.rootHex },
		},
	};
}

export interface ReportedWindowInput {
	/** The traffic-summary this observer emitted for the same subject and window
	 *  — the denominator. Absent or mismatched, the batch is refused. */
	summary: AttestationDraft<TrafficSummaryBody> | null | undefined;
	batch: SpamReportBatchInput;
	/** Operator overrides for the §7.4 floors. Raise-only: values below
	 *  {@link DEFAULT_K_THRESHOLDS} are clamped back up to it. */
	kThresholds?: KThresholdOverrides;
}

export type ReportedWindowResult =
	| {
			ok: true;
			/** Submit both, together. Order is significant only for readability. */
			drafts: [AttestationDraft<TrafficSummaryBody>, AttestationDraft<SpamReportBatchBody>];
			commitmentHex: string;
			/** The committed list, in commitment order — retain it for openings. */
			bundleHashes: string[];
	  }
	| { ok: false; reason: SpamBatchRefusal; held?: SpamBatchHold };

/**
 * The §7.3 pair builder: the only supported way to publish a spam-report batch.
 *
 * Returns the summary and the batch together or refuses the batch. A refusal is
 * not a reason to publish the summary alone — that is a legitimate, and
 * expected, thing to do, and the caller already holds it.
 *
 * `below-report-threshold` and `below-reporter-threshold` are HOLDS, not
 * errors: too few reports, or too few distinct reporters, to bucket safely means
 * the batch waits for a wider window (§7.4), exactly as a held traffic-summary
 * does — and `held` says by how much.
 */
export function buildReportedWindow(input: ReportedWindowInput): ReportedWindowResult {
	const summary = input.summary;
	if (summary === null || summary === undefined || summary.kind !== 'traffic-summary') {
		return { ok: false, reason: 'missing-traffic-summary' };
	}
	const { subject, window } = input.batch;
	if (!sameSubject(summary.subject, subject)) return { ok: false, reason: 'subject-mismatch' };
	if (summary.window === undefined || !sameWindow(summary.window, window)) {
		return { ok: false, reason: 'window-mismatch' };
	}

	const batch = buildSpamReportBatch(input.batch);
	if (!batch.ok) return batch;

	const thresholds = resolveKThresholds(input.kThresholds);
	const reports = batch.draft.body.reports;
	const held: SpamBatchHold = {
		reports,
		minReports: thresholds.minReports,
		reporters: batch.reporters,
		minReporters: thresholds.minReporters,
	};
	if (reports < thresholds.minReports) {
		return { ok: false, reason: 'below-report-threshold', held };
	}
	if (batch.reporters < thresholds.minReporters) {
		return { ok: false, reason: 'below-reporter-threshold', held };
	}
	if (reports > summary.body.messages) {
		return { ok: false, reason: 'reports-exceed-attested-messages' };
	}
	return {
		ok: true,
		drafts: [summary, batch.draft],
		commitmentHex: batch.commitmentHex,
		bundleHashes: batch.bundleHashes,
	};
}
