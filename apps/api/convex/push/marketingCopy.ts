/**
 * What a marketing Web Push notification says, in the recipient's language.
 *
 * Server-side for the same reason as `copy.ts` (the sender has no vue-i18n),
 * and worded like the in-app toasts (`shared.marketingNotices` in the web
 * catalogs) so the two surfaces read the same. A private notification (the
 * shared "hide message preview" switch) names no campaign, automation, domain
 * or correspondent: those names can say more than the person wants on a lock
 * screen.
 */

import type { AppLocale } from '@owlat/shared/appLocales';
import {
	DESTINATION_PROVIDER_KEYS,
	type DestinationProviderKey,
} from '@owlat/shared/deliverabilityRouting';
import type { Doc } from '../_generated/dataModel';
import { systemEmailLocale } from '../lib/systemEmailCopy';
import { campaignCancelUrl } from '../marketing/noticeUrls';
import type { PushPayload } from './copy';

interface MarketingCopy {
	finishedTitle: string;
	finishedBody: (name: string, percent: number | undefined) => string;
	finishedPrivate: string;
	reminderTitle: (minutes: number) => string;
	reminderPrivate: string;
	notStartedTitle: string;
	notStartedPrivate: string;
	holdTitle: string;
	holdBody: (provider: string) => string;
	providers: Record<DestinationProviderKey, string>;
	stalledTitle: string;
	stalledBody: (name: string, count: number) => string;
	stalledPrivate: string;
	pausedTitle: string;
	pausedBody: (name: string) => string;
	pausedPrivate: string;
	dnsTitle: string;
	dnsBody: (domain: string, check: string | undefined) => string;
	dnsPrivate: string;
	postmasterTitle: string;
	postmasterBody: (sender: string, address: string) => string;
	postmasterPrivate: string;
	open: string;
	cancelSend: string;
}

const COPY: Record<AppLocale, MarketingCopy> = {
	en: {
		finishedTitle: 'Campaign finished',
		finishedBody: (name, percent) =>
			percent === undefined ? `${name} has finished sending` : `${name} · ${percent}% delivered`,
		finishedPrivate: 'A campaign has finished sending',
		reminderTitle: (minutes) => `Scheduled campaign sends in ${minutes} min`,
		reminderPrivate: 'Open it to review or cancel the send',
		notStartedTitle: 'Scheduled campaign did not start',
		notStartedPrivate: 'A scheduled campaign is back in draft. Open it to see why',
		holdTitle: 'Bounce spike: sending protection on',
		holdBody: (provider) =>
			`Owlat is holding back mail to ${provider}, or rerouting it through your relay, after a spike in bounces or complaints`,
		providers: {
			gmail: 'Gmail',
			microsoft: 'Microsoft',
			yahoo: 'Yahoo',
			apple: 'Apple',
			other: 'other providers',
		},
		stalledTitle: 'Automation stalled',
		stalledBody: (name, count) =>
			count === 1 ? `${name}: 1 stalled contact` : `${name}: ${count} stalled contacts`,
		stalledPrivate: 'Contacts stalled in an automation',
		pausedTitle: 'Automation paused',
		pausedBody: (name) => `${name} paused itself after repeated failed runs`,
		pausedPrivate: 'An automation paused itself after repeated failed runs',
		dnsTitle: 'Sending domain DNS broken',
		dnsBody: (domain, check) =>
			check ? `${domain}: ${check} check failed` : `${domain}: a DNS check failed`,
		dnsPrivate: 'A DNS check of a sending domain failed',
		postmasterTitle: 'Postmaster mail',
		postmasterBody: (sender, address) => `${sender} wrote to ${address}`,
		postmasterPrivate: 'New mail to postmaster@ or abuse@',
		open: 'Open',
		cancelSend: 'Cancel send',
	},
	de: {
		finishedTitle: 'Kampagne abgeschlossen',
		finishedBody: (name, percent) =>
			percent === undefined ? `${name} ist fertig versendet` : `${name} · ${percent} % zugestellt`,
		finishedPrivate: 'Eine Kampagne ist fertig versendet',
		reminderTitle: (minutes) => `Geplante Kampagne startet in ${minutes} Min.`,
		reminderPrivate: 'Öffne sie, um den Versand zu prüfen oder abzubrechen',
		notStartedTitle: 'Geplante Kampagne nicht gestartet',
		notStartedPrivate:
			'Eine geplante Kampagne ist wieder ein Entwurf. Öffne sie, um den Grund zu sehen',
		holdTitle: 'Bounce-Spitze: Versandschutz aktiv',
		holdBody: (provider) =>
			`Owlat hält Mails an ${provider} nach vielen Bounces oder Beschwerden zurück oder leitet sie über dein Relay um`,
		providers: {
			gmail: 'Gmail',
			microsoft: 'Microsoft',
			yahoo: 'Yahoo',
			apple: 'Apple',
			other: 'andere Anbieter',
		},
		stalledTitle: 'Automation hängt',
		stalledBody: (name, count) =>
			count === 1 ? `${name}: 1 hängender Kontakt` : `${name}: ${count} hängende Kontakte`,
		stalledPrivate: 'Kontakte hängen in einer Automation',
		pausedTitle: 'Automation pausiert',
		pausedBody: (name) => `${name} hat sich nach wiederholt fehlgeschlagenen Läufen pausiert`,
		pausedPrivate: 'Eine Automation hat sich nach wiederholt fehlgeschlagenen Läufen pausiert',
		dnsTitle: 'DNS der Versanddomain fehlerhaft',
		dnsBody: (domain, check) =>
			check
				? `${domain}: Prüfung „${check}“ fehlgeschlagen`
				: `${domain}: eine DNS-Prüfung ist fehlgeschlagen`,
		dnsPrivate: 'Eine DNS-Prüfung einer Versanddomain ist fehlgeschlagen',
		postmasterTitle: 'Postmaster-Mail',
		postmasterBody: (sender, address) => `${sender} hat an ${address} geschrieben`,
		postmasterPrivate: 'Neue Mail an postmaster@ oder abuse@',
		open: 'Öffnen',
		cancelSend: 'Versand abbrechen',
	},
};

const MAX_TITLE = 80;
const MAX_BODY = 160;

function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	const chars = Array.from(flat);
	return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : flat;
}

function providerLabel(copy: MarketingCopy, provider: string | undefined): string {
	const key = DESTINATION_PROVIDER_KEYS.find((candidate) => candidate === provider) ?? 'other';
	return copy.providers[key];
}

/** Minutes left until a reminder's start, at least one. */
export function minutesUntil(scheduledAt: number, now: number): number {
	return Math.max(1, Math.round((scheduledAt - now) / 60_000));
}

/** The push for one stored marketing notice. */
export function marketingPayload(
	notice: Doc<'marketingNotices'>,
	locale: string | undefined,
	isPrivate: boolean,
	now: number
): PushPayload {
	const copy = COPY[systemEmailLocale(locale)];
	const name = clip(notice.name ?? '', 60);
	const tag = `marketing:${notice.subjectKey}`;
	const base = { tag, url: notice.url };
	switch (notice.kind) {
		case 'campaign_finished':
			return {
				...base,
				title: copy.finishedTitle,
				body: isPrivate
					? copy.finishedPrivate
					: clip(copy.finishedBody(name, notice.percent), MAX_BODY),
			};
		case 'campaign_reminder':
			return {
				...base,
				title: clip(copy.reminderTitle(minutesUntil(notice.scheduledAt ?? now, now)), MAX_TITLE),
				body: isPrivate ? copy.reminderPrivate : name,
				actions: [
					{ action: 'open', title: copy.open, url: notice.url },
					...(notice.campaignId
						? [
								{
									action: 'cancel',
									title: copy.cancelSend,
									url: campaignCancelUrl(notice.campaignId),
								},
							]
						: []),
				],
			};
		case 'campaign_not_started':
			return {
				...base,
				title: copy.notStartedTitle,
				body: isPrivate ? copy.notStartedPrivate : name,
			};
		case 'delivery_hold':
			return {
				...base,
				title: copy.holdTitle,
				body: clip(copy.holdBody(providerLabel(copy, notice.name)), MAX_BODY),
			};
		case 'automation_stalled':
			return {
				...base,
				title: copy.stalledTitle,
				body: isPrivate
					? copy.stalledPrivate
					: clip(copy.stalledBody(name, notice.count ?? 0), MAX_BODY),
			};
		case 'automation_paused':
			return {
				...base,
				title: copy.pausedTitle,
				body: isPrivate ? copy.pausedPrivate : clip(copy.pausedBody(name), MAX_BODY),
			};
		case 'domain_dns':
			return {
				...base,
				title: copy.dnsTitle,
				body: isPrivate ? copy.dnsPrivate : clip(copy.dnsBody(name, notice.detail), MAX_BODY),
			};
		case 'postmaster_mail':
			return {
				...base,
				title: copy.postmasterTitle,
				body: isPrivate
					? copy.postmasterPrivate
					: clip(copy.postmasterBody(clip(notice.detail ?? '', 60), name), MAX_BODY),
			};
	}
}
