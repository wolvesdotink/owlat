'use node';

/**
 * The junk action's observer half (plan §7.2, §12.2).
 *
 * The reporting flow is unchanged for the user: they hit "Report spam", the
 * message moves to Spam, the verdict is stamped. Behind it, when — and only
 * when — the operator has enabled observer mode AND the instance clears the
 * §7.4 mailbox floor, the report becomes a queued commitment to the DKIM
 * evidence captured at delivery.
 *
 * Every gate that could stop this is checked HERE rather than at the call site,
 * and each one is a plain return rather than a throw: a user junking a message
 * must never see an error because their operator's registry key is missing, and
 * `moveToRoleWithVerdict` must never be able to fail because of it either. The
 * mutation schedules this and forgets it.
 *
 * ONE ACTION PER JUNK, not per message. Selecting two hundred messages and
 * hitting "Report spam" is one decision by one person; the eligibility read
 * behind it is the same answer two hundred times, so it is taken once here and
 * the batch is walked inside.
 *
 * Nothing in here decides what evidence IS. `buildEvidenceBundle` (and
 * `@owlat/ostr-core`'s admissibility rules under it) makes that call, and an
 * inadmissible signature costs a report, never the delivery it was about.
 */

import { v } from 'convex/values';
import {
	assertObserverEligible,
	buildEvidenceBundle,
	OBSERVER_MIN_MAILBOXES,
	reportDedupeKey,
	shouldCaptureReport,
} from '@owlat/ostr-observer';
import { internalAction, type ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { logInfo } from '../lib/runtimeLog';
import { readObserverConfig } from './config';
import {
	mailboxToken,
	narrowDkimVerdict,
	QueuedReportDedupeStore,
	readTokenSalt,
	toRfc3339,
} from './observerRuntime';

/**
 * Why a report did not become a commitment. Every value is an ordinary outcome
 * an operator may want to see, not an error: `disabled` and
 * `below-mailbox-threshold` are the shipped defaults, `no-evidence` is every
 * message delivered before observer mode was switched on or without a
 * signature, and `duplicate` is the replay defence doing its job (§7.3).
 */
export type ReportCaptureOutcome =
	| { captured: true; subjectDomain: string }
	| { captured: false; reason: string };

/** One junked message and the mailbox it was junked from. */
const reportArgValidator = v.object({
	messageId: v.id('mailMessages'),
	/** The mailbox the report was made from. Hashed before anything is
	 *  written — no raw id reaches the queue, let alone an attestation. */
	mailboxId: v.id('mailboxes'),
});

export const captureSpamReports = internalAction({
	args: { reports: v.array(reportArgValidator) },
	handler: async (ctx, args): Promise<ReportCaptureOutcome[]> => {
		if (args.reports.length === 0) return [];
		const config = readObserverConfig();

		// §7.4 first, before anything is read: for a small instance the observer
		// identity IS the user identity, and no later step can undo publishing
		// that. `assertObserverEligible` clamps `OSTR_MIN_MAILBOXES` up to the
		// packaged floor, so an operator can raise this bar and never lower it —
		// which is also why the count only has to be taken as far as the floor.
		const limit = Math.max(config.minMailboxes ?? 0, OBSERVER_MIN_MAILBOXES);
		const mailboxCount = await ctx.runQuery(internal.ostr.store.countObservedMailboxes, {
			limit,
		});
		const eligibility = assertObserverEligible({
			enabled: config.isEnabled,
			mailboxCount,
			minMailboxes: config.minMailboxes,
		});
		if (!eligibility.eligible) {
			return args.reports.map(() => ({ captured: false, reason: eligibility.reason }));
		}

		const salt = readTokenSalt();
		if (salt === undefined) {
			return args.reports.map(() => ({ captured: false, reason: 'missing-token-salt' }));
		}

		const outcomes: ReportCaptureOutcome[] = [];
		for (const report of args.reports) {
			outcomes.push(await captureOne(ctx, salt, report.messageId, report.mailboxId));
		}
		return outcomes;
	},
});

/**
 * The `Message-ID` VALUE, with its angle brackets folded off.
 *
 * The wire keeps the bracketed form the MTA's parser yields, so the evidence
 * row correlates with the stored message on a string comparison. Everything a
 * SECOND implementation has to reproduce byte for byte — the §7.3 dedupe key
 * and the bundle hash a monitor recomputes from a revealed bundle at challenge
 * time — is derived from the value only, which is how `@owlat/ostr-observer`
 * documents both `ReportIdentity.messageId` and `EvidenceInput.messageId`. So
 * the fold happens exactly HERE: once, on the way into both, at the one place
 * that derives either.
 *
 * Only a matched surrounding pair is stripped, and only the outer one: the
 * local part of a Message-ID is case- and byte-sensitive, so nothing else about
 * the value is touched.
 */
function messageIdValue(raw: string): string {
	const trimmed = raw.trim();
	if (trimmed.length < 2 || !trimmed.startsWith('<') || !trimmed.endsWith('>')) {
		return trimmed;
	}
	return trimmed.slice(1, -1).trim();
}

/** One message's path from junk report to queued commitment. The instance-wide
 *  gates are the caller's; everything here is about this message. */
async function captureOne(
	ctx: ActionCtx,
	salt: string,
	messageId: Id<'mailMessages'>,
	mailboxId: Id<'mailboxes'>
): Promise<ReportCaptureOutcome> {
	const row = await ctx.runQuery(internal.ostr.store.getEvidence, { messageId });
	if (row === null) return { captured: false, reason: 'no-evidence' };
	const evidence = row.evidence;

	const reporter = mailboxToken(salt, 'reporter', mailboxId);
	const identity = {
		messageId: messageIdValue(evidence.messageId),
		bodyHash: evidence.bodyHash,
		reporter,
	};

	// The dedupe key is a digest over (Message-ID, bh=) — the same message,
	// however many mailboxes it was replayed into, is one capture (§7.3). The
	// reporter token is deliberately NOT part of it.
	const dedupeKey = reportDedupeKey(identity);
	if (dedupeKey === null) return { captured: false, reason: 'incomplete' };
	const alreadyCaptured = await ctx.runQuery(internal.ostr.store.isReportCaptured, { dedupeKey });
	const seen = new QueuedReportDedupeStore(alreadyCaptured ? [dedupeKey] : []);

	const capturedAt = toRfc3339(Date.now());
	const decision = shouldCaptureReport(identity, seen, capturedAt);
	if (!decision.capture) return { captured: false, reason: decision.reason };

	// Admissibility (§7.1): an `l=` signature, a sub-2048-bit RSA key, or a
	// signature not covering From/Date/Message-ID is not evidence, and a
	// correctly captured non-evidence bundle is still not evidence.
	const bundle = buildEvidenceBundle({
		...evidence,
		messageId: identity.messageId,
		verificationVerdict: narrowDkimVerdict(evidence.verificationVerdict),
	});
	if (!bundle.ok) {
		logInfo('[OSTR] report not admissible:', bundle.reasons.join(', '));
		return { captured: false, reason: 'inadmissible' };
	}

	const inserted = await ctx.runMutation(internal.ostr.store.enqueueReport, {
		subjectDomain: bundle.bundle.signingDomain,
		messageId,
		bundleHash: bundle.bundleHash,
		reporterToken: reporter,
		dedupeKey: decision.key,
		capturedAt,
	});
	// The mutation re-checks the key in its own transaction, so a second report
	// that raced past the read above lands here, not in the batch.
	if (!inserted) return { captured: false, reason: 'duplicate' };
	return { captured: true, subjectDomain: bundle.bundle.signingDomain };
}
