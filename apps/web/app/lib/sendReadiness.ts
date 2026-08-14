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

import { CAPACITY_DAY_MS, formatCapacityDay } from "~/lib/campaignCapacityRefusal";

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
export type SendReadinessTone = "ready" | "paced" | "waiting";

/**
 * One line of the note, as a catalog KEY (with its parameters when it has any).
 * This module is imported at module scope by surfaces that render it, so it
 * never calls `useI18n`; `components/campaigns/SendReadinessNote.vue` turns
 * these into words.
 */
export type ReadinessMessage = string | { key: string; params?: Record<string, unknown> };

export interface SendReadinessNote {
	tone: SendReadinessTone;
	headline: ReadinessMessage;
	/** The second line, or `null` when the headline says all there is. */
	detail: ReadinessMessage | null;
}

/**
 * The two reasons a missing cap is REASSURANCE rather than ignorance: overflow
 * to a verified relay absorbs the tail, or campaigns do not dispatch through the
 * warm-up-capped own MTA at all. Every other reason (`dispatch_unknown`,
 * `no_projection`, `measurement_failed`) means we could not measure, and the
 * honest render for that is nothing at all.
 */
const UNCAPPED_DETAIL: Readonly<Record<string, string>> = {
	warmup_overflow_absorbs: "shared.sendReadiness.uncapped.warmupOverflowAbsorbs",
	not_own_mta: "shared.sendReadiness.uncapped.notOwnMta",
};

/**
 * The projected growth, split into the two sentences the catalog carries —
 * "tomorrow" when `growsAt` starts the next UTC day after `now`, else the day by
 * name. `null` when no growth is projected.
 *
 * The variant travels with the parameters because the paced detail says the same
 * thing in ONE sentence pair, and gluing two translated halves together is not a
 * sentence any translator can move the words around in.
 */
type Growth = { variant: "tomorrow" | "onDate"; params: Record<string, unknown> };

function growth(
	readiness: Extract<SendingReadiness, { capped: true }>,
	now: number,
	locale?: string,
): Growth | null {
	const { growsTo, growsAt } = readiness;
	if (growsTo === null || growsAt === null) return null;
	const count = growsTo.toLocaleString(locale);
	const dayZero = Math.floor(now / CAPACITY_DAY_MS) * CAPACITY_DAY_MS;
	if (growsAt - dayZero === CAPACITY_DAY_MS) return { variant: "tomorrow", params: { count } };
	return {
		variant: "onDate",
		params: { count, date: formatCapacityDay(growsAt, "short") },
	};
}

/** The growth on its own line. */
function growthMessage(value: Growth | null): ReadinessMessage | null {
	if (!value) return null;
	return { key: `shared.sendReadiness.growth.${value.variant}`, params: value.params };
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
	options: { audienceSize?: number | null; now: number; locale?: string },
): SendReadinessNote | null {
	if (!readiness) return null;

	if (!readiness.capped) {
		const detail = UNCAPPED_DETAIL[readiness.reason];
		if (!detail) return null;
		return { tone: "ready", headline: "shared.sendReadiness.uncapped.headline", detail };
	}

	const projected = growth(readiness, options.now, options.locale);

	if (readiness.today <= 0) {
		return {
			tone: "waiting",
			headline: "shared.sendReadiness.spent.headline",
			detail: growthMessage(projected) ?? "shared.sendReadiness.spent.detail",
		};
	}

	const headline: ReadinessMessage = {
		key:
			readiness.today === 1
				? "shared.sendReadiness.capacity.one"
				: "shared.sendReadiness.capacity.other",
		params: { count: readiness.today.toLocaleString(options.locale) },
	};
	// A NON-POSITIVE SIZE IS AN UNKNOWN ONE, never an audience of zero. The
	// count is still loading on both surfaces that pass one (the wizard hands
	// over `... ?? 0` while its count query resolves), and an empty segment has
	// nothing to fit either — "your audience of 0 fits in today's capacity" would
	// be a claim about an audience nobody has chosen yet.
	const size = options.audienceSize ?? 0;
	const audienceSize = size > 0 ? size : null;
	// No audience yet (or a surface that never has one): the capacity figure and
	// the growth are the whole, honest answer.
	if (audienceSize === null) return { tone: "ready", headline, detail: growthMessage(projected) };

	const audience = audienceSize.toLocaleString(options.locale);
	if (audienceSize <= readiness.today) {
		return {
			tone: "ready",
			headline,
			detail: { key: "shared.sendReadiness.audienceFits", params: { audience } },
		};
	}
	return {
		tone: "paced",
		headline,
		// Capacity is a SCHEDULE, not a failure: the send is not blocked, it is
		// spread. The exact day count comes from the capacity plan panel beside
		// this note, which is the only surface that has measured it. The growth is
		// part of the same message rather than a second sentence appended to it,
		// so a translation can order the two as its language wants.
		detail: projected
			? {
					key:
						projected.variant === "tomorrow"
							? "shared.sendReadiness.paced.detailGrowsTomorrow"
							: "shared.sendReadiness.paced.detailGrowsOnDate",
					params: { audience, ...projected.params },
				}
			: { key: "shared.sendReadiness.paced.detail", params: { audience } },
	};
}
