/**
 * Where one conversation lands on a mailbox's Workbench. Pure (no Convex) so
 * the rules stay pinned by unit tests.
 *
 *   - important  what a person told the reader, or an automated mail that asks
 *                for action (a security alert, a failed payment). Summarised
 *                one sentence each, at the top.
 *   - routine    real mail with no personal or urgent signal. One quiet line.
 *   - filed      newsletters, notifications, receipts, promotions and spam.
 *                Never listed; the Workbench only counts them and names a
 *                few senders.
 *
 * The thread's stored category decides, with two corrections:
 *
 *   - A thread the classifier has not reached yet gets the same deterministic
 *     heuristic ingest runs (the caller passes its result as `heuristic`), so a
 *     fresh newsletter never flashes up as "important" for the seconds before
 *     classification lands.
 *   - `other` written by the heuristic means "no automated signal and not a
 *     known contact, and the model never refined it" (AI off, or it failed).
 *     That is how a first mail from a new client looks, so it counts as a
 *     person. `other` from the model or the user is really "none of these".
 */

import { FILED_CATEGORIES, type FiledCategory, isFiledCategory } from './threadStatus';

export type WorkbenchBucket = 'important' | 'routine' | FiledCategory;

/** Why a line is important, shown as a small label on the Workbench. */
export type ImportantReason = 'person' | 'new_sender' | 'alert';

export interface TriageInput {
	category?: { label: string; source: string } | null;
	/** `classifyMailCategory` for the latest message; used only when `category` is absent. */
	heuristic?: string | null;
	subject: string;
}

export interface Triage {
	bucket: WorkbenchBucket;
	reason: ImportantReason | null;
}

/**
 * Automated mail that still wants the reader's attention: security events,
 * money that did not move, things about to lapse, explicit calls to act.
 * One-time codes are left out on purpose; they are stale minutes later.
 */
const ALERT_SUBJECT =
	/(security alert|new (sign[- ]?in|login)|sign[- ]?in attempt|unusual (activity|sign[- ]?in)|suspicious|password (was )?(changed|reset)|payment (failed|declined|unsuccessful)|card (was )?(declined|expir)|\boverdue\b|past due|final (notice|reminder)|action required|account (suspended|locked|disabled|on hold)|renewal failed|(expires|expiring|will expire)\b|sicherheitswarnung|neue anmeldung|zahlung (fehlgeschlagen|abgelehnt)|konto gesperrt|handlungsbedarf|mahnung|überfällig|läuft (bald )?ab)/i;

/** Categories an alert can be lifted out of. Newsletters and ads never are. */
const ALERT_ELIGIBLE = new Set(['notification', 'receipt']);

export function isAlertSubject(subject: string): boolean {
	return ALERT_SUBJECT.test(subject);
}

export function triageThread(input: TriageInput): Triage {
	const stored = input.category ?? null;
	const label = stored?.label ?? input.heuristic ?? null;

	if (label === null) return { bucket: 'important', reason: 'new_sender' };
	if (label === 'person') return { bucket: 'important', reason: 'person' };
	if (label === 'other') {
		return stored === null || stored.source === 'heuristic'
			? { bucket: 'important', reason: 'new_sender' }
			: { bucket: 'routine', reason: null };
	}
	if (ALERT_ELIGIBLE.has(label) && isAlertSubject(input.subject)) {
		return { bucket: 'important', reason: 'alert' };
	}
	if (isFiledCategory(label)) return { bucket: label, reason: null };
	return { bucket: 'routine', reason: null };
}

export function isFiledBucket(bucket: WorkbenchBucket): bucket is FiledCategory {
	return (FILED_CATEGORIES as readonly string[]).includes(bucket);
}
