/**
 * The Senders page's pure parts: tabs, the read bar, the status
 * control's options, and which sentence describes an unsubscribe result.
 * Copy is returned as i18n keys under `postbox.senders.*`; the components are
 * the render boundary.
 */

import type { FunctionReturnType } from 'convex/server';
import type { api } from '@owlat/api';

export type PostboxSenderRow = FunctionReturnType<
	typeof api.mail.senders.page.review
>['rows'][number];
export type PostboxSenderStatus = PostboxSenderRow['status'];
export type PostboxSenderSuggestion = NonNullable<PostboxSenderRow['suggestion']>;

export const SENDER_TABS = ['review', 'all', 'digest', 'auto_archive', 'unsubscribed'] as const;
export type SenderTab = (typeof SENDER_TABS)[number];

export function isSenderTab(value: unknown): value is SenderTab {
	return typeof value === 'string' && (SENDER_TABS as readonly string[]).includes(value);
}

/** The order of the segmented control, left to right. */
export const SENDER_STATUSES: readonly PostboxSenderStatus[] = [
	'keep',
	'digest',
	'auto_archive',
	'unsubscribed',
];

/** Apply caps one run at this many senders (`APPLY_SUGGESTIONS_MAX` in the API). */
export const APPLY_SUGGESTIONS_MAX = 50;

/** Read share over the window, 0–100, for the bar's width. */
export function senderReadPercent(row: Pick<PostboxSenderRow, 'delivered' | 'opened'>): number {
	if (row.delivered <= 0) return 0;
	return Math.min(100, Math.round((row.opened / row.delivered) * 100));
}

/** The status a suggestion sets. */
export function suggestedStatus(suggestion: PostboxSenderSuggestion): PostboxSenderStatus {
	return suggestion === 'unsubscribe' ? 'unsubscribed' : suggestion;
}

/** i18n key of the sentence under an unsubscribed sender, or null. */
export function unsubscribeResultKey(
	row: Pick<PostboxSenderRow, 'status' | 'unsubscribe'>
): string | null {
	if (row.status !== 'unsubscribed' || !row.unsubscribe) return null;
	switch (row.unsubscribe.result) {
		case 'confirmed':
			return 'postbox.senders.result.confirmed';
		case 'failed':
			return 'postbox.senders.result.failed';
		case 'opened':
			return 'postbox.senders.result.opened';
	}
}

/** The name a row goes by: the display name, else the address. */
export function senderName(row: Pick<PostboxSenderRow, 'displayName' | 'address'>): string {
	return row.displayName || row.address;
}
