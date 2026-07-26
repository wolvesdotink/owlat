import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	ADAPTIVE_WARMING_POLICY,
	BASE_WARMING_SCHEDULE,
	getWarmingCapForDay,
} from '../../../packages/shared/src/warming';
import { PROVIDER_SPAM_RATE_POLICY } from '../../../packages/shared/src/reputation';
import {
	GMAIL_BULK_SENDER_THRESHOLD,
	GMAIL_PROXIMITY_WARNING_THRESHOLD,
	UNSUBSCRIBE_HONOR_WINDOW_MS,
} from '../../../packages/shared/src/deliverabilityPolicy';
import { DESTINATION_PROVIDER_PROFILES } from '../../mta/src/config';
import {
	COMPLAINT_FAST_THRESHOLD,
	COMPLAINT_SLOW_THRESHOLD,
	COOLDOWN_MS,
	FAST_THRESHOLD,
	FAST_WINDOW,
	SLOW_THRESHOLD,
	SLOW_WINDOW,
} from '../../mta/src/intelligence/circuitBreakerOutcomeStore';
import {
	CAMPAIGN_COMPLAINT_THRESHOLD,
	CAMPAIGN_MIN_DELIVERIES,
} from '../../mta/src/intelligence/campaignComplaintRate';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const readRepoFile = (path: string) => readFileSync(resolve(repoRoot, path), 'utf8');

const vpsGuide = readRepoFile('apps/docs/content/1.guide/51.sending-from-a-vps.md');
const deliverabilityGuide = readRepoFile('apps/docs/content/1.guide/21.deliverability.md');
const infrastructure = readRepoFile(
	'apps/docs/content/3.developer/19.deliverability-infrastructure.md'
);
const mtaSystem = readRepoFile('apps/docs/content/3.developer/10.mta-system.md');
const sidebar = readRepoFile('apps/docs/app/utils/sidebarConfig.ts');

function markedTable(document: string, marker: string): string {
	const markerIndex = document.indexOf(`<!-- deliverability-policy:${marker} -->`);
	expect(markerIndex, `missing ${marker} policy table`).toBeGreaterThanOrEqual(0);
	const afterMarker = document.slice(markerIndex);
	const nextHeading = afterMarker.indexOf('\n##');
	return nextHeading === -1 ? afterMarker : afterMarker.slice(0, nextHeading);
}

function formatCount(value: number): string {
	return value.toLocaleString('en-US');
}

function formatRate(value: number): string {
	return `${Number((value * 100).toFixed(4))}%`;
}

function expectRate(document: string, expectedRate: number): void {
	const renderedRates = [...document.matchAll(/(\d+(?:\.\d+)?)%/g)].map(
		(match) => Number(match[1]) / 100
	);
	expect(renderedRates).toContain(expectedRate);
}

function expectTextInOrder(document: string, values: readonly string[]): void {
	let cursor = -1;
	for (const value of values) {
		const next = document.indexOf(value, cursor + 1);
		expect(next, `missing or out-of-order text: ${value}`).toBeGreaterThan(cursor);
		cursor = next;
	}
}

function expectMarkdownRow(document: string, expectedCells: readonly string[]): void {
	const rows = document
		.split('\n')
		.filter((line) => line.trim().startsWith('|'))
		.map((line) =>
			line
				.split('|')
				.slice(1, -1)
				.map((cell) => cell.trim())
		);
	expect(rows).toContainEqual(expectedCells);
}

describe('Sending from a VPS navigation and claims', () => {
	it('uses the next numbered guide slot and is ordered after Deliverability', () => {
		expect(vpsGuide).toMatch(/^---\ntitle: "Sending from a VPS"/);
		expectTextInOrder(sidebar, [
			"{ label: 'Deliverability', to: '/guide/deliverability' }",
			"{ label: 'Sending from a VPS', to: '/guide/sending-from-a-vps' }",
		]);
	});

	it('links every shipped readiness and recovery surface used by the checklist', () => {
		for (const path of [
			'/developer/self-hosting-dns-email',
			'/developer/self-hosting-production',
			'/guide/deliverability',
			'/developer/external-reputation-feedback',
			'/developer/dnsbl-delisting',
			'/developer/mta-system',
			'/developer/providers',
		]) {
			expect(vpsGuide).toContain(`](${path}`);
		}
	});

	it('does not turn a volume heuristic into a universal relay threshold', () => {
		expect(vpsGuide).toMatch(/no universal monthly-volume number/i);
		expect(vpsGuide).not.toMatch(/100,?000.{0,40}(threshold|cutoff|below)/i);
	});

	it('states only provider capabilities backed by the cited official pages', () => {
		expect(vpsGuide).toMatch(/DigitalOcean.{0,120}ports 25, 465, and 587 are blocked/is);
		expect(vpsGuide).toMatch(/Hetzner.{0,180}case-by-case/is);
		expect(vpsGuide).toMatch(/OVHcloud VPS.{0,160}ask support/is);
		expect(vpsGuide).toMatch(/do not document reverse-zone delegation/i);
	});
});

describe('warm-up documentation follows shipped policy', () => {
	const warmingTable = markedTable(vpsGuide, 'warming-weeks');
	const adaptationTable = markedTable(vpsGuide, 'warming-adaptation');

	it('contains every checked-in base schedule checkpoint', () => {
		for (const { day, cap } of BASE_WARMING_SCHEDULE) {
			if (Number.isFinite(cap)) {
				expect(warmingTable.toLowerCase()).toContain(
					`day ${day}: ${formatCount(cap)}`.toLowerCase()
				);
			} else {
				expect(warmingTable).toContain(`Day ${day}+`);
				expect(warmingTable).toMatch(/health gate passes/i);
			}
		}
	});

	it('keeps the established MTA-system table on the same shared schedule', () => {
		for (const { day, cap } of BASE_WARMING_SCHEDULE) {
			const renderedCap = Number.isFinite(cap) ? formatCount(cap) : 'Unlimited (graduated)';
			expect(mtaSystem).toContain(`| ${day}${Number.isFinite(cap) ? '' : '+'} | ${renderedCap} |`);
		}
	});

	it('documents the adaptive boundaries from the shared policy', () => {
		const { acceleration, deceleration, halt, graduation } = ADAPTIVE_WARMING_POLICY;
		for (const rate of [
			acceleration.bounceRateExclusiveMax,
			acceleration.deferralRateExclusiveMax,
			deceleration.bounceRateExclusiveMin,
			deceleration.deferralRateExclusiveMin,
			halt.bounceRateExclusiveMin,
			halt.deferralRateExclusiveMin,
			graduation.bounceRateExclusiveMax,
		]) {
			expect(adaptationTable).toContain(formatRate(rate));
		}
		expect(adaptationTable).toContain(formatRate(acceleration.usageRateMinimum));
		expect(adaptationTable).toContain(
			`${formatRate(1 - deceleration.capMultiplier).replace('%', '')}%`
		);
		expect(adaptationTable).toContain(formatCount(deceleration.minimumCap));
		expect(adaptationTable).toContain(`day ${graduation.minimumScheduleDay}+`);
	});

	it('describes checkpoints as adaptive state rather than guaranteed calendar throughput', () => {
		expect(vpsGuide).toMatch(/warming day.*not a guaranteed calendar date/is);
		expect(vpsGuide).toMatch(/day with no sends does not advance/i);
		expect(getWarmingCapForDay(BASE_WARMING_SCHEDULE[0]!.day)).toBe(BASE_WARMING_SCHEDULE[0]!.cap);
	});
});

describe('provider and internal thresholds cannot drift from code', () => {
	const providerControls = markedTable(infrastructure, 'provider-controls');
	const breakerTable = markedTable(infrastructure, 'circuit-breaker');
	const profileTable = markedTable(infrastructure, 'isp-profiles');
	const requirementTable = markedTable(deliverabilityGuide, 'mailbox-requirements');

	it('pins Gmail proximity, bulk, spam, campaign, and unsubscribe values', () => {
		for (const document of [providerControls, requirementTable]) {
			expect(document).toContain(formatCount(GMAIL_BULK_SENDER_THRESHOLD));
			expectRate(document, PROVIDER_SPAM_RATE_POLICY.hardThreshold);
		}
		expect(providerControls).toContain(formatCount(GMAIL_PROXIMITY_WARNING_THRESHOLD));
		expectRate(providerControls, PROVIDER_SPAM_RATE_POLICY.target);
		expectRate(providerControls, CAMPAIGN_COMPLAINT_THRESHOLD);
		expect(providerControls).toContain(formatCount(CAMPAIGN_MIN_DELIVERIES));
		expect(providerControls).toContain(`${UNSUBSCRIBE_HONOR_WINDOW_MS / (60 * 60 * 1000)} hours`);
	});

	it('pins every real-time circuit-breaker boundary', () => {
		for (const [window, threshold] of [
			[FAST_WINDOW, FAST_THRESHOLD],
			[SLOW_WINDOW, SLOW_THRESHOLD],
			[FAST_WINDOW, COMPLAINT_FAST_THRESHOLD],
			[SLOW_WINDOW, COMPLAINT_SLOW_THRESHOLD],
		] as const) {
			expect(breakerTable).toContain(`Last ${formatCount(window)} outcomes`);
			expectRate(breakerTable, threshold);
		}
		expect(infrastructure).toContain(`${COOLDOWN_MS / (60 * 1000)} minutes`);
	});

	it('renders the checked-in destination-provider profile defaults', () => {
		const labels = {
			gmail: ['Gmail', 'Required'],
			microsoft: ['Microsoft', 'Opportunistic'],
			yahoo: ['Yahoo', 'Opportunistic'],
			apple: ['Apple', 'Opportunistic'],
			__default__: ['Other', 'Opportunistic'],
		} as const;

		for (const [providerKey, [label, tlsLabel]] of Object.entries(labels)) {
			const profile = DESTINATION_PROVIDER_PROFILES[providerKey]!;
			expectMarkdownRow(profileTable, [
				label,
				`${profile.defaultRate} / ${profile.ceiling} / ${profile.floor}`,
				tlsLabel,
				String(profile.maxConnections),
				String(profile.maxDeliveriesPerConnection),
			]);
		}
	});
});

describe('provider-policy qualifications remain explicit', () => {
	it('distinguishes Gmail, Yahoo, and Owlat complaint-rate denominators', () => {
		expect(deliverabilityGuide).toMatch(/Google calculates.*daily/is);
		expect(deliverabilityGuide).toMatch(/Yahoo uses messages delivered to the inbox/i);
		expect(deliverabilityGuide).toMatch(/not a reproduction of\s+either provider/is);
	});

	it('does not misstate one-click enforcement', () => {
		expect(deliverabilityGuide).toMatch(
			/does \*\*not automatically\*\*.*rejection or spam placement/is
		);
		expect(infrastructure).toMatch(/does\s+not\s+automatically reject or spam-folder/is);
		expect(infrastructure).toMatch(/Yahoo.*explicitly accepts `mailto`/is);
	});

	it("scopes Microsoft's high-volume rule to consumer mailboxes", () => {
		for (const document of [deliverabilityGuide, infrastructure]) {
			expect(document).toMatch(/Outlook\.com.*Hotmail.*Live.*MSN/is);
			expect(document).toContain('550 5.7.515');
			expect(document).toMatch(/May 5, 2025/);
		}
	});
});
