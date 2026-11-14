import type {
	EmailSendDoc,
	ReducerResult,
	SendRef,
	SendStatus,
	TransactionalSendDoc,
	TransitionInput,
} from './types';
import type { Effect } from './effects';

// Automated opens and clicks: fetches by a privacy proxy, a security scanner or
// a link checker. They are counted apart from reader engagement and never move
// the status. `reduceOpened` / `reduceClicked` in ./reducers route here once
// `delivery/automatedOpens.ts` / `delivery/automatedClicks.ts` classify the
// request as automated.

/**
 * An automated open. Counted per send (`automatedOpenCount`), and once per send
 * (`automatedOpenedAt` is the uniqueness gate) into the campaign's
 * `statsAutomatedOpened`, so the report can show how many emails were fetched
 * automatically.
 * A reader who opens after an automated fetch still counts as a first open.
 */
export function reduceAutomatedOpen(
	send: EmailSendDoc | TransactionalSendDoc,
	args: Extract<TransitionInput, { to: 'opened' }>,
	ref: SendRef,
	from: SendStatus
): ReducerResult {
	const isFirstAutomatedOpen = !send.automatedOpenedAt;
	const patch: Record<string, unknown> = {
		automatedOpenCount: (send.automatedOpenCount ?? 0) + 1,
	};
	const effects: Effect[] = [];
	if (isFirstAutomatedOpen) {
		patch['automatedOpenedAt'] = args.at;
		if (ref.kind === 'campaign') {
			effects.push({
				kind: 'campaign_stats_automated_opened',
				campaignId: (send as EmailSendDoc).campaignId,
			});
		}
	}
	return { patch, effects, applied: 'recorded', from, to: 'opened' };
}

/**
 * An automated click. Counted per send (`automatedClickCount`), and once per
 * send (`automatedClickedAt` is the uniqueness gate) into the campaign's
 * `statsAutomatedClicked`, so the report can show how many emails had their
 * links followed automatically.
 * A reader who clicks after a scanner still counts as a first click.
 */
export function reduceAutomatedClick(
	send: EmailSendDoc | TransactionalSendDoc,
	args: Extract<TransitionInput, { to: 'clicked' }>,
	ref: SendRef,
	from: SendStatus
): ReducerResult {
	const patch: Record<string, unknown> = {
		automatedClickCount: (send.automatedClickCount ?? 0) + 1,
	};
	const effects: Effect[] = [];
	if (!send.automatedClickedAt) {
		patch['automatedClickedAt'] = args.at;
		if (ref.kind === 'campaign') {
			effects.push({
				kind: 'campaign_stats_automated_clicked',
				campaignId: (send as EmailSendDoc).campaignId,
			});
		}
	}
	return { patch, effects, applied: 'recorded', from, to: 'clicked' };
}
