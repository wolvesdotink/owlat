/**
 * Delisting assistant: zone-specific removal guidance.
 *
 * "You are listed" is not a feature. Every zone has its own removal path, its
 * own idea of what caused the listing, and its own expectations of what a
 * removal request should say — so each one gets its own URL, its own likely
 * cause derived from OUR OWN recent metrics, and its own pre-filled request.
 *
 * Pure and browser-safe: the operator UI, the docs runbook, and the installer
 * all render the same copy.
 */

import type { IpAuditFinding, IpAuditZoneId, SpamhausSublist } from './ipAudit';

export interface DelistingMetrics {
	/** Hard bounces as a percentage of delivered mail in the recent window. */
	hardBouncePct?: number;
	/** Complaints as a percentage of delivered mail in the recent window. */
	complaintPct?: number;
	/** Messages this address sent in the last 24 hours. */
	sends24h?: number;
	/** Yesterday's volume multiplied by this equals today's; >3 is a spike. */
	volumeRampMultiplier?: number;
	/** Days this address has been sending at all. */
	sendingDays?: number;
}

export interface DelistingContext {
	ip: string;
	/** The sending hostname (EHLO) presented by this address. */
	ehlo?: string;
	/** Reply address for the removal request. */
	contactEmail?: string;
	metrics?: DelistingMetrics;
}

export interface DelistingTarget {
	zoneId: IpAuditZoneId;
	sublist?: SpamhausSublist;
}

export interface DelistingGuidance {
	/** Stable identity: `spamhaus:pbl`, `barracuda`, … */
	key: string;
	label: string;
	removalUrl: string;
	/** True when the operator can remove the listing without a human review. */
	selfService: boolean;
	/** What our own recent metrics suggest caused it. */
	likelyCause: string;
	/** Ready-to-paste request body. */
	prefilledRequest: string;
}

function pct(value: number): string {
	return `${Math.round(value * 100) / 100}%`;
}

/** Evidence drawn from our own sending, not from the blocklist's opinion. */
function metricEvidence(metrics: DelistingMetrics | undefined): string[] {
	if (!metrics) return [];
	const lines: string[] = [];
	if (typeof metrics.sends24h === 'number' && Number.isFinite(metrics.sends24h)) {
		lines.push(`${metrics.sends24h} messages sent from this address in the last 24 hours`);
	}
	if (typeof metrics.hardBouncePct === 'number' && Number.isFinite(metrics.hardBouncePct)) {
		lines.push(`hard bounce rate ${pct(metrics.hardBouncePct)}`);
	}
	if (typeof metrics.complaintPct === 'number' && Number.isFinite(metrics.complaintPct)) {
		lines.push(`complaint rate ${pct(metrics.complaintPct)}`);
	}
	if (
		typeof metrics.volumeRampMultiplier === 'number' &&
		Number.isFinite(metrics.volumeRampMultiplier)
	) {
		lines.push(`day-over-day volume x${Math.round(metrics.volumeRampMultiplier * 10) / 10}`);
	}
	return lines;
}

function complaintCause(metrics: DelistingMetrics | undefined, fallback: string): string {
	const complaint = metrics?.complaintPct;
	const bounce = metrics?.hardBouncePct;
	if (typeof complaint === 'number' && complaint >= 0.1) {
		return `Your complaint rate is ${pct(complaint)} — recipient complaints are the usual trigger for this list.`;
	}
	if (typeof bounce === 'number' && bounce >= 2) {
		return `Your hard bounce rate is ${pct(bounce)} — mail to dead addresses is the usual trigger for this list.`;
	}
	return fallback;
}

function rampCause(metrics: DelistingMetrics | undefined, fallback: string): string {
	const ramp = metrics?.volumeRampMultiplier;
	const days = metrics?.sendingDays;
	const sends = metrics?.sends24h;
	if (typeof ramp === 'number' && ramp >= 3) {
		return `Volume rose x${Math.round(ramp * 10) / 10} day over day — a sudden ramp from a young address is exactly this list's target.`;
	}
	if (typeof days === 'number' && days <= 14 && typeof sends === 'number' && sends >= 500) {
		return `This address is ${days} days old and sent ${sends} messages yesterday — too fast for a new IP.`;
	}
	return fallback;
}

function requestBody(context: DelistingContext, remediation: string[]): string {
	const evidence = metricEvidence(context.metrics);
	const lines = [
		`Removal request for ${context.ip}`,
		'',
		context.ehlo
			? `This address is a dedicated outbound mail server (${context.ehlo}) operated by us.`
			: 'This address is a dedicated outbound mail server operated by us.',
		'',
		'What we have done:',
		...remediation.map((step) => `- ${step}`),
	];
	if (evidence.length > 0) {
		lines.push(
			'',
			'Current measurements from our own logs:',
			...evidence.map((item) => `- ${item}`)
		);
	}
	if (context.contactEmail) {
		lines.push('', `Contact: ${context.contactEmail}`);
	}
	return lines.join('\n');
}

interface ZoneTemplate {
	label: string;
	removalUrl: string;
	selfService: boolean;
	fallbackCause: string;
	causeKind: 'complaint' | 'ramp' | 'static';
	remediation: readonly string[];
}

const SPAMHAUS_TEMPLATES: Record<SpamhausSublist, ZoneTemplate> = {
	pbl: {
		label: 'Spamhaus PBL',
		removalUrl: 'https://www.spamhaus.org/pbl/removal/',
		selfService: true,
		causeKind: 'static',
		fallbackCause:
			'Nothing you sent caused this. Your provider declares this range as dynamic or end-user space, so it is listed by default.',
		remediation: [
			'This address is statically assigned to us and used only for authenticated outbound mail.',
			'Reverse DNS is published and forward-confirms.',
			'Requesting a PBL exclusion for this single address.',
		],
	},
	css: {
		label: 'Spamhaus CSS',
		removalUrl: 'https://www.spamhaus.org/css/removal/',
		selfService: true,
		causeKind: 'ramp',
		fallbackCause:
			'CSS targets cold or snowshoe sending patterns: new address, sudden volume, or bursts spread across many addresses.',
		remediation: [
			'Paused the ramp and reduced daily volume on this address.',
			'Confirmed all recipients are confirmed opt-in with recorded consent.',
			'Verified SPF, DKIM, and DMARC alignment for every sending domain.',
		],
	},
	xbl: {
		label: 'Spamhaus XBL',
		removalUrl: 'https://www.spamhaus.org/xbl/removal/',
		selfService: true,
		causeKind: 'static',
		fallbackCause:
			'XBL means the host looked compromised: an open relay, an open proxy, or malware traffic seen from this address.',
		remediation: [
			'Audited the host for open relay and open proxy exposure; only authenticated submission is accepted.',
			'Confirmed no third-party software on this host originates mail.',
			'Rotated credentials for every account able to submit mail.',
		],
	},
	sbl: {
		label: 'Spamhaus SBL',
		removalUrl: 'https://www.spamhaus.org/sbl/removal/',
		selfService: false,
		causeKind: 'complaint',
		fallbackCause:
			'SBL is a manually reviewed listing for observed spam. Expect a human to read your request.',
		remediation: [
			'Removed the affected list segment and suppressed every complaining recipient.',
			'Enabled one-click unsubscribe on all bulk mail.',
			'Reviewed acquisition for the segment that generated complaints.',
		],
	},
	drop: {
		label: 'Spamhaus DROP',
		removalUrl: 'https://www.spamhaus.org/drop/',
		selfService: false,
		causeKind: 'static',
		fallbackCause:
			'The whole network block is listed as hijacked or wholly spam-operated. This is not about your sending.',
		remediation: [
			'This listing covers the network, not the address; only the network owner can resolve it.',
			'Requesting a different address outside the listed range from the provider.',
		],
	},
};

const ZONE_TEMPLATES: Record<Exclude<IpAuditZoneId, 'spamhaus'>, ZoneTemplate> = {
	barracuda: {
		label: 'Barracuda Reputation Block List',
		removalUrl: 'https://www.barracudacentral.org/rbl/removal-request',
		selfService: true,
		causeKind: 'complaint',
		fallbackCause:
			'Barracuda listings usually follow spam-trap hits or complaints reported by their appliances.',
		remediation: [
			'Suppressed every complaining and bouncing recipient.',
			'Confirmed reverse DNS and authentication for this address.',
		],
	},
	spamcop: {
		label: 'SpamCop Blocking List',
		removalUrl: 'https://www.spamcop.net/bl.shtml',
		selfService: true,
		causeKind: 'complaint',
		fallbackCause:
			'SpamCop listings expire on their own after a quiet period; they are driven by user reports and trap hits.',
		remediation: [
			'Suppressed the reporting recipients and paused the affected campaign.',
			'Confirmed unsubscribe handling completes within one send cycle.',
		],
	},
	sorbs: {
		label: 'SORBS',
		removalUrl: 'https://www.sorbs.net/delisting/',
		selfService: true,
		causeKind: 'static',
		fallbackCause:
			'SORBS lists ranges by policy as often as by behaviour; dynamic-range entries are common on VPS addresses.',
		remediation: [
			'This address is statically assigned and used only for outbound mail.',
			'Reverse DNS is published and forward-confirms.',
		],
	},
	invaluement: {
		label: 'Invaluement ivmSIP',
		removalUrl: 'https://www.invaluement.com/lookup/',
		selfService: false,
		causeKind: 'ramp',
		fallbackCause:
			'Invaluement targets senders whose lists look purchased or scraped rather than confirmed opt-in.',
		remediation: [
			'Documented consent capture for the affected segment.',
			'Removed every address without a recorded opt-in event.',
		],
	},
	abusix: {
		label: 'Abusix Mail Intelligence',
		removalUrl: 'https://lookup.abusix.com/',
		selfService: true,
		causeKind: 'complaint',
		fallbackCause:
			'Abusix listings usually follow spam-trap hits observed in their sensor network.',
		remediation: [
			'Suppressed the affected segment and re-verified list hygiene.',
			'Confirmed authentication and reverse DNS for this address.',
		],
	},
};

function templateFor(target: DelistingTarget): { key: string; template: ZoneTemplate } {
	if (target.zoneId === 'spamhaus') {
		const sublist = target.sublist ?? 'sbl';
		return { key: `spamhaus:${sublist}`, template: SPAMHAUS_TEMPLATES[sublist] };
	}
	return { key: target.zoneId, template: ZONE_TEMPLATES[target.zoneId] };
}

/** Build the removal URL, likely cause, and pre-filled request for one listing. */
export function delistingGuidanceFor(
	target: DelistingTarget,
	context: DelistingContext
): DelistingGuidance {
	const { key, template } = templateFor(target);
	const likelyCause =
		template.causeKind === 'complaint'
			? complaintCause(context.metrics, template.fallbackCause)
			: template.causeKind === 'ramp'
				? rampCause(context.metrics, template.fallbackCause)
				: template.fallbackCause;
	return {
		key,
		label: template.label,
		removalUrl: template.removalUrl,
		selfService: template.selfService,
		likelyCause,
		prefilledRequest: requestBody(context, [...template.remediation]),
	};
}

/** One guidance entry per listing an audit found, deduplicated and ordered. */
export function delistingGuidanceForFindings(
	findings: readonly IpAuditFinding[],
	context: DelistingContext
): DelistingGuidance[] {
	const guidance: DelistingGuidance[] = [];
	const seen = new Set<string>();
	for (const finding of findings) {
		if (!finding.zoneId) continue;
		if (finding.id === 'audit_incomplete') continue;
		const entry = delistingGuidanceFor(
			{ zoneId: finding.zoneId, ...(finding.sublist ? { sublist: finding.sublist } : {}) },
			context
		);
		if (seen.has(entry.key)) continue;
		seen.add(entry.key);
		guidance.push(entry);
	}
	return guidance;
}
