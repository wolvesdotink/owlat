/**
 * The round trip between the campaign wizard and the email editor (#1048).
 *
 * The wizard's state is its URL (`/dashboard/campaigns/new?id=…&step=…`), and
 * sender, audience and subject are persisted on each step's Next, so leaving
 * for the editor and coming back loses nothing as long as the editor knows
 * where "back" is. The Review step's send choice is the one thing that lives
 * only on screen; it rides along in the return URL.
 */
import { safeRedirect } from '~/utils/safeRedirect';

/** The Review step's "Schedule for later" choice, carried through the editor. */
export interface ReviewSchedule {
	date: string;
	time: string;
	recipientTimezone: boolean;
}

/** What `templateHasBody` reads off an email template row. */
interface TemplateBody {
	htmlContent?: string;
	content?: string;
}

/**
 * Whether the email has something to send. The send pipeline refuses a
 * template without `htmlContent` (`campaigns/send.ts`); a canvas saved with no
 * blocks still renders a wrapper document, so its stored `[]` counts as empty
 * too.
 */
export function templateHasBody(template: TemplateBody | null | undefined): boolean {
	if (!template?.htmlContent?.trim()) return false;
	return template.content?.trim() !== '[]';
}

/** The wizard's Review step for a draft, with a pending schedule if there is one. */
export function campaignReviewPath(campaignId: string, schedule?: ReviewSchedule | null): string {
	const query = new URLSearchParams({ id: campaignId, step: 'review' });
	if (schedule) {
		query.set('send', 'later');
		if (schedule.date) query.set('date', schedule.date);
		if (schedule.time) query.set('time', schedule.time);
		if (schedule.recipientTimezone) query.set('tz', '1');
	}
	return `/dashboard/campaigns/new?${query.toString()}`;
}

/** The email editor for a template, set to come back to `returnTo`. */
export function emailEditorPath(templateId: string, returnTo: string): string {
	return `/dashboard/send/emails/${templateId}/edit?returnTo=${encodeURIComponent(returnTo)}`;
}

/**
 * The campaign page the editor's "Back to campaign" goes to, or `null` when
 * the editor was not opened from one. Only a same-origin campaign path is
 * honoured, so the label is always true and the query cannot be used as an
 * open redirect.
 */
export function campaignReturnTarget(value: unknown): string | null {
	const target = safeRedirect(Array.isArray(value) ? value[0] : value, '');
	return target.startsWith('/dashboard/campaigns/') ? target : null;
}

/** The schedule a return URL carries back into the Review step, if any. */
export function readReviewSchedule(query: Record<string, unknown>): ReviewSchedule | null {
	const first = (value: unknown) => {
		const raw = Array.isArray(value) ? value[0] : value;
		return typeof raw === 'string' ? raw : '';
	};
	if (first(query['send']) !== 'later') return null;
	const date = first(query['date']);
	const time = first(query['time']);
	return {
		date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '',
		time: /^\d{2}:\d{2}$/.test(time) ? time : '',
		recipientTimezone: first(query['tz']) === '1',
	};
}
