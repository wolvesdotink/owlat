/**
 * Which alerts make a sound: pure rules for the opt-in alert sounds.
 *
 * Three alerts can chime, each behind its own default-off switch, and nothing
 * else ever does — ordinary new mail, mentions, SLA breaches and drafts-ready
 * counts stay silent however the switches are set:
 *
 *   - `reply`      a reply landed on a thread the user armed with "notify me
 *                  when they reply";
 *   - `assignment` a teammate handed them a conversation;
 *   - `question`   the agent parked a reply because it needs a fact from them
 *                  (the question that waits in their Answer queue).
 *
 * Quiet hours silence every sound, the armed reply included. The visual
 * notification for an armed reply deliberately pierces quiet hours; a sound
 * at night is a different promise, and nobody asked for that one.
 *
 * Arrivals that land together make one sound, not one each: a sound opens a
 * burst window and every alert inside it stays silent.
 *
 * Kept free of Vue, the DOM and Convex so the decision table is unit-testable.
 */
import type { FeatureFlagKey } from '@owlat/shared/featureFlags';
import { hasPermission, type OrganizationRole } from '@owlat/shared/organizationPermissions';
import type { AssignmentNotice } from '~/lib/inbox/assignmentNoticeRules';
import type { UnreadPeekMessage } from '~/lib/desktop/notificationRules';

export type AlertSoundKind = 'reply' | 'assignment' | 'question';

/** Every kind, in the order the settings card lists them. */
export const ALERT_SOUND_KINDS: readonly AlertSoundKind[] = ['reply', 'assignment', 'question'];

export type AlertSoundPrefs = Readonly<Record<AlertSoundKind, boolean>>;

/** What decides which alerts can reach a person at all. */
interface AlertSoundAudience {
	isFeatureEnabled(flag: FeatureFlagKey): boolean;
	/** Unresolved (null or absent) reaches no Team-inbox alert. */
	role?: OrganizationRole | null;
}

/**
 * The kinds this person can hear, in card order. The reply alert needs
 * personal mail; assignment and agent-question notices come from the Team
 * inbox and reach only its readers (owners and admins, the same permission the
 * notice query checks). The settings card and the palette's control both read
 * this, so search never offers a switch the card hides.
 */
export function alertSoundKindsFor(audience: AlertSoundAudience): AlertSoundKind[] {
	const hasMail =
		audience.isFeatureEnabled('postbox') || audience.isFeatureEnabled('mail.external');
	const hasTeamAlerts =
		audience.isFeatureEnabled('inbox') &&
		hasPermission(audience.role ?? null, 'organization:manage');
	return ALERT_SOUND_KINDS.filter((kind) => (kind === 'reply' ? hasMail : hasTeamAlerts));
}

/** The settings-row fields that hold the switches (`mail.settings`). */
interface AlertSoundSettingsFields {
	isReplyAlertSoundOn?: boolean;
	isAssignmentSoundOn?: boolean;
	isQuestionSoundOn?: boolean;
}

/** How long after a sound further alerts stay silent. */
export const ALERT_SOUND_BURST_MS = 10_000;

/** An unset switch (or a row that was never saved) is OFF: sounds are opt-in. */
export function resolveAlertSoundPrefs(
	row: AlertSoundSettingsFields | null | undefined
): AlertSoundPrefs {
	return {
		reply: row?.isReplyAlertSoundOn ?? false,
		assignment: row?.isAssignmentSoundOn ?? false,
		question: row?.isQuestionSoundOn ?? false,
	};
}

/** The `preferences.alertSounds.update` patch that flips one switch and nothing else. */
export function alertSoundPatch(kind: AlertSoundKind, enabled: boolean): AlertSoundSettingsFields {
	if (kind === 'reply') return { isReplyAlertSoundOn: enabled };
	if (kind === 'assignment') return { isAssignmentSoundOn: enabled };
	return { isQuestionSoundOn: enabled };
}

/**
 * The alert a newly arrived unread message stands for: a reply on an armed
 * thread, unless the thread is muted (a mute outranks the alert, exactly as it
 * does for the visual notification).
 */
export function unreadAlertKind(
	message: Pick<UnreadPeekMessage, 'alerted' | 'muted'>
): AlertSoundKind | null {
	return message.alerted && !message.muted ? 'reply' : null;
}

/**
 * The alert a new notice stands for. A notice without a kind predates the
 * field and is an assignment; mentions and SLA breaches make no sound.
 */
export function noticeAlertKind(notice: Pick<AssignmentNotice, 'kind'>): AlertSoundKind | null {
	if (notice.kind === undefined || notice.kind === 'assignment') return 'assignment';
	if (notice.kind === 'clarification') return 'question';
	return null;
}

/**
 * What one source has shown so far: every id, and the newest arrival time
 * among them (`null` until the source has shown anything).
 */
export interface ArrivalMemory {
	readonly seen: Set<string>;
	newestAt: number | null;
}

/**
 * The items of a newest-first window that actually ARRIVED since the last
 * look: unseen, and newer than anything seen before. The id alone is not
 * enough, because the window is bounded: reading or archiving its newest item
 * lets an older unread one slide in from below, unseen but not new. Anything
 * that slides in is older than what it replaces, so the watermark keeps it
 * silent. Updates `memory` with the whole window. Pure apart from `memory`.
 */
export function takeArrivals<T>(
	memory: ArrivalMemory,
	items: readonly T[],
	idOf: (item: T) => string,
	timeOf: (item: T) => number
): T[] {
	const since = memory.newestAt;
	const fresh = items.filter(
		(item) => !memory.seen.has(idOf(item)) && (since === null || timeOf(item) > since)
	);
	for (const item of items) {
		memory.seen.add(idOf(item));
		const at = timeOf(item);
		if (memory.newestAt === null || at > memory.newestAt) memory.newestAt = at;
	}
	return fresh;
}

/** The distinct kinds a batch of new arrivals stands for. */
export function alertKindsOf<T>(
	items: readonly T[],
	kindOf: (item: T) => AlertSoundKind | null
): AlertSoundKind[] {
	const kinds = new Set<AlertSoundKind>();
	for (const item of items) {
		const kind = kindOf(item);
		if (kind) kinds.add(kind);
	}
	return [...kinds];
}

interface AlertSoundDecisionInput {
	/** The kinds this batch of arrivals stands for. */
	kinds: readonly AlertSoundKind[];
	prefs: AlertSoundPrefs;
	/** Inside the user's quiet-hours window right now. */
	quiet: boolean;
	/** The desktop app's notification master switch is off, or this workspace is muted. */
	silenced: boolean;
}

/** Whether this batch earns a sound, before the burst window is consulted. */
export function shouldPlayAlertSound(input: AlertSoundDecisionInput): boolean {
	if (input.quiet || input.silenced) return false;
	return input.kinds.some((kind) => input.prefs[kind]);
}

/**
 * Whether a sound at `now` starts a new burst after the last one at `lastAt`.
 * A stamp further in the future than one window is a clock that jumped back,
 * not a burst in progress, so it does not hold sounds back indefinitely.
 */
export function isNewAlertBurst(
	lastAt: number | null,
	now: number,
	windowMs: number = ALERT_SOUND_BURST_MS
): boolean {
	if (lastAt === null) return true;
	return now - lastAt >= windowMs || lastAt - now > windowMs;
}
