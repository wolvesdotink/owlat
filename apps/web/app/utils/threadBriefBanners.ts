/**
 * The banners `BriefIncomplete` shows, as data (plan §8 "Hard cases"). Pure:
 * texts are catalog keys the component resolves.
 */
import type { BriefModeView, ThreadBriefView } from '../../../api/convex/mail/interpret/briefShape';
import type { LocalizedText } from '~/utils/localizedText';

export interface BriefBanner {
	key: string;
	tone: 'warn' | 'info' | 'err' | 'neutral';
	lead?: string;
	text: LocalizedText;
	offersConversation: boolean;
}

type GapReason = NonNullable<NonNullable<BriefModeView['gap']>['reason']>;

const NONE_TEXT: Partial<Record<GapReason, string>> = {
	aiOff: 'components.brief.incomplete.none.aiOff',
	undecryptable: 'components.brief.incomplete.none.undecryptable',
	ineligible: 'components.brief.incomplete.none.ineligible',
	failed: 'components.brief.incomplete.none.failed',
	pending: 'components.brief.incomplete.none.pending',
};

const PARTIAL_REASON: Partial<Record<GapReason, string>> = {
	tooLong: 'components.brief.incomplete.partialReason.tooLong',
	failed: 'components.brief.incomplete.partialReason.failed',
	undecryptable: 'components.brief.incomplete.partialReason.undecryptable',
	pending: 'components.brief.incomplete.partialReason.pending',
	history: 'components.brief.incomplete.partialReason.history',
};

/** What the banners read: the same on a personal brief and a team view. */
export type BriefGapInput = Pick<ThreadBriefView, 'completeness' | 'gap'>;

export function briefBanners(
	brief: BriefGapInput | null,
	opts: { isSigned?: boolean } = {}
): BriefBanner[] {
	const banners: BriefBanner[] = [];
	const reason = brief?.gap?.reason;
	if (reason === 'security') {
		banners.push({
			key: 'security',
			tone: 'err',
			lead: 'components.brief.incomplete.securityLead',
			text: 'components.brief.incomplete.security',
			offersConversation: false,
		});
	} else if (reason === 'short') {
		banners.push({
			key: 'short',
			tone: 'info',
			text: 'components.brief.incomplete.short',
			offersConversation: false,
		});
	} else if (!brief || brief.completeness === 'none') {
		banners.push({
			key: 'none',
			tone: 'neutral',
			text: (reason && NONE_TEXT[reason]) || 'components.brief.incomplete.none.default',
			offersConversation: true,
		});
	} else if (brief.completeness === 'pending') {
		banners.push({
			key: 'pending',
			tone: 'info',
			text: 'components.brief.incomplete.pending',
			offersConversation: false,
		});
	} else if (brief.completeness === 'partial') {
		const gap = brief.gap;
		banners.push({
			key: 'partial',
			tone: 'warn',
			lead: 'components.brief.incomplete.partialLead',
			// Every partial text names the counts, so one without a gap says less.
			text: gap
				? {
						key: (reason && PARTIAL_REASON[reason]) ?? 'components.brief.incomplete.partialCount',
						params: { done: gap.interpretedMessages, total: gap.totalMessages },
					}
				: 'components.brief.incomplete.partialPlain',
			offersConversation: true,
		});
	}
	if (opts.isSigned && brief && brief.completeness !== 'none') {
		banners.push({
			key: 'signed',
			tone: 'info',
			text: 'components.brief.incomplete.signed',
			offersConversation: false,
		});
	}
	return banners;
}

/** Whether "For you" may say there is nothing to do. */
export function isBriefComplete(brief: BriefGapInput | null | undefined): boolean {
	return brief?.completeness === 'complete';
}
