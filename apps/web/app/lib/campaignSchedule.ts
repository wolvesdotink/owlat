/**
 * The ONE derivation of a campaign's chosen send start from the two form
 * controls that express it (a `<input type="date">` value and a
 * `<input type="time">` value).
 *
 * Three call sites depend on this answer agreeing with itself: the
 * `scheduledAt` argument the schedule/reschedule mutations persist (and which
 * the BINDING capacity gate anchors on), the pre-submit validation, and the
 * capacity PREVIEW query in the campaign editor. `getCampaignCapacityPlan`'s
 * contract is that the preview and the gate must never give the operator two
 * different answers, so all three must be asking about the same instant. That
 * is why the parse lives here as a pure function with its own fixtures rather
 * than as hand-synced copies at each site.
 *
 * Both inputs are interpreted in the VIEWER's timezone, which is what the form
 * shows and therefore what the operator means.
 *
 * @param date `YYYY-MM-DD`, or an empty string when unset.
 * @param time `HH:MM`, or an empty string when unset.
 * @param now Epoch ms to judge "in the past" against (injected, never read).
 *   A non-finite clock cannot decide the question, so it yields `null` rather
 *   than letting `at <= NaN` (which is false) wave a start through unchecked.
 * @returns Epoch ms, or `null` when the start is unset, unparseable or not
 *   strictly in the future.
 */
export function parseScheduledStart(date: string, time: string, now: number): number | null {
	if (!date || !time || !Number.isFinite(now)) return null;
	const at = new Date(`${date}T${time}`).getTime();
	if (!Number.isFinite(at) || at <= now) return null;
	return at;
}
