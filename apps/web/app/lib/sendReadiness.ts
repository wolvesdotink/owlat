/**
 * SENDING READINESS COPY — "you can send to about N contacts today", derived
 * once.
 *
 * The backend answers how much campaign volume can go out today and when that
 * number next grows (`campaigns/sendingReadiness.ts`). Two surfaces render that
 * answer as a NOTE beside the send button — the campaign editor and the
 * new-campaign wizard's review step — and they must say the SAME thing, so the
 * sentence is built here rather than twice in two templates.
 *
 * The getting-started checklist quotes the same measurement, but not through
 * here: it has no note to render, only a step DESCRIPTION to extend, and a
 * heading plus a second line does not fit inside one. `sentCampaignDescription`
 * in `~/utils/gettingStarted` owns that one sentence and says why it words the
 * same number differently.
 *
 * The rule throughout is the deliverability plan's D14: say exactly what is
 * known and nothing more. An unmeasurable cap produces `null` (the surface
 * renders nothing) rather than a reassuring zero, a growth that the projection
 * does not show is never promised, and an audience the cap cannot carry today is
 * described as PACED — not as a failure, because it is not one.
 */

import { CAPACITY_DAY_MS, formatCapacityDay } from '~/lib/campaignCapacityRefusal';

/** The readiness answer, in the shape `getSendingReadiness` returns it. */
export type SendingReadiness =
	| { capped: false; reason: string }
	| { capped: true; today: number; growsTo: number | null; growsAt: number | null };

/**
 * How the note should read.
 * - `ready` — everything the operator is about to send fits today.
 * - `paced` — it will go out, over more than one day. Informational, never red.
 * - `waiting` — nothing more can go out today; the cap returns later.
 */
export type SendReadinessTone = 'ready' | 'paced' | 'waiting';

export interface SendReadinessNote {
	tone: SendReadinessTone;
	headline: string;
	/** The second line, or `null` when the headline says all there is. */
	detail: string | null;
}

/**
 * The two reasons a missing cap is REASSURANCE rather than ignorance: overflow
 * to a verified relay absorbs the tail, or campaigns do not dispatch through the
 * warm-up-capped own MTA at all. Every other reason (`dispatch_unknown`,
 * `no_projection`, `measurement_failed`) means we could not measure, and the
 * honest render for that is nothing at all.
 */
const UNCAPPED_DETAIL: Readonly<Record<string, string>> = {
	warmup_overflow_absorbs:
		'Volume over your own daily IP cap goes out through your verified relay, so the whole audience can send in one go.',
	not_own_mta:
		'Campaigns go out through your configured sending provider, which is not subject to IP warm-up caps.',
};

/** "tomorrow" when `at` starts the next UTC day after `now`, else its date. */
function whenLabel(at: number, now: number): string {
	const dayZero = Math.floor(now / CAPACITY_DAY_MS) * CAPACITY_DAY_MS;
	if (at - dayZero === CAPACITY_DAY_MS) return 'tomorrow';
	return `on ${formatCapacityDay(at, 'short')}`;
}

/** "Your daily cap grows to about N …", or `null` when no growth is projected. */
function growthSentence(
	readiness: Extract<SendingReadiness, { capped: true }>,
	now: number
): string | null {
	const { growsTo, growsAt } = readiness;
	if (growsTo === null || growsAt === null) return null;
	return `Your capacity grows to about ${growsTo.toLocaleString()} ${whenLabel(growsAt, now)}.`;
}

/**
 * The readiness note to render, or `null` when there is nothing honest to say.
 *
 * `audienceSize` is the eligible recipient count when the surface knows it (the
 * campaign editor and the review step do; the checklist does not). Knowing it
 * turns a bare capacity figure into the answer the operator actually wants —
 * does what I am about to send fit today. Anything that is not a positive count
 * means it is NOT known, and the note falls back to the capacity figure alone.
 */
export function sendReadinessNote(
	readiness: SendingReadiness | null | undefined,
	options: { audienceSize?: number | null; now: number }
): SendReadinessNote | null {
	if (!readiness) return null;

	if (!readiness.capped) {
		const detail = UNCAPPED_DETAIL[readiness.reason];
		if (!detail) return null;
		return { tone: 'ready', headline: 'No warm-up limit applies to this send', detail };
	}

	const growth = growthSentence(readiness, options.now);

	if (readiness.today <= 0) {
		return {
			tone: 'waiting',
			headline: "Today's sending capacity is used up",
			detail:
				growth ??
				'Capacity returns as your warm-up schedule advances — schedule the campaign and it goes out then.',
		};
	}

	const headline = `You can send to about ${readiness.today.toLocaleString()} ${readiness.today === 1 ? 'contact' : 'contacts'} today`;
	// A NON-POSITIVE SIZE IS AN UNKNOWN ONE, never an audience of zero. The
	// count is still loading on both surfaces that pass one (the wizard hands
	// over `... ?? 0` while its count query resolves), and an empty segment has
	// nothing to fit either — "your audience of 0 fits in today's capacity" would
	// be a claim about an audience nobody has chosen yet.
	const size = options.audienceSize ?? 0;
	const audienceSize = size > 0 ? size : null;
	// No audience yet (or a surface that never has one): the capacity figure and
	// the growth are the whole, honest answer.
	if (audienceSize === null) return { tone: 'ready', headline, detail: growth };

	const audience = audienceSize.toLocaleString();
	if (audienceSize <= readiness.today) {
		return {
			tone: 'ready',
			headline,
			detail: `Your audience of ${audience} fits in today's capacity.`,
		};
	}
	return {
		tone: 'paced',
		headline,
		// Capacity is a SCHEDULE, not a failure: the send is not blocked, it is
		// spread. The exact day count comes from the capacity plan panel beside
		// this note, which is the only surface that has measured it.
		detail: `Your audience of ${audience} is larger, so the rest is paced over the following days.${growth ? ` ${growth}` : ''}`,
	};
}
