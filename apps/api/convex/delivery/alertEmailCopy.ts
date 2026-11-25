/**
 * What the deliverability alert emails say, in the recipient's language: the
 * regression alert (`checklistAlerts.ts`) and the sending-hold alert
 * (`sendingHoldAlertEmail.ts`). Server-side for the reason
 * `lib/systemEmailCopy.ts` gives, keyed by `userProfiles.locale` and falling
 * back to English.
 *
 * Only Owlat's own sentences are translated. The text an alert carries from
 * its record (a regressed check's message, the reason stored with a hold) is
 * quoted as recorded, in English: the webhook and the Center show that same
 * text, and an operator matching the email against either needs it verbatim.
 *
 * Every function returns HTML-safe text except where a parameter is named
 * `html`: the caller escapes what it passes in.
 *
 * Not a Convex function module.
 */

import type { SendingHoldLift } from '@owlat/public-contract';
import type { AppLocale } from '@owlat/shared/appLocales';
import { systemEmailLocale } from '../lib/systemEmailCopy';
import { sendingHoldLiftSentence } from './sendingHoldLift';

type HoldStatus = 'suspended' | 'banned';

interface AlertEmailCopy {
	/** The line every alert email ends with: where else the alert went. */
	otherChannels: string;
	regressionSubject: string;
	regressionIntro: string;
	regressionOpen: string;
	holdSubject: (status: HoldStatus) => string;
	holdIntro: (status: HoldStatus, heldMailDays: number) => string;
	/** A raise while sending was already stopped: the status changed under it. */
	holdChangedSubject: (from: HoldStatus, to: HoldStatus) => string;
	holdChangedLine: (from: HoldStatus, to: HoldStatus) => string;
	reasonLine: (reasonHtml: string) => string;
	/** Whether and on what condition sending comes back, and who acts. */
	nextAction: (lift: SendingHoldLift) => string;
	holdOpen: string;
	resumedSubject: string;
	resumedAutomatic: (reasonHtml: string) => string;
	resumedManual: (reasonHtml: string) => string;
	resumedContinue: string;
}

/** "0,2 %": a percentage with the digits it has, the way German writes it. */
function pctDe(value: number): string {
	return `${Number(value.toFixed(3)).toLocaleString('de-DE')} %`;
}

function liftSentenceDe(lift: SendingHoldLift): string {
	if (lift.mode === 'admin') return 'Der Versand startet nicht von selbst wieder.';
	if (lift.mode === 'manual_setting') {
		return 'Der Versand startet nicht von selbst wieder: Diese Instanz wartet, bis ein Plattform-Admin die Sperre aufhebt, auch wenn sich die Raten erholt haben.';
	}
	const condition = lift.condition;
	if (!condition) {
		return 'Der Versand startet von selbst wieder, sobald die Rate dahinter wieder unter der Grenze liegt.';
	}
	if (condition.isClear) {
		return 'Die Rate dahinter liegt wieder unter der Grenze, deshalb startet der Versand bei der nächsten stündlichen Prüfung von selbst wieder.';
	}
	if (condition.trigger === 'gmail_spam_rate') {
		const leaves = condition.clearsAt
			? `; der letzte Wert darüber fällt am ${new Date(condition.clearsAt).toLocaleDateString('de-DE', { timeZone: 'UTC' })} aus dem Zeitraum`
			: '';
		return `Der Versand startet von selbst wieder, sobald in den letzten 30 Tagen keine Gmail-Spamrate für ${condition.domain ?? 'die Domain'} bei ${pctDe(condition.limitPct)} oder darüber liegt${leaves}.`;
	}
	const metric = condition.trigger === 'bounce_rate' ? 'Bounce-Rate' : 'Beschwerderate';
	const now =
		condition.currentPct === null ? '' : `; aktuell sind es ${pctDe(condition.currentPct)}`;
	return `Der Versand startet von selbst wieder, sobald die ${metric} der letzten 30 Tage unter ${pctDe(condition.limitPct)} liegt${now}.`;
}

const HOLD_WORD_DE: Record<HoldStatus, string> = {
	suspended: 'ausgesetzt',
	banned: 'gesperrt',
};

const COPY: Record<AppLocale, AlertEmailCopy> = {
	en: {
		otherChannels:
			'Owlat also shows this alert in the app, sends it as a push notification to admins who have push turned on, and sends it to any webhook subscribed to deliverability alerts.',
		regressionSubject: 'Owlat deliverability regression detected',
		regressionIntro: 'Owlat detected that a previously verified deliverability check regressed.',
		regressionOpen:
			'Open the Deliverability Center to review the live evidence and remediation guidance.',
		holdSubject: (status) => `Owlat: sending is ${status}`,
		holdIntro: (status, days) =>
			`Sending on your Owlat instance is ${status}. Campaigns and automation emails wait, and new transactional sends are refused, until it lifts. Mail that waits ${days} days or more can be dropped.`,
		holdChangedSubject: (_from, to) => `Owlat: sending is now ${to}`,
		holdChangedLine: (from, to) =>
			`Sending on your Owlat instance was ${from} and is now ${to}. It stays stopped.`,
		reasonLine: (reasonHtml) => `Reason: ${reasonHtml}`,
		// The English wording is the webhook's `nextAction`, so the two read the same.
		nextAction: (lift) => {
			const sentence = sendingHoldLiftSentence(lift);
			return lift.mode === 'automatic'
				? `${sentence} Nothing to do unless you want sending back sooner: a platform admin can lift it in the Operator console.`
				: `${sentence} A platform admin lifts it in the Operator console.`;
		},
		holdOpen: 'Open Delivery health in Owlat to see where the rates stand.',
		resumedSubject: 'Owlat: sending resumed',
		resumedAutomatic: (reasonHtml) =>
			`Sending on your Owlat instance resumed. The reputation check lifted the suspension by itself: ${reasonHtml}`,
		resumedManual: (reasonHtml) =>
			`Sending on your Owlat instance resumed. A platform admin lifted it: ${reasonHtml}`,
		resumedContinue:
			'Campaigns and automation emails that are still waiting continue where they stopped; nobody is mailed twice.',
	},
	de: {
		otherChannels:
			'Owlat zeigt diesen Alarm auch in der App an, schickt ihn als Push-Benachrichtigung an Admins, die Push eingeschaltet haben, und an jeden Webhook, der Zustellbarkeitsalarme abonniert hat.',
		regressionSubject: 'Owlat: Zustellbarkeit verschlechtert',
		regressionIntro:
			'Owlat hat erkannt, dass eine zuvor bestandene Zustellbarkeitsprüfung wieder fehlschlägt.',
		regressionOpen:
			'Unter Zustellbarkeit in Owlat siehst du die aktuellen Messwerte und wie du das Problem behebst.',
		holdSubject: (status) => `Owlat: Versand ${HOLD_WORD_DE[status]}`,
		holdIntro: (status, days) =>
			`Der Versand auf deiner Owlat-Instanz ist ${HOLD_WORD_DE[status]}. Kampagnen und Automations-E-Mails warten, und neue Transaktions-Mails werden abgelehnt, bis die Sperre aufgehoben ist. Mails, die ${days} Tage oder länger warten, können verworfen werden.`,
		holdChangedSubject: (_from, to) => `Owlat: Versand jetzt ${HOLD_WORD_DE[to]}`,
		holdChangedLine: (from, to) =>
			`Der Versand auf deiner Owlat-Instanz war ${HOLD_WORD_DE[from]} und ist jetzt ${HOLD_WORD_DE[to]}. Er bleibt gestoppt.`,
		reasonLine: (reasonHtml) => `Grund: ${reasonHtml}`,
		nextAction: (lift) => {
			const sentence = liftSentenceDe(lift);
			return lift.mode === 'automatic'
				? `${sentence} Du musst nichts tun, außer du willst den Versand früher zurück: Ein Plattform-Admin kann die Sperre in der Betreiberkonsole aufheben.`
				: `${sentence} Ein Plattform-Admin hebt die Sperre in der Betreiberkonsole auf.`;
		},
		holdOpen: 'Unter Zustellungsgesundheit in Owlat siehst du, wo die Raten stehen.',
		resumedSubject: 'Owlat: Versand wieder aktiv',
		resumedAutomatic: (reasonHtml) =>
			`Der Versand auf deiner Owlat-Instanz läuft wieder. Die Reputationsprüfung hat die Sperre von selbst aufgehoben: ${reasonHtml}`,
		resumedManual: (reasonHtml) =>
			`Der Versand auf deiner Owlat-Instanz läuft wieder. Ein Plattform-Admin hat die Sperre aufgehoben: ${reasonHtml}`,
		resumedContinue:
			'Kampagnen und Automations-E-Mails, die noch warten, machen dort weiter, wo sie gestoppt haben. Niemand bekommt eine Mail doppelt.',
	},
};

/** The alert email copy for a stored `userProfiles.locale`; absent or unknown is English. */
export function alertEmailCopy(locale: string | undefined): AlertEmailCopy {
	return COPY[systemEmailLocale(locale)];
}
