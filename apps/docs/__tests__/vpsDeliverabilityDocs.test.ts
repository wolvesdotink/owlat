import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ADAPTIVE_WARMING_POLICY, BASE_WARMING_SCHEDULE } from '@owlat/shared/warming';
import { PROVIDER_SPAM_RATE_POLICY } from '@owlat/shared/reputation';
import {
	CAMPAIGN_COMPLAINT_POLICY,
	CIRCUIT_BREAKER_POLICY,
	DESTINATION_PROVIDER_PROFILES,
	GMAIL_BULK_SENDER_THRESHOLD,
	GMAIL_PROXIMITY_WARNING_THRESHOLD,
	MICROSOFT_HIGH_VOLUME_SENDER_THRESHOLD,
	UNSUBSCRIBE_HONOR_WINDOW_MS,
	type DestinationProviderProfile,
} from '@owlat/shared/deliverabilityPolicy';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const readRepoFile = (path: string) => readFileSync(resolve(repoRoot, path), 'utf8');

const vpsGuide = readRepoFile('apps/docs/content/1.guide/51.sending-from-a-vps.md');
const deliverabilityGuide = readRepoFile('apps/docs/content/1.guide/21.deliverability.md');
const infrastructure = readRepoFile(
	'apps/docs/content/3.developer/19.deliverability-infrastructure.md'
);
const mtaSystem = readRepoFile('apps/docs/content/3.developer/10.mta-system.md');

interface MarkdownTable {
	headers: string[];
	rowsByKey: Map<string, string[]>;
}

function parseMarkdownRow(line: string): string[] {
	return line
		.trim()
		.slice(1, -1)
		.split('|')
		.map((cell) => cell.trim());
}

function plainRowKey(cell: string): string {
	return cell.replaceAll('**', '').replaceAll('`', '').trim();
}

function parseMarkedTable(document: string, marker: string): MarkdownTable {
	const lines = document.split('\n');
	const markerLine = `<!-- deliverability-policy:${marker} -->`;
	const markerIndex = lines.findIndex((line) => line.trim() === markerLine);
	expect(markerIndex, `missing ${marker} policy table`).toBeGreaterThanOrEqual(0);

	const firstTableLine = lines.findIndex(
		(line, index) => index > markerIndex && line.trim().startsWith('|')
	);
	expect(firstTableLine, `missing ${marker} table rows`).toBeGreaterThan(markerIndex);

	const tableLines: string[] = [];
	for (let index = firstTableLine; index < lines.length; index++) {
		const line = lines[index]!;
		if (!line.trim().startsWith('|')) break;
		tableLines.push(line);
	}
	expect(tableLines.length, `${marker} table needs a header, separator, and data`).toBeGreaterThan(
		2
	);

	const headers = parseMarkdownRow(tableLines[0]!);
	const separator = parseMarkdownRow(tableLines[1]!);
	expect(separator).toHaveLength(headers.length);
	expect(separator.every((cell) => /^:?-{3,}:?$/.test(cell))).toBe(true);

	const rowsByKey = new Map<string, string[]>();
	for (const line of tableLines.slice(2)) {
		const cells = parseMarkdownRow(line);
		expect(cells, `${marker} row has shifted cells: ${line}`).toHaveLength(headers.length);
		const key = plainRowKey(cells[0]!);
		expect(rowsByKey.has(key), `duplicate ${marker} row: ${key}`).toBe(false);
		rowsByKey.set(key, cells);
	}
	return { headers, rowsByKey };
}

function expectTableRow(table: MarkdownTable, key: string, expectedCells: readonly string[]): void {
	expect(table.rowsByKey.get(key), `missing Markdown row: ${key}`).toEqual(expectedCells);
}

function formatCount(value: number): string {
	return value.toLocaleString('en-US');
}

function formatRate(value: number, fractionDigits: number): string {
	return `${(value * 100).toFixed(fractionDigits)}%`;
}

function scheduleCap(day: number): string {
	const entry = BASE_WARMING_SCHEDULE.find((candidate) => candidate.day === day);
	expect(entry, `missing checked-in warming day ${day}`).toBeDefined();
	return formatCount(entry!.cap);
}

function tlsModeLabel(mode: DestinationProviderProfile['tlsMode']): string {
	switch (mode) {
		case 'opportunistic':
			return 'Opportunistic';
		case 'require':
			return 'Required';
		case 'require-verified':
			return 'Verified';
	}
}

describe('Sending from a VPS navigation and claims', () => {
	it('uses the next numbered guide slot', () => {
		expect(vpsGuide).toMatch(/^---\ntitle: "Sending from a VPS"/);
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
	const warmingTable = parseMarkedTable(vpsGuide, 'warming-weeks');
	const adaptationTable = parseMarkedTable(vpsGuide, 'warming-adaptation');
	const mtaScheduleTable = parseMarkedTable(mtaSystem, 'mta-warming-schedule');

	it('pins each weekly row to the checked-in base schedule', () => {
		expect(warmingTable.headers).toEqual(['Warming period', 'Base daily-cap checkpoints']);
		expectTableRow(warmingTable, 'Week 1 — days 1–7', [
			'**Week 1 — days 1–7**',
			`Day 1: ${scheduleCap(1)} → day 2: ${scheduleCap(2)} → day 3: ${scheduleCap(3)} → day 5: ${scheduleCap(5)} → day 7: ${scheduleCap(7)}`,
		]);
		expectTableRow(warmingTable, 'Week 2 — days 8–14', [
			'**Week 2 — days 8–14**',
			`Starts at ${scheduleCap(7)} → day 10: ${scheduleCap(10)} → day 14: ${scheduleCap(14)}`,
		]);
		expectTableRow(warmingTable, 'Week 3 — days 15–21', [
			'**Week 3 — days 15–21**',
			`Starts at ${scheduleCap(14)} → day 18: ${scheduleCap(18)} → day 21: ${scheduleCap(21)}`,
		]);
		expectTableRow(warmingTable, 'Week 4 — days 22–28', [
			'**Week 4 — days 22–28**',
			`Starts at ${scheduleCap(21)} → day 25: ${scheduleCap(25)}`,
		]);
		const graduation = ADAPTIVE_WARMING_POLICY.graduation;
		expectTableRow(warmingTable, `Day ${graduation.minimumScheduleDay}+`, [
			`**Day ${graduation.minimumScheduleDay}+**`,
			'Graduation removes the warming cap only after the health gate passes',
		]);
	});

	it('keeps the established MTA-system table on the same shared schedule', () => {
		expect(mtaScheduleTable.headers).toEqual(['Day', 'Daily Cap']);
		for (const { day, cap } of BASE_WARMING_SCHEDULE) {
			const key = `${day}${Number.isFinite(cap) ? '' : '+'}`;
			expectTableRow(mtaScheduleTable, key, [
				key,
				Number.isFinite(cap) ? formatCount(cap) : 'Unlimited (graduated)',
			]);
		}
	});

	it('documents each adaptive boundary in its semantic row', () => {
		const { acceleration, deceleration, halt, graduation } = ADAPTIVE_WARMING_POLICY;
		expect(adaptationTable.headers).toEqual(['Daily result', 'MTA response']);

		const accelerationResult =
			`Bounce below ${formatRate(acceleration.bounceRateExclusiveMax, 0)}, ` +
			`deferral below ${formatRate(acceleration.deferralRateExclusiveMax, 0)}, and at least ` +
			`${formatRate(acceleration.usageRateMinimum, 0)} of cap used`;
		expectTableRow(adaptationTable, accelerationResult, [
			accelerationResult,
			'Advance the schedule faster',
		]);

		const decelerationResult =
			`Bounce above ${formatRate(deceleration.bounceRateExclusiveMin, 0)} or ` +
			`deferral above ${formatRate(deceleration.deferralRateExclusiveMin, 0)}`;
		expectTableRow(adaptationTable, decelerationResult, [
			decelerationResult,
			`Move the schedule day back and reduce the cap by ${formatRate(1 - deceleration.capMultiplier, 0)}, never below ${formatCount(deceleration.minimumCap)}`,
		]);

		const haltResult =
			`Bounce above ${formatRate(halt.bounceRateExclusiveMin, 0)} or ` +
			`deferral above ${formatRate(halt.deferralRateExclusiveMin, 0)}`;
		expectTableRow(adaptationTable, haltResult, [haltResult, 'Plateau the IP and alert']);

		const graduationResult =
			`Schedule day ${graduation.minimumScheduleDay}+ with bounce below ` +
			formatRate(graduation.bounceRateExclusiveMax, 0);
		expectTableRow(adaptationTable, graduationResult, [
			graduationResult,
			'Graduate and remove the warming cap',
		]);
	});

	it('describes checkpoints as adaptive state rather than guaranteed calendar throughput', () => {
		expect(vpsGuide).toMatch(/warming day.*not a guaranteed calendar date/is);
		expect(vpsGuide).toMatch(/day with no sends does not advance/i);
	});
});

describe('provider and internal thresholds cannot drift from code', () => {
	const providerControls = parseMarkedTable(infrastructure, 'provider-controls');
	const breakerTable = parseMarkedTable(infrastructure, 'circuit-breaker');
	const profileTable = parseMarkedTable(infrastructure, 'isp-profiles');
	const requirementTable = parseMarkedTable(deliverabilityGuide, 'mailbox-requirements');
	const developerRequirementTable = parseMarkedTable(
		infrastructure,
		'developer-mailbox-requirements'
	);
	const unsubscribeHours = UNSUBSCRIBE_HONOR_WINDOW_MS / (60 * 60 * 1000);
	const unsubscribeDays = unsubscribeHours / 24;

	it('pins each receiver requirement to its own semantic row', () => {
		expect(requirementTable.headers).toEqual([
			'Receiver scope',
			'Who is covered',
			'Authentication and transport',
			'Complaint and unsubscribe requirements',
		]);
		expectTableRow(requirementTable, 'Gmail — all senders', [
			'**Gmail — all senders**',
			'Mail to personal `@gmail.com` and `@googlemail.com` accounts',
			'SPF **or** DKIM; valid forward and reverse DNS; TLS; RFC 5322 formatting',
			`Postmaster Tools spam rate below ${formatRate(PROVIDER_SPAM_RATE_POLICY.hardThreshold, 1)}`,
		]);
		expectTableRow(requirementTable, 'Gmail — bulk senders', [
			'**Gmail — bulk senders**',
			`About ${formatCount(GMAIL_BULK_SENDER_THRESHOLD)} messages in 24 hours to personal Gmail, aggregated by primary sending domain; Google treats the classification as permanent`,
			'SPF **and** DKIM; DMARC at least `p=none`; the From domain aligned with SPF or DKIM; all sender requirements',
			`Keep Postmaster spam below ${formatRate(PROVIDER_SPAM_RATE_POLICY.target, 2)} and avoid ${formatRate(PROVIDER_SPAM_RATE_POLICY.hardThreshold, 2)} or higher; marketing and subscribed mail needs RFC 8058 one-click plus a visible body link; honor within ${unsubscribeHours} hours`,
		]);
		expectTableRow(requirementTable, 'Yahoo — all senders', [
			'**Yahoo — all senders**',
			'Mail to consumer domains hosted by Yahoo',
			'SPF **or** DKIM; valid forward and reverse DNS; RFC 5321/5322',
			`Yahoo spam rate below ${formatRate(PROVIDER_SPAM_RATE_POLICY.hardThreshold, 1)}`,
		]);
		expectTableRow(requirementTable, 'Yahoo — bulk senders', [
			'**Yahoo — bulk senders**',
			'Significant volume by authenticated or From domain; Yahoo deliberately publishes no numeric cutoff',
			'SPF **and** DKIM; passing DMARC at least `p=none`; From aligned with SPF or DKIM; all sender requirements',
			`Marketing/subscribed mail needs a functioning \`List-Unsubscribe\` mechanism and visible body link; RFC 8058 POST is highly recommended and \`mailto\` is accepted; honor within ${unsubscribeDays} days; spam below ${formatRate(PROVIDER_SPAM_RATE_POLICY.hardThreshold, 1)}`,
		]);
		expectTableRow(requirementTable, 'Outlook.com — high-volume senders', [
			'**Outlook.com — high-volume senders**',
			`${formatCount(MICROSOFT_HIGH_VOLUME_SENDER_THRESHOLD)}+ messages per day per From domain to Outlook.com, Hotmail, Live, and MSN consumer accounts`,
			'SPF and DKIM must both pass; publish DMARC at least `p=none`; SPF or DKIM must align so DMARC passes',
			'Functional unsubscribe and list hygiene are Microsoft recommendations; the current mandatory high-volume rule is the authentication triad',
		]);
	});

	it('pins each developer requirement summary to the matching receiver', () => {
		expect(developerRequirementTable.headers).toEqual([
			'Receiver scope',
			'Authentication floor',
			'Other current requirements',
		]);
		expectTableRow(developerRequirementTable, 'Gmail, all senders', [
			'Gmail, all senders',
			'SPF or DKIM',
			`Valid forward/reverse DNS, TLS, RFC 5322, spam below ${formatRate(PROVIDER_SPAM_RATE_POLICY.hardThreshold, 1)}`,
		]);
		expectTableRow(developerRequirementTable, 'Gmail, bulk', [
			'Gmail, bulk',
			'SPF and DKIM; DMARC at least `p=none`; From aligned with SPF or DKIM',
			`All-sender floor; RFC 8058 plus visible body unsubscribe for marketing/subscribed mail; honor within ${unsubscribeHours} hours`,
		]);
		expectTableRow(developerRequirementTable, 'Yahoo, all senders', [
			'Yahoo, all senders',
			'SPF or DKIM',
			`Valid forward/reverse DNS, RFC 5321/5322, spam below ${formatRate(PROVIDER_SPAM_RATE_POLICY.hardThreshold, 1)}`,
		]);
		expectTableRow(developerRequirementTable, 'Yahoo, bulk', [
			'Yahoo, bulk',
			'SPF and DKIM; passing DMARC at least `p=none`; From alignment',
			`Functioning \`List-Unsubscribe\` plus visible body link for marketing/subscribed mail; honor within ${unsubscribeDays} days`,
		]);
		const outlookKey =
			`Outlook.com consumer, ${formatCount(MICROSOFT_HIGH_VOLUME_SENDER_THRESHOLD)}+ ` +
			'per day per From domain';
		expectTableRow(developerRequirementTable, outlookKey, [
			outlookKey,
			'SPF and DKIM both pass; DMARC published at least `p=none`; aligned SPF or DKIM makes DMARC pass',
			'Non-compliant high-volume mail is rejected with `550 5.7.515`',
		]);
	});

	it('pins each receiver policy to the matching Owlat control row', () => {
		expect(providerControls.headers).toEqual([
			'Policy boundary',
			'Current receiver rule',
			'Owlat control',
		]);
		expectTableRow(providerControls, 'Gmail bulk proximity', [
			'Gmail bulk proximity',
			`Classification is around ${formatCount(GMAIL_BULK_SENDER_THRESHOLD)} messages in 24 hours to personal Gmail, aggregated by primary sending domain`,
			`Warn at ${formatCount(GMAIL_PROXIMITY_WARNING_THRESHOLD)} accepted Gmail-attributed messages in the rolling approximation; display the ${formatCount(GMAIL_BULK_SENDER_THRESHOLD)} classifier boundary`,
		]);
		expectTableRow(providerControls, 'Gmail spam rate', [
			'Gmail spam rate',
			`Keep Postmaster Tools below ${formatRate(PROVIDER_SPAM_RATE_POLICY.target, 2)}; avoid ${formatRate(PROVIDER_SPAM_RATE_POLICY.hardThreshold, 2)} or higher`,
			'Display target and hard line; count seven internal clean sending days only as investigation evidence',
		]);
		expectTableRow(providerControls, 'Yahoo spam rate', [
			'Yahoo spam rate',
			`Keep below ${formatRate(PROVIDER_SPAM_RATE_POLICY.hardThreshold, 1)}; Yahoo's denominator is mail delivered to the inbox`,
			`Display the same hard line, but never label Owlat's denominator as Yahoo's rate`,
		]);
		expectTableRow(providerControls, 'One-click processing', [
			'One-click processing',
			`Gmail bulk marketing/subscribed mail needs RFC 8058; Yahoo requires functioning \`List-Unsubscribe\` and highly recommends RFC 8058; both expect completion within ${unsubscribeDays} days`,
			`Refuse campaign/marketing-automation envelopes without signed RFC 8058 headers; apply suppression synchronously; alert when p95 crosses ${unsubscribeHours} hours`,
		]);
		expectTableRow(providerControls, 'Campaign complaints', [
			'Campaign complaints',
			'Receiver placement can degrade before a whole organization crosses a breaker',
			`Alert above ${formatRate(CAMPAIGN_COMPLAINT_POLICY.rateExclusiveMax, 1)} after at least ${formatCount(CAMPAIGN_COMPLAINT_POLICY.minimumDeliveries)} attributable deliveries`,
		]);
	});

	it('pins every real-time circuit-breaker row', () => {
		expect(breakerTable.headers).toEqual(['Signal', 'Window', 'Opens above']);
		const expectedRows = [
			['Bounce, fast', CIRCUIT_BREAKER_POLICY.bounce.fast],
			['Bounce, sustained', CIRCUIT_BREAKER_POLICY.bounce.sustained],
			['Complaint, fast', CIRCUIT_BREAKER_POLICY.complaint.fast],
			['Complaint, sustained', CIRCUIT_BREAKER_POLICY.complaint.sustained],
		] as const;
		for (const [label, policy] of expectedRows) {
			expectTableRow(breakerTable, label, [
				label,
				`Last ${formatCount(policy.windowSize)} outcomes`,
				formatRate(policy.rateExclusiveMax, policy.rateExclusiveMax < 0.01 ? 1 : 0),
			]);
		}
		expect(infrastructure).toContain(
			`An open breaker cools down for ${CIRCUIT_BREAKER_POLICY.cooldownMs / (60 * 1000)} minutes`
		);
	});

	it('renders every checked-in destination-provider profile from its own row', () => {
		expect(profileTable.headers).toEqual([
			'Provider',
			'Initial / ceiling / floor per minute',
			'TLS floor',
			'Connections',
			'Deliveries per connection',
		]);
		const labels = {
			gmail: 'Gmail',
			microsoft: 'Microsoft',
			yahoo: 'Yahoo',
			apple: 'Apple',
			__default__: 'Other',
		} as const;

		for (const [providerKey, label] of Object.entries(labels)) {
			const profile = DESTINATION_PROVIDER_PROFILES[providerKey]!;
			expectTableRow(profileTable, label, [
				label,
				`${profile.defaultRate} / ${profile.ceiling} / ${profile.floor}`,
				tlsModeLabel(profile.tlsMode),
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
