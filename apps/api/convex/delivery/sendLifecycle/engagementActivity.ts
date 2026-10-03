import type { Effect } from './effects';
import type { EmailSendDoc, SendRef, TransactionalSendDoc, TransitionInput } from './types';

// ============================================================================
// Send lifecycle — the contact activity for a reader open or click.
//
// `email_opened` / `email_clicked` go through the same `contact_activity`
// effect as `email_sent` and `email_bounced`, so the single writer
// (`contactActivities/writer.ts`) sets `hasOpened` / `hasClicked`, folds the
// engagement score, and the contact timeline and dashboard feed show the row.
//
// WHICH ENGAGEMENT COUNTS. Only a reader open or click: the reducers branch
// automated opens (Apple Mail Privacy Protection, scanners, arrival prefetch)
// and scanner clicks off before they get here, so those never become an
// activity. The reducers call this inside their first-open / first-click gate,
// the same one the campaign and dashboard counters use: someone re-reading one
// email five times is one `email_opened`, not five, and the engagement score
// counts the message, not the re-reads. A reader who opens several emails gets
// one row per email.
//
// The send-time profile is fed from the reducers directly
// (`sendTimeEffects.ts`) and never reads these rows, so it does not count an
// engagement twice.
// ============================================================================

/** The `contact_activity` effect for a send's first reader open or click. */
export function readerEngagementActivity(
	send: EmailSendDoc | TransactionalSendDoc,
	ref: SendRef,
	args: Extract<TransitionInput, { to: 'opened' | 'clicked' }>
): Effect[] {
	if (!send.contactId) return [];
	const campaignId =
		ref.kind === 'campaign' ? { campaignId: String((send as EmailSendDoc).campaignId) } : {};
	if (args.to === 'clicked') {
		return [
			{
				kind: 'contact_activity',
				literal: 'email_clicked',
				contactId: send.contactId,
				metadata: { ...campaignId, linkUrl: args.url },
				occurredAt: args.at,
			},
		];
	}
	const emailSubject =
		ref.kind === 'campaign'
			? (send as EmailSendDoc).personalizedSubject
			: (send as TransactionalSendDoc).subject;
	return [
		{
			kind: 'contact_activity',
			literal: 'email_opened',
			contactId: send.contactId,
			metadata: { ...campaignId, ...(emailSubject ? { emailSubject } : {}) },
			occurredAt: args.at,
		},
	];
}
