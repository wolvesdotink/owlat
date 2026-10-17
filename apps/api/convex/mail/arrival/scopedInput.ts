/**
 * Read on arrival (SPEC §2.4, §6.2, §6.5): the one scoped-input builder for
 * every short model read of a single message: the gist (6,000 characters),
 * the digest lines (800 per item) and the rule dry run / R2 questions.
 *
 * It applies interpretation's own scope and segmentation rules, so a short
 * read can never see more than a full read would:
 *
 *   - the body is loaded, opened and scoped exactly as `interpret/scope.ts`
 *     does (clearsigned scoping, hidden HTML stripped, undecryptable mail
 *     refused) and segmented with the same stable segment ids;
 *   - only the sender's own text and forwarded text are offered: quoted
 *     history (its own message carries it), signatures and disclaimers are
 *     left out;
 *   - a fenced thread (`interpret/staleFence.ts`) reads nothing.
 *
 * It returns null for a message interpretation would not read itself (an
 * ineligible snapshot, a stranger's bulk mail, a terminal exclusion at
 * arrival: `offerable.ts`), for security mail (codes, password resets: never shown
 * through a model's pick), exact-wording candidates (`exactWordingDetector`:
 * they get a full read instead), a fenced thread and a message that is gone
 * (purged).
 *
 * Isolate-safe: runs in any action.
 */

import type { Id } from '../../_generated/dataModel';
import type { ActionCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import type { SegmentedMessage } from '@owlat/shared/mailSegments';
import { detectExactWording } from '@owlat/shared/exactWordingDetector';
import { scopeForInterpretation, segmentScoped } from '../interpret/scope';
import { isSecurityMail } from '../interpret/eligibility';

/** The segment kinds a short read is offered. */
const OFFERED_KINDS: ReadonlySet<string> = new Set(['fresh', 'forwarded']);

/** One offered segment, its id as interpretation names it, and where its offered text sits. */
export interface ScopedSegment {
	id: string;
	kind: string;
	text: string;
	/** Canonical offsets of `text` (`segmented.canonicalText.slice(start, end) === text`). */
	start: number;
	end: number;
}

export interface ScopedMessageInput {
	subject: string;
	/** The offered segments in order, cut so their text fits `maxChars` together. */
	segments: ScopedSegment[];
	/** The whole segmentation, for grounding quotes (`interpret/ground.ts verifyQuote`). */
	segmented: SegmentedMessage;
	/** Some offered text did not fit `maxChars`, or the HTML ran past the scanner's cap. */
	isTruncated: boolean;
	/** The body fingerprint read (`interpret/sourceVersion.ts`); a commit rechecks it. */
	sourceVersion?: string;
}

/** The text of the sender's own segments (security and exact-wording screens read it). Pure. */
export function freshTextOf(segmented: SegmentedMessage): string {
	return segmented.segments
		.filter((s) => s.kind === 'fresh')
		.map((s) => segmented.canonicalText.slice(s.start, s.end))
		.join('\n');
}

/** The offered segments, in order, cut to `maxChars` of text in total. Pure. */
export function offeredSegments(
	segmented: SegmentedMessage,
	maxChars: number
): { segments: ScopedSegment[]; isCut: boolean } {
	const segments: ScopedSegment[] = [];
	let left = maxChars;
	let isCut = false;
	for (const segment of segmented.segments) {
		if (!OFFERED_KINDS.has(segment.kind)) continue;
		const text = segmented.canonicalText.slice(segment.start, segment.end);
		if (text.trim() === '') continue;
		if (left <= 0) {
			isCut = true;
			break;
		}
		if (text.length > left) isCut = true;
		const offered = text.slice(0, left);
		segments.push({
			id: segment.id,
			kind: segment.kind,
			text: offered,
			start: segment.start,
			end: segment.start + offered.length,
		});
		left -= text.length;
	}
	return { segments, isCut };
}

/** Build the scoped input of one Postbox message, or null (see the module doc). */
export async function buildScopedMessageInput(
	ctx: ActionCtx,
	messageId: Id<'mailMessages'>,
	opts: { maxChars: number }
): Promise<ScopedMessageInput | null> {
	const source = { kind: 'mail' as const, id: messageId };
	// Only what interpretation would read itself (final review F1, `offerable.ts`).
	if (!(await ctx.runQuery(internal.mail.arrival.offerable.isOfferable, { messageId }))) {
		return null;
	}
	if (await ctx.runQuery(internal.mail.interpret.staleFence.isSourceFenced, { source })) {
		return null;
	}
	const scoped = await scopeForInterpretation(ctx, source);
	if (!scoped || !scoped.ok) return null;
	const { segmented, isTruncated } = segmentScoped(scoped);
	const fresh = freshTextOf(segmented);
	if (isSecurityMail({ subject: scoped.subject, freshText: fresh })) return null;
	if (detectExactWording({ subject: scoped.subject, text: fresh }).length > 0) return null;
	const offered = offeredSegments(segmented, opts.maxChars);
	return {
		subject: scoped.subject,
		segments: offered.segments,
		segmented,
		isTruncated: isTruncated || offered.isCut,
		...(scoped.sourceVersion ? { sourceVersion: scoped.sourceVersion } : {}),
	};
}
