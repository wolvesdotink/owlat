/**
 * The banners `BriefIncomplete` shows, as data. Pure:
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
	/** The cause is the instance's AI setup, which an admin fixes in AI settings. */
	offersAiSettings?: boolean;
}

type GapReason = NonNullable<NonNullable<BriefModeView['gap']>['reason']>;

const NONE_TEXT: Partial<Record<GapReason, string>> = {
	aiOff: 'components.brief.incomplete.none.aiOff',
	budget: 'components.brief.incomplete.none.budget',
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

/**
 * Reasons that are the instance's state, not the thread's: AI is off or has
 * no provider, or its budget is used up. Every thread reads the same, so the
 * banner is a quiet note that points an admin to AI settings, never a
 * warning about this thread.
 */
const INSTANCE_REASON: Partial<Record<GapReason, string>> = {
	aiOff: 'components.brief.incomplete.partialReason.aiOff',
	budget: 'components.brief.incomplete.partialReason.budget',
};

/** What the banners read: the same on a personal brief and a team view. */
export type BriefGapInput = Pick<ThreadBriefView, 'completeness' | 'gap' | 'deferredSources'>;

/**
 * New mail in the thread waited for this open and is being read now.
 * Only while the overview is otherwise waiting on it: nothing recorded yet,
 * or a partial overview whose gap is exactly that wait.
 */
function isReadingDeferred(brief: BriefGapInput): boolean {
	if ((brief.deferredSources ?? 0) === 0) return false;
	return (
		brief.completeness === 'pending' ||
		(brief.completeness === 'partial' && brief.gap?.reason === 'pending')
	);
}

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
	} else if (reason === 'stale') {
		// The thread's interpretation is fenced off (mail/interpret/staleFence.ts):
		// its items show, nothing the model read.
		banners.push({
			key: 'stale',
			tone: 'warn',
			text: 'components.brief.incomplete.stale',
			offersConversation: true,
		});
	} else if (!brief || brief.completeness === 'none') {
		banners.push({
			key: 'none',
			tone: 'neutral',
			text: (reason && NONE_TEXT[reason]) || 'components.brief.incomplete.none.default',
			offersConversation: true,
			...(reason && INSTANCE_REASON[reason] ? { offersAiSettings: true } : {}),
		});
	} else if (isReadingDeferred(brief)) {
		banners.push({
			key: 'deferred',
			tone: 'info',
			text: 'components.brief.incomplete.deferred',
			offersConversation: brief.completeness === 'partial',
		});
	} else if (brief.completeness === 'pending') {
		banners.push({
			key: 'pending',
			tone: 'info',
			text: 'components.brief.incomplete.pending',
			offersConversation: false,
		});
	} else if (brief.completeness === 'partial' && brief.gap && reason && INSTANCE_REASON[reason]) {
		banners.push({
			key: 'instance',
			tone: 'neutral',
			text: {
				key: INSTANCE_REASON[reason],
				params: { done: brief.gap.interpretedMessages, total: brief.gap.totalMessages },
			},
			offersConversation: true,
			offersAiSettings: true,
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
	if (opts.isSigned && brief && brief.completeness !== 'none' && reason !== 'stale') {
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
