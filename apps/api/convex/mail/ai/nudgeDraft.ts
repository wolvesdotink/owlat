/**
 * "Draft a nudge" (SPEC §7): a follow-up the owner sends when the other side
 * owes them a reply (mail/nudges.ts finds those). It runs the ordinary Answer
 * mode drafter (`composeDraft.start` with `purpose: 'nudge'`) on a reply
 * draft of the thread, so the owner's voice, the thread's language, the
 * interactive spend admission and the person who sends it all stay as they
 * are. What changes:
 *
 *  - the instruction, composed here on the server (a client only adds its
 *    own note after it): a short, polite reminder, nothing new promised;
 *  - the drafter is told it follows up on the owner's own last message, and
 *    the person it writes to is the one we wait on (the draft's first To);
 *  - nothing is asked first: a nudge needs no fact from the owner, so the
 *    gap check is skipped. A draft that still comes back with gaps is asked
 *    as questions, as always.
 *
 * A thread whose interpretation is fenced off offers no nudge
 * (interpret/staleFence.ts), and `start` refuses one.
 *
 * Pure, so both runtimes import it.
 */

import type { GapCheckResult } from './composeDraftGap';

export type DraftPurpose = 'nudge';

const NUDGE_INSTRUCTION = [
	'Write a follow-up nudge, not an answer: the other party has not replied to the owner’s last message yet.',
	'Keep it short (two to four sentences) and polite, and remind them what the owner is waiting for.',
	'Do not repeat the earlier message, do not add new requests or promises, and do not sound impatient.',
	'Write in the language the thread is written in.',
].join(' ');

/** The instruction for the drafter: the nudge's, then the owner's own note (already trimmed). */
export function draftInstruction(
	purpose: DraftPurpose | undefined,
	note: string | undefined
): string | undefined {
	if (purpose !== 'nudge') return note;
	return note ? `${NUDGE_INSTRUCTION}\n\nThe owner adds: ${note}` : NUDGE_INSTRUCTION;
}

/** Who the drafter writes as, for a reply or a nudge. */
export function draftAudience(ownerAddress: string, purpose: DraftPurpose | undefined): string {
	return purpose === 'nudge'
		? `the mailbox owner (${ownerAddress}), following up on the owner's own last message in the thread, which the other party has not answered yet`
		: `the mailbox owner (${ownerAddress}), answering the last message in the thread, which the other party sent`;
}

/** A nudge asks nothing first (see the module header). */
export const NUDGE_GAP_CHECK: GapCheckResult = { questions: [], mayAsk: true };
