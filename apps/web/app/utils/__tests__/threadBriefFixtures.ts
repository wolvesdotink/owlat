/**
 * Thread brief views for the web tests: the plan's example thread (Jonas
 * Weber, website relaunch) in the shape `brief.get` returns.
 */
import type {
	BriefItemView,
	BriefModeView,
	EvidenceView,
	FactView,
} from '../../../../api/convex/mail/interpret/briefShape';

export const DAY = 86_400_000;
export const T0 = Date.UTC(2026, 9, 7, 9, 12);

export function evidence(messageId: string, quote: string): EvidenceView {
	return {
		source: { kind: 'mail', id: messageId as never },
		segmentId: 's0',
		start: 0,
		end: quote.length,
		contentRevision: 'r1',
		quote,
	};
}

export function item(over: Partial<BriefItemView> & { id: string; text: string }): BriefItemView {
	return {
		revision: 1,
		intent: 'request',
		facets: [],
		responsibility: 'us',
		status: 'open',
		disposition: 'unanswered',
		stateKey: 'open',
		primaryReaction: 'reply',
		requester: { isUs: false, name: 'Jonas Weber', email: 'jonas@kestrel.example' },
		responsible: { isUs: true },
		evidence: [evidence('m6', over.text)],
		verify: 'passed',
		isReviewNeeded: false,
		askedAt: T0,
		updatedAt: T0,
		isNew: false,
		...over,
		id: over.id as never,
	};
}

export function fact(
	over: Partial<FactView> & { id: string; key: string; text: string }
): FactView {
	return {
		status: 'current',
		provenance: 'reported',
		evidence: [evidence('m6', over.text)],
		...over,
		id: over.id as never,
	};
}

export function briefView(over: Partial<BriefModeView> = {}): BriefModeView {
	return {
		mode: 'brief',
		threadRef: { kind: 'mail', id: 't1' as never },
		interpretationRevision: 4,
		completeness: 'complete',
		latest: [
			{
				text: 'Jonas likes design v2 and wants two changes.',
				evidence: [evidence('m6', 'v2 looks great')],
			},
		],
		standing: {
			isConflicted: false,
			facts: [
				fact({
					id: 'f_old',
					key: '["launch","date",""]',
					text: 'Launch on 31 Oct',
					status: 'superseded',
					value: { kind: 'date', at: Date.UTC(2026, 9, 31) },
				}),
				fact({
					id: 'f_new',
					key: '["launch","date",""]',
					text: 'Launch moved because of the board meeting',
					supersedesId: 'f_old' as never,
					value: { kind: 'date', at: Date.UTC(2026, 10, 14) },
				}),
			],
		},
		forYou: [
			item({
				id: 'i_quote',
				text: 'Approve the revised quote of €5,350',
				intent: 'decision',
				facets: ['payment'],
				primaryReaction: 'replyWithStance',
				due: { phrase: 'by Friday', at: T0 + 2 * DAY, isAmbiguous: false },
			}),
			item({
				id: 'i_contract',
				text: 'Send the signed contract as a PDF',
				facets: ['file', 'signature'],
				primaryReaction: 'attach',
			}),
		],
		waitingOnOthers: [
			item({
				id: 'i_photos',
				text: 'Jonas sends the new hero photos',
				intent: 'promise',
				responsibility: 'them',
				primaryReaction: 'nudge',
			}),
		],
		unclear: [],
		activity: [
			{
				id: 'a1' as never,
				seq: 3,
				type: 'reply_sent',
				actor: { kind: 'user' },
				provenance: 'recorded',
				visibility: 'substance',
				text: 'You sent design-v2.pdf.',
				eventAt: T0 - 4 * DAY,
			},
		],
		counts: { forYou: 2, forTeam: 0, waitingOnOthers: 1, unclear: 0, closed: 0, hidden: 0 },
		participants: [
			{ name: 'Jonas Weber', email: 'jonas@kestrel.example', isUs: false, role: 'from' },
			{ name: 'Lena Hofmann', email: 'lena@kestrel.example', isUs: false, role: 'cc' },
			{ email: 'ada@owlat.example', isUs: true, role: 'us' },
		],
		files: [
			{
				attachmentId: 'a',
				filename: 'brief.pdf',
				messageId: 'm1',
				direction: 'in',
				at: T0 - 9 * DAY,
			},
		],
		...over,
	};
}
