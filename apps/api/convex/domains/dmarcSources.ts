/**
 * Who is sending as a domain — the pure half of the DMARC report dashboard.
 *
 * Takes the stored report rows (`dmarcReportRecords`) and folds them into what
 * an operator needs: daily volume and DMARC pass rate, the sending sources
 * grouped by organisation and flagged as Owlat's own MTA, a known third-party
 * sender or unknown, failing sources first, and how many days in a row the
 * domain has stayed at or above the enforcement threshold.
 *
 * Identification is deliberately cheap: our own pool IPs and EHLO name, a
 * forward-confirmed reverse DNS name (resolved after ingest by
 * `dmarcReportsNode.ts`), and the domains that PASSED DKIM or SPF for a row,
 * matched against a short table of the senders most organisations use. No
 * network here; `dmarcReports.ts:getDomainSummary` passes everything in.
 */

import { trySplitZone } from '@owlat/shared/dnsZone';
import { denseDailySeries, utcDayKey } from '../lib/clock';
import { DAY_MS } from '../lib/constants';

/** Days in a row at or above {@link READY_ALIGNED_RATE} before we call a step safe. */
export const READY_STREAK_DAYS = 14;
/** Share of a day's mail that must pass DMARC for the day to count. */
export const READY_ALIGNED_RATE = 0.99;
/** Readiness always looks this far back, whatever window the dashboard shows. */
export const READINESS_WINDOW_DAYS = 30;
/** Sources returned to the dashboard, failing first. */
const MAX_SOURCES = 50;
const MAX_SOURCE_IPS = 5;

export type DmarcSourceKind = 'owlat' | 'known' | 'unknown';

interface KnownSender {
	id: string;
	name: string;
	/** Registrable domains of its PTR names, DKIM `d=` domains and bounce domains. */
	domains: readonly string[];
}

/**
 * Senders common enough that recognising them saves the operator a lookup.
 * Matched on registrable domains only (`*.outbound.protection.outlook.com` →
 * `outlook.com`), so the table stays short and needs no wildcard grammar.
 */
const KNOWN_SENDERS: readonly KnownSender[] = [
	{ id: 'google', name: 'Google', domains: ['google.com', 'googlemail.com', 'gmail.com'] },
	{
		id: 'microsoft',
		name: 'Microsoft 365',
		domains: ['outlook.com', 'onmicrosoft.com', 'hotmail.com', 'office365.com'],
	},
	{ id: 'amazonses', name: 'Amazon SES', domains: ['amazonses.com'] },
	{ id: 'sendgrid', name: 'SendGrid', domains: ['sendgrid.net', 'sendgrid.com'] },
	{ id: 'mailgun', name: 'Mailgun', domains: ['mailgun.org', 'mailgun.net'] },
	{
		id: 'mailchimp',
		name: 'Mailchimp',
		domains: ['mcsv.net', 'mcdlv.net', 'rsgsv.net', 'mandrillapp.com', 'mailchimpapp.net'],
	},
	{ id: 'postmark', name: 'Postmark', domains: ['mtasv.net', 'postmarkapp.com'] },
	{ id: 'sparkpost', name: 'SparkPost', domains: ['sparkpostmail.com', 'sparkpost.com'] },
	{ id: 'brevo', name: 'Brevo', domains: ['sendinblue.com', 'brevo.com', 'sendibm1.com'] },
	{ id: 'mailjet', name: 'Mailjet', domains: ['mailjet.com'] },
	{ id: 'hubspot', name: 'HubSpot', domains: ['hubspotemail.net', 'hubspot.com'] },
	{ id: 'salesforce', name: 'Salesforce', domains: ['exacttarget.com', 'salesforce.com'] },
	{ id: 'zendesk', name: 'Zendesk', domains: ['zendesk.com'] },
	{ id: 'zoho', name: 'Zoho', domains: ['zoho.com', 'zoho.eu', 'zohomail.com'] },
	{ id: 'fastmail', name: 'Fastmail', domains: ['messagingengine.com', 'fastmail.com'] },
	{ id: 'proton', name: 'Proton Mail', domains: ['protonmail.ch', 'proton.me'] },
	{ id: 'yahoo', name: 'Yahoo', domains: ['yahoo.com', 'yahoodns.net'] },
];

const KNOWN_BY_DOMAIN = new Map<string, KnownSender>(
	KNOWN_SENDERS.flatMap((sender) => sender.domains.map((domain) => [domain, sender] as const))
);

function registrable(host: string): string {
	return trySplitZone(host)?.registrable ?? host;
}

/** The slice of a stored row identification and the roll-up read. */
export interface DmarcSourceRow {
	sourceIp: string;
	sourceHost?: string;
	count: number;
	rangeBeginMs: number;
	disposition: 'none' | 'quarantine' | 'reject';
	isDkimAligned: boolean;
	isSpfAligned: boolean;
	dkimResults: ReadonlyArray<{ domain: string; result: string }>;
	spfResults: ReadonlyArray<{ domain: string; result: string }>;
	overrideReasons: readonly string[];
}

/** What this deployment knows about its own sending infrastructure. */
export interface OwnInfrastructure {
	ips: ReadonlySet<string>;
	hosts: ReadonlySet<string>;
}

interface SourceIdentity {
	key: string;
	kind: DmarcSourceKind;
	/** Provider name, registrable domain of the PTR name, or the bare IP. */
	label: string;
}

/** Which organisation a row's mail came from. */
export function identifySource(row: DmarcSourceRow, own: OwnInfrastructure): SourceIdentity {
	const host = row.sourceHost?.toLowerCase();
	if (own.ips.has(row.sourceIp) || (host !== undefined && own.hosts.has(host))) {
		return { key: 'owlat', kind: 'owlat', label: 'Owlat' };
	}
	const hostOrg = host ? registrable(host) : undefined;
	const passedDomains = [...row.dkimResults, ...row.spfResults]
		.filter((result) => result.result === 'pass')
		.map((result) => registrable(result.domain));
	for (const domain of [hostOrg, ...passedDomains]) {
		const sender = domain ? KNOWN_BY_DOMAIN.get(domain) : undefined;
		if (sender) return { key: `known:${sender.id}`, kind: 'known', label: sender.name };
	}
	if (hostOrg) return { key: `host:${hostOrg}`, kind: 'unknown', label: hostOrg };
	return { key: `ip:${row.sourceIp}`, kind: 'unknown', label: row.sourceIp };
}

export interface DmarcSourceSummary {
	key: string;
	kind: DmarcSourceKind;
	label: string;
	messageCount: number;
	alignedCount: number;
	failingCount: number;
	dkimAlignedCount: number;
	spfAlignedCount: number;
	/** Messages receivers quarantined or rejected under the published policy. */
	enforcedCount: number;
	ipCount: number;
	/** Busiest IPs first, at most five. */
	topIps: string[];
	overrideReasons: string[];
}

export interface DmarcDailyPoint {
	date: string;
	messageCount: number;
	alignedCount: number;
}

export interface DmarcReadiness {
	/** Most recent days in a row (days with reports) at or above the threshold. */
	streakDays: number;
	requiredDays: number;
	/** Rate of the most recent day with reports, or null when there is none. */
	latestAlignedRate: number | null;
	isReady: boolean;
}

export interface DmarcRollup {
	messageCount: number;
	alignedCount: number;
	alignedRate: number | null;
	enforcedCount: number;
	trend: DmarcDailyPoint[];
	sources: DmarcSourceSummary[];
	sourceCount: number;
	readiness: DmarcReadiness;
}

function isAligned(row: DmarcSourceRow): boolean {
	return row.isDkimAligned || row.isSpfAligned;
}

/**
 * Days in a row, newest first, whose mail passed DMARC at or above the
 * threshold. Days without any report are skipped rather than counted or
 * breaking the run: receivers do not report every day for a quiet domain.
 */
export function readinessFrom(trend: readonly DmarcDailyPoint[]): DmarcReadiness {
	let streakDays = 0;
	let latestAlignedRate: number | null = null;
	for (let i = trend.length - 1; i >= 0; i--) {
		const point = trend[i];
		if (!point || point.messageCount === 0) continue;
		const rate = point.alignedCount / point.messageCount;
		latestAlignedRate ??= rate;
		if (rate < READY_ALIGNED_RATE) break;
		streakDays++;
	}
	return {
		streakDays,
		requiredDays: READY_STREAK_DAYS,
		latestAlignedRate,
		isReady: streakDays >= READY_STREAK_DAYS,
	};
}

/**
 * Fold stored rows into the dashboard roll-up for a window ending at `now`.
 * `rows` should span at least {@link READINESS_WINDOW_DAYS}, so the readiness
 * streak does not shrink to a short display window.
 */
export function rollUpDmarcRows(
	rows: readonly DmarcSourceRow[],
	own: OwnInfrastructure,
	windowDays: number,
	now: number
): DmarcRollup {
	const cutoff = now - windowDays * DAY_MS;
	const messagesByDay = new Map<string, number>();
	const alignedByDay = new Map<string, number>();
	const groups = new Map<string, DmarcSourceSummary & { ipCounts: Map<string, number> }>();
	let messageCount = 0;
	let alignedCount = 0;
	let enforcedCount = 0;

	for (const row of rows) {
		const aligned = isAligned(row) ? row.count : 0;
		// Daily totals cover every row passed in (the caller reads at least the
		// readiness window); the window totals and sources only the shown window.
		const day = utcDayKey(row.rangeBeginMs);
		messagesByDay.set(day, (messagesByDay.get(day) ?? 0) + row.count);
		alignedByDay.set(day, (alignedByDay.get(day) ?? 0) + aligned);
		if (row.rangeBeginMs < cutoff) continue;
		const enforced = row.disposition === 'none' ? 0 : row.count;
		messageCount += row.count;
		alignedCount += aligned;
		enforcedCount += enforced;

		const identity = identifySource(row, own);
		const group = groups.get(identity.key) ?? {
			...identity,
			messageCount: 0,
			alignedCount: 0,
			failingCount: 0,
			dkimAlignedCount: 0,
			spfAlignedCount: 0,
			enforcedCount: 0,
			ipCount: 0,
			topIps: [],
			overrideReasons: [],
			ipCounts: new Map<string, number>(),
		};
		group.messageCount += row.count;
		group.alignedCount += aligned;
		group.failingCount += row.count - aligned;
		group.dkimAlignedCount += row.isDkimAligned ? row.count : 0;
		group.spfAlignedCount += row.isSpfAligned ? row.count : 0;
		group.enforcedCount += enforced;
		group.ipCounts.set(row.sourceIp, (group.ipCounts.get(row.sourceIp) ?? 0) + row.count);
		for (const reason of row.overrideReasons) {
			if (!group.overrideReasons.includes(reason)) group.overrideReasons.push(reason);
		}
		groups.set(identity.key, group);
	}

	const dailySeries = (days: number): DmarcDailyPoint[] =>
		denseDailySeries(messagesByDay, days, now).map((point) => ({
			date: point.date,
			messageCount: point.count,
			alignedCount: alignedByDay.get(point.date) ?? 0,
		}));
	const trend = dailySeries(windowDays);

	const sources = Array.from(groups.values())
		.map(({ ipCounts, ...group }) => ({
			...group,
			ipCount: ipCounts.size,
			topIps: Array.from(ipCounts.entries())
				.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
				.slice(0, MAX_SOURCE_IPS)
				.map(([ip]) => ip),
		}))
		.sort((a, b) => b.failingCount - a.failingCount || b.messageCount - a.messageCount);

	return {
		messageCount,
		alignedCount,
		alignedRate: messageCount > 0 ? alignedCount / messageCount : null,
		enforcedCount,
		trend,
		sources: sources.slice(0, MAX_SOURCES),
		sourceCount: sources.length,
		readiness: readinessFrom(dailySeries(Math.max(windowDays, READINESS_WINDOW_DAYS))),
	};
}
