/**
 * What `inbox/messages.receiveMessage` decides about an arrival, without the
 * database: the facts derived from the envelope, the stored row, whether a
 * reply's outcome is classified, and whether the agent pipeline starts.
 * `messages.ts` keeps every read and write (duplicate lookup, contact and
 * thread resolution, body sealing, the suppression check, coalescing, the
 * rate limits) and runs them in the order these decisions describe; the
 * threading cascade stays with `threads/module.ts` and the status edges with
 * `processingLifecycle`.
 *
 * PURE: nothing here reads a clock, a database or the environment
 * (scripts/purity-roots.txt).
 */

import type { WithoutSystemFields } from 'convex/server';
import type { Doc, Id } from '../_generated/dataModel';
import { extractEmail, normalizeSubject } from '../lib/emailAddress';
import { isAutomatedMail } from '../lib/inboundClassification';
import { buildMessagePreview } from '../lib/textPreview';

/** Headroom over the 4,000 characters `classifyReplyOutcome` reads after it
 * collapses whitespace. */
const REPLY_TEXT_ARG_CHARS = 64 * 1024;

/** How much of each part the thread preview is built from. */
const PREVIEW_SOURCE_CHARS = 200_000;

type InboundRow = WithoutSystemFields<Doc<'inboundMessages'>>;

/** The envelope fields an arrival is judged and stored from. */
export type Arrival = Pick<
	InboundRow,
	| 'messageId'
	| 'from'
	| 'to'
	| 'subject'
	| 'inReplyTo'
	| 'references'
	| 'headers'
	| 'attachmentMeta'
	| 'attachmentMetaVersion'
	| 'rawStorageId'
	| 'rawSize'
	| 'virusVerdict'
	| 'mtaSpamVerdict'
	| 'mtaSpamScore'
	| 'spfResult'
	| 'dkimResult'
	| 'dmarcResult'
	| 'dmarcPolicy'
	| 'isSealed'
	| 'isSignatureValid'
	| 'signerFingerprint'
	| 'signerInstance'
	| 'isInboundSignatureValid'
	| 'inboundSignerFingerprint'
> & {
	readonly textBody?: string;
	readonly htmlBody?: string;
	readonly timestamp: number;
};

/** What receive knows about an arrival before it writes anything. */
export interface ArrivalPlan {
	readonly senderEmail: string;
	readonly normalizedSubject: string;
	readonly senderFirstName: string | undefined;
	/** The thread's preview line, built from a bounded slice of each part. */
	readonly preview: string | undefined;
	/**
	 * Confirmed malware. The row is quarantined instead of drafted on, and still
	 * STORED: this path has a hard never-drop invariant, and an operator still
	 * needs to see what arrived.
	 */
	readonly isInfected: boolean;
	/**
	 * Mail the agent must not spend model budget on: quarantined, automated
	 * (RFC 3834 autoresponders, list and bulk mail), or a self-send. The AI
	 * inbox address is public, so each would otherwise trigger a full pipeline
	 * run, and an auto-reply to an auto-responder forms a loop. Store-but-skip.
	 */
	readonly isPipelineSkipped: boolean;
	/**
	 * The text a reply's outcome is classified from, bounded for the scheduled
	 * job's arguments (the classifier reads its first 4,000 characters), or
	 * `undefined` when the arrival is not a reply, has no body or is quarantined.
	 */
	readonly replyFeedbackText: string | undefined;
}

export function planArrival(arrival: Arrival): ArrivalPlan {
	const senderEmail = extractEmail(arrival.from);
	const isInfected = arrival.virusVerdict === 'infected';
	const isReply = Boolean(arrival.inReplyTo || arrival.references);
	const replyText = arrival.textBody ?? arrival.htmlBody;
	return {
		senderEmail,
		normalizedSubject: normalizeSubject(arrival.subject),
		senderFirstName: extractNameFromEmail(arrival.from),
		// Sliced first: a 140-character preview need not convert or collapse a
		// 10 MiB body inside a mutation's time budget.
		preview: buildMessagePreview({
			text: arrival.textBody?.slice(0, PREVIEW_SOURCE_CHARS),
			html: arrival.htmlBody?.slice(0, PREVIEW_SOURCE_CHARS),
		}),
		isInfected,
		isPipelineSkipped:
			isInfected ||
			isAutomatedMail(parseHeaders(arrival.headers)) ||
			senderEmail === extractEmail(arrival.to),
		replyFeedbackText:
			isReply && replyText && !isInfected ? replyText.slice(0, REPLY_TEXT_ARG_CHARS) : undefined,
	};
}

/** The sealed (or storage-referenced) body columns `inboundBodyColumns` returns. */
export type StoredBodyColumns = Pick<
	InboundRow,
	'textBody' | 'htmlBody' | 'textBodyStorageId' | 'htmlBodyStorageId'
>;

/** The `inboundMessages` row one arrival is stored as. */
export function inboundMessageRow(
	arrival: Arrival,
	stored: {
		readonly bodyColumns: StoredBodyColumns;
		readonly threadId: Id<'conversationThreads'>;
		readonly contactId: Id<'contacts'>;
		readonly isInfected: boolean;
	}
): InboundRow {
	return {
		messageId: arrival.messageId,
		from: arrival.from,
		to: arrival.to,
		subject: arrival.subject,
		...stored.bodyColumns,
		inReplyTo: arrival.inReplyTo,
		references: arrival.references,
		headers: arrival.headers,
		attachmentMeta: arrival.attachmentMeta,
		attachmentMetaVersion: arrival.attachmentMetaVersion,
		threadId: stored.threadId,
		contactId: stored.contactId,
		processingStatus: stored.isInfected ? 'quarantined' : 'received',
		receivedAt: arrival.timestamp,
		rawStorageId: arrival.rawStorageId,
		rawSize: arrival.rawSize,
		virusVerdict: arrival.virusVerdict,
		mtaSpamVerdict: arrival.mtaSpamVerdict,
		mtaSpamScore: arrival.mtaSpamScore,
		// Written here and cleared only by the retention sweep, so the marker
		// and the blob it stands for have exactly one writer each.
		isRawRetained: arrival.rawStorageId ? (true as const) : undefined,
		spfResult: arrival.spfResult,
		dkimResult: arrival.dkimResult,
		dmarcResult: arrival.dmarcResult,
		dmarcPolicy: arrival.dmarcPolicy,
		isSealed: arrival.isSealed,
		isSignatureValid: arrival.isSignatureValid,
		signerFingerprint: arrival.signerFingerprint,
		signerInstance: arrival.signerInstance,
		isInboundSignatureValid: arrival.isInboundSignatureValid,
		inboundSignerFingerprint: arrival.inboundSignerFingerprint,
	};
}

/**
 * The coalesce window to register this arrival in, or `undefined` to start
 * (or skip) the pipeline without one. Coalescing is opt-in: only a positive
 * `agentConfig.coalesceWindowMs` debounces a burst into one run.
 */
export function coalesceWindowFor(
	plan: Pick<ArrivalPlan, 'isPipelineSkipped'>,
	coalesceWindowMs: number | undefined
): number | undefined {
	if (plan.isPipelineSkipped) return undefined;
	const windowMs = coalesceWindowMs ?? 0;
	return windowMs > 0 ? windowMs : undefined;
}

/** Whether the agent pipeline starts for a stored, unblocked arrival. */
export type PipelineStart =
	| { readonly kind: 'skip'; readonly message: string }
	/** The coalesce batch starts the walker once the window settles. */
	| { readonly kind: 'coalesced' }
	/**
	 * Start, under the per-sender and global cost caps: each run spends several
	 * LLM calls and inbound volume is attacker-controlled (the address is public,
	 * and distinct threads defeat coalescing), so a flood is stored but not run.
	 */
	| { readonly kind: 'start_within_caps' };

export function decidePipelineStart(
	plan: Pick<ArrivalPlan, 'isInfected' | 'isPipelineSkipped'>,
	isCoalesced: boolean
): PipelineStart {
	if (plan.isInfected) {
		return {
			kind: 'skip',
			message: '[Inbound Email] malware found — mail stored quarantined, AI pipeline skipped',
		};
	}
	if (plan.isPipelineSkipped) {
		return {
			kind: 'skip',
			message: '[Inbound Email] automated/self-send mail stored without AI processing',
		};
	}
	return isCoalesced ? { kind: 'coalesced' } : { kind: 'start_within_caps' };
}

/**
 * Parse the serialized inbound header map (a JSON string of header→value, see
 * webhooks/dispatcher.ts) defensively. A malformed blob must never fail the
 * receive — we just treat it as no headers.
 */
function parseHeaders(raw: string | undefined): Record<string, string> {
	if (!raw) return {};
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return parsed as Record<string, string>;
		}
	} catch {
		// Not valid JSON — fall through to the empty-headers default.
	}
	return {};
}

/**
 * Extract a first name from the "Name <email>" format
 */
export function extractNameFromEmail(fromField: string): string | undefined {
	// Try "First Last <email>" format
	const nameMatch = fromField.match(/^([^<]+)</);
	if (nameMatch?.[1]) {
		const fullName = nameMatch[1].trim().replace(/"/g, '');
		if (fullName) {
			return fullName.split(/\s+/)[0]; // Return first name
		}
	}
	return undefined;
}
