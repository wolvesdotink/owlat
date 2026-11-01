/**
 * The round trip between the campaign wizard and the email editor.
 *
 * The wizard's state is its URL (`/dashboard/campaigns/new?id=…&step=…`), and
 * sender, audience and subject are persisted on each step's Next, so leaving
 * for the editor and coming back loses nothing as long as the editor knows
 * where "back" is. The Review step's send choice is the one thing that lives
 * only on screen; it rides along in the return URL.
 */
import type { Id } from '@owlat/api/dataModel';
import { safeRedirect } from '~/utils/safeRedirect';

/** The Review step's "Schedule for later" choice, carried through the editor. */
export interface ReviewSchedule {
	date: string;
	time: string;
	recipientTimezone: boolean;
	/** "Optimized per contact" settings, when that delivery time was chosen. */
	optimization?: { windowHours: number; holdoutPercent: number };
}

/** An email the Review step names (the attached one, or Variant B's). */
export interface ReviewEmailTemplate {
	readonly _id: Id<'emailTemplates'>;
	readonly name: string;
	readonly subject: string;
}

/** Everything the Review step summarizes and sends. */
export interface ReviewCampaignData {
	campaignId: Id<'campaigns'>;
	campaignName: string;
	fromName: string;
	fromEmail: string;
	replyTo: string;
	audienceDisplayText: string;
	audienceCount: number;
	/**
	 * `audienceCount` is a lower bound (the wizard's readout stopped at one page
	 * or is still on a first background count): shown as "N+", always
	 * confirmed, and kept out of the capacity note, which needs the real size.
	 */
	audienceCountAtLeast?: boolean;
	campaignSubject: string;
	selectedTemplate: ReviewEmailTemplate | null;
	/**
	 * The attached email's rendered HTML: `null` when it has no body yet (which
	 * blocks the send), `undefined` while that is not known.
	 */
	emailBodyHtml?: string | null;
	/** The attached email's stored Blocks (JSON), for the pre-send checks' "Show me". */
	emailContent?: string;
	/** Topic campaigns get the unsubscribe footer; segment campaigns do not. */
	audienceKind?: 'topic' | 'segment';
	// A/B Test data
	abTestEnabled: boolean;
	abTestType: 'subject' | 'content';
	abVariantBSubject: string;
	abVariantBTemplateId: Id<'emailTemplates'> | null;
	abSplitPercentage: number;
	abWinnerCriteria: 'open_rate' | 'click_rate' | 'manual';
	abTestDuration: number;
	templates: readonly ReviewEmailTemplate[];
	/** The template list failed to load, so Variant B's template name is missing. */
	templatesLoadFailed?: boolean;
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
		if (schedule.optimization) {
			query.set(
				'sto',
				`${schedule.optimization.windowHours}-${schedule.optimization.holdoutPercent}`
			);
		}
	}
	return `/dashboard/campaigns/new?${query.toString()}`;
}

/**
 * The email editor for a template, set to come back to `returnTo`, optionally
 * opening with one Block selected (the pre-send checks' "Show me").
 */
export function emailEditorPath(templateId: string, returnTo: string, blockId?: string): string {
	const block = blockId ? `&block=${encodeURIComponent(blockId)}` : '';
	return `/dashboard/send/emails/${templateId}/edit?returnTo=${encodeURIComponent(returnTo)}${block}`;
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
	const sto = /^(\d{1,2})-(\d{1,2})$/.exec(first(query['sto']));
	return {
		date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '',
		time: /^\d{2}:\d{2}$/.test(time) ? time : '',
		recipientTimezone: first(query['tz']) === '1',
		...(sto
			? { optimization: { windowHours: Number(sto[1]), holdoutPercent: Number(sto[2]) } }
			: {}),
	};
}
