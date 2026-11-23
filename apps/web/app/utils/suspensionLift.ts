/**
 * How a suspended instance gets sending back, in words: the condition under
 * which it lifts by itself, or that a platform admin has to lift it, and what a
 * platform admin's lift pauses. Shared by the delivery hub's banner and the
 * operator console's status card so the two say the same thing.
 *
 * Pure: the backend's structured answer in, catalog keys with values out.
 */

import { formatDate, formatPercentage } from '~/utils/formatters';
import {
	resolveLocalized,
	type LocalizedText,
	type LocalizedTextI18n,
} from '~/utils/localizedText';

type TriggerCode = 'bounce_rate' | 'complaint_rate' | 'gmail_spam_rate';

/** `suspensionLift` as `getSendingOverview` and `getOrganizationDetail` report it. */
export type SuspensionLiftView =
	| {
			mode: 'automatic';
			code: TriggerCode;
			domain?: string;
			limit: number;
			current: number | null;
			isClear: boolean;
			clearsAt: number | null;
	  }
	| { mode: 'manual_setting' }
	| { mode: 'admin' };

/** What a platform admin's lift pauses (`getOrganizationDetail.settings.reputationCheckHold`). */
export interface ReputationCheckHoldView {
	until: number;
	triggers: ReadonlyArray<{ code: TriggerCode; domain?: string }>;
}

/** The sending part of `getOrganizationDetail.settings` the operator console shows. */
export interface SendingStatusView {
	suspensionLift?: SuspensionLiftView | null;
	reputationCheckHold?: ReputationCheckHoldView | null;
	isSendingResumeManual?: boolean;
}

/** A platform admin's lift pauses the check this long (`analytics/reputationResume.ts`). */
export const MANUAL_LIFT_HOLD_MS = 7 * 24 * 60 * 60 * 1000;

const PREFIX = 'shared.sendingSuspension';

/** "5%", "0.2%": a limit is written with the digits it has. */
function limitPercent(limit: number): string {
	return formatPercentage(limit, limit >= 0.01 ? 0 : 1);
}

export function suspensionLiftText(
	lift: SuspensionLiftView | null | undefined,
	locale: string
): LocalizedText | null {
	if (!lift) return null;
	if (lift.mode === 'admin') return `${PREFIX}.lift.admin`;
	if (lift.mode === 'manual_setting') return `${PREFIX}.lift.manualSetting`;
	if (lift.isClear) return `${PREFIX}.lift.cleared`;
	const params = { limit: limitPercent(lift.limit), current: formatPercentage(lift.current, 2) };
	if (lift.code === 'gmail_spam_rate') {
		return {
			key: `${PREFIX}.lift.gmail`,
			params: {
				...params,
				domain: lift.domain ?? '',
				date: lift.clearsAt !== null ? formatDate(lift.clearsAt, 'medium', locale) : '',
			},
		};
	}
	return {
		key: lift.code === 'bounce_rate' ? `${PREFIX}.lift.bounce` : `${PREFIX}.lift.complaint`,
		params,
	};
}

/** "The automatic check is paused for the bounce rate until 27 Nov 2026 …" */
export function reputationHoldText(
	i18n: LocalizedTextI18n,
	hold: ReputationCheckHoldView,
	locale: string
): string {
	const triggers = hold.triggers
		.map((trigger) =>
			resolveLocalized(i18n, {
				key: `${PREFIX}.trigger.${trigger.code}`,
				params: { domain: trigger.domain ?? '' },
			})
		)
		.join(', ');
	return i18n.t(`${PREFIX}.hold`, { triggers, date: formatDate(hold.until, 'medium', locale) });
}
