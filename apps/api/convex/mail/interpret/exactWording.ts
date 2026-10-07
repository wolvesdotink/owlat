/**
 * "Read the exact wording": only the CURRENT extraction of a source carries
 * `messageInterpretations.isExactWordingRequired`, so the brief reads every
 * flagged message of a thread as one indexed page
 * (`by_mail_thread_exact_wording`), independent of how long the thread is.
 *
 * The reducer stores the fields {@link exactWordingFieldsOf} gives on the new
 * current row and clears them on the row it replaces ({@link
 * RETIRED_EXACT_WORDING}) in the same transaction. An extraction that did not
 * read the message (failed, skipped: no result) keeps the earlier reading's
 * flag, so a transient failure never hides a legal notice.
 *
 * Pure; not a Convex function.
 */

import type { Doc } from '../../_generated/dataModel';
import type { ReduceResult } from './reduceInput';

type ExactWordingFields = Pick<
	Doc<'messageInterpretations'>,
	'isExactWordingRequired' | 'exactWordingReason'
>;

/** The flag fields of a new current extraction row. */
export function exactWordingFieldsOf(
	result: ReduceResult | undefined,
	previous: ExactWordingFields | null
): ExactWordingFields {
	if (!result) {
		return previous?.isExactWordingRequired
			? {
					isExactWordingRequired: true,
					...(previous.exactWordingReason
						? { exactWordingReason: previous.exactWordingReason }
						: {}),
				}
			: {};
	}
	if (!result.exactWording) return {};
	return {
		isExactWordingRequired: true,
		...(result.exactWording.reason ? { exactWordingReason: result.exactWording.reason } : {}),
	};
}

/** Patch for the row a newer extraction replaces as current: it no longer carries the flag. */
export const RETIRED_EXACT_WORDING = {
	isExactWordingRequired: undefined,
	exactWordingReason: undefined,
} as const;
