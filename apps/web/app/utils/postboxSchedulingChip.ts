/**
 * Pure decision helper for the reader's plain-prose scheduling chip
 * (PostboxSchedulingChip.vue). Kept out of the component so the "show only for
 * a real scheduling intent, on the trigger message, with no .ics attached, and
 * not dismissed" rule is unit-testable without mounting the reader.
 */

export interface SchedulingMeetingIntent {
	isScheduling: boolean;
	proposedTimes: string[];
	topic?: string;
}

interface AttachmentLike {
	filename: string;
	contentType: string;
}

/** True when an attachment is a calendar invite (.ics / text/calendar). */
export function isCalendarInviteAttachment(att: AttachmentLike): boolean {
	return (
		att.contentType.toLowerCase().includes('calendar') ||
		att.filename.toLowerCase().endsWith('.ics')
	);
}

/**
 * Whether to render the scheduling chip under a given message's header. The
 * chip is advisory and gated: it needs the `ai` flag, a scheduling intent whose
 * trigger message is this one, no attached calendar invite (that path is owned
 * by PostboxInviteCard), and no per-session dismissal.
 */
export function shouldShowSchedulingChip(opts: {
	aiEnabled: boolean;
	meetingIntent?: SchedulingMeetingIntent | null;
	triggerMessageId?: string;
	message: { _id: string; attachments?: AttachmentLike[] };
	dismissed: Set<string>;
}): boolean {
	if (!opts.aiEnabled) return false;
	if (!opts.meetingIntent?.isScheduling) return false;
	if (!opts.triggerMessageId || opts.triggerMessageId !== opts.message._id) return false;
	if ((opts.message.attachments ?? []).some(isCalendarInviteAttachment)) return false;
	return !opts.dismissed.has(opts.message._id);
}
