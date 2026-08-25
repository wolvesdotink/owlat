/**
 * The attacks the policy is supposed to refuse (plan §6.3, §7.3, §9.3, §10).
 *
 * Each case states the move, then asserts the bound that makes it worthless.
 * A regression here is an exploit, not a rounding difference, which is why
 * these live apart from the signal-behavior suite.
 */

import { describe, expect, it } from 'vitest';
import type { ScoreResult, SequencedAttestation, SubjectRef } from '../../types.js';
import { POLICY_V1 } from '../policy.js';
import { scoreSubject } from '../score.js';
import { accusation, AS_OF, daysBefore, entry, reportEntry, trafficEntry } from './generators.js';

function score(entries: SequencedAttestation[], subject: SubjectRef): ScoreResult {
	return scoreSubject({ entries, subject, asOf: AS_OF });
}

function contribution(result: ScoreResult, signal: string): number {
	return result.explanation.find((group) => group.signal === signal)?.contribution ?? 0;
}

describe('self-dealing evidence (plan §6.1, §7.3)', () => {
	const DOMAIN = 'selfdealer.example';

	it('earns nothing from traffic summaries the subject authored about itself', () => {
		const entries = [0, 1, 2, 3].map((i) =>
			trafficEntry({
				index: 10 + i,
				observer: i === 0 ? DOMAIN : `mx${i + 1}.${DOMAIN}`,
				subject: { domain: DOMAIN },
				messages: 5_000_000,
				passRate: 1,
				windowFromDaysAgo: 1_500,
				windowToDaysAgo: 1,
				loggedAtDaysAgo: 1,
			})
		);
		const result = score(entries, { domain: DOMAIN });
		expect(result.explanation).toEqual([]);
		expect(result.score).toBe(POLICY_V1.baseScore);
		expect(result.tier).toBe('unknown');
	});

	it('ignores reports and traps a subject files against itself', () => {
		const entries = [
			...accusation({
				index: 20,
				volumeIndex: 21,
				observer: `mx.${DOMAIN}`,
				subject: { domain: DOMAIN },
				reports: 5_000,
				volume: 10_000,
				windowFromDaysAgo: 20,
				windowToDaysAgo: 1,
				loggedAtDaysAgo: 1,
			}),
		];
		expect(score(entries, { domain: DOMAIN }).explanation).toEqual([]);
	});

	it('ignores a vouch the subject wrote for itself', () => {
		const selfVouch = entry(
			'vouch',
			{ scope: 'transactional mail only', expires: daysBefore(-120) },
			{ index: 30, observer: `www.${DOMAIN}`, subject: { domain: DOMAIN }, loggedAtDaysAgo: 30 }
		);
		expect(score([selfVouch], { domain: DOMAIN }).score).toBe(POLICY_V1.baseScore);
	});
});

describe('third-party posture (plan §5)', () => {
	const DOMAIN = 'guarded.example';
	const own = entry(
		'posture',
		{ dmarcPolicy: 'reject', dmarcAlignment: 'strict', dnssec: true, mtaSts: true, tlsRpt: true },
		{ index: 1, observer: DOMAIN, subject: { domain: DOMAIN }, loggedAtDaysAgo: 400 }
	);

	it('cannot be used to erase the subject’s own posture', () => {
		const hostile = entry(
			'posture',
			{},
			{ index: 2, observer: 'griefer.example', subject: { domain: DOMAIN }, loggedAtDaysAgo: 5 }
		);
		expect(score([own, hostile], { domain: DOMAIN })).toEqual(score([own], { domain: DOMAIN }));
	});

	it('cannot lift a subject a stranger likes', () => {
		const flattering = entry(
			'posture',
			{ dmarcPolicy: 'reject', dnssec: true, mtaSts: true, tlsRpt: true },
			{ index: 3, observer: 'friend.example', subject: { domain: 'unrelated.example' } }
		);
		expect(score([flattering], { domain: 'unrelated.example' }).score).toBe(POLICY_V1.baseScore);
	});

	it('cannot lift a bare IP the author does not control', () => {
		const claimed = entry(
			'posture',
			{ dmarcPolicy: 'reject', dnssec: true, mtaSts: true, declaredIps: ['198.51.100.9'] },
			{ index: 4, observer: 'random-stranger.example', subject: { ip: '198.51.100.9' } }
		);
		expect(score([claimed], { ip: '198.51.100.9' }).score).toBe(POLICY_V1.baseScore);
	});
});

describe('report batches without a denominator (plan §7.3)', () => {
	const DOMAIN = 'quiet.example';
	const clean = trafficEntry({
		index: 1,
		observer: 'mx.observer-a.net',
		subject: { domain: DOMAIN },
		messages: 40_000,
		passRate: 0.99,
		windowFromDaysAgo: 300,
		windowToDaysAgo: 2,
		loggedAtDaysAgo: 2,
	});

	it('contributes nothing when the reporter attested no volume of its own', () => {
		const bare = [0, 1, 2].map((i) =>
			reportEntry({
				index: 10 + i,
				observer: `claimer-${i}.example`,
				subject: { domain: DOMAIN },
				reports: 1,
				windowFromDaysAgo: 20,
				windowToDaysAgo: 1,
				loggedAtDaysAgo: 1,
			})
		);
		const result = score([clean, ...bare], { domain: DOMAIN });
		expect(contribution(result, 'complaint-rate')).toBe(0);
		expect(result.tier).not.toBe('flagged');
	});

	it('counts once the reporter attests its own volume for the same window', () => {
		const withVolume = accusation({
			index: 10,
			volumeIndex: 11,
			observer: 'claimer-0.example',
			subject: { domain: DOMAIN },
			reports: 400,
			volume: 20_000,
			volumePassRate: 0.99,
			windowFromDaysAgo: 20,
			windowToDaysAgo: 1,
			loggedAtDaysAgo: 1,
		});
		expect(
			contribution(score([clean, ...withVolume], { domain: DOMAIN }), 'complaint-rate')
		).toBeLessThan(0);
	});

	it('does not count a batch whose window misses the reporter’s own summaries', () => {
		const [volume, batch] = accusation({
			index: 10,
			volumeIndex: 11,
			observer: 'claimer-0.example',
			subject: { domain: DOMAIN },
			reports: 400,
			volume: 20_000,
			windowFromDaysAgo: 20,
			windowToDaysAgo: 1,
			loggedAtDaysAgo: 1,
		}) as [SequencedAttestation, SequencedAttestation];
		batch.attestation.window = { from: daysBefore(300), to: daysBefore(280) };
		expect(contribution(score([clean, volume, batch], { domain: DOMAIN }), 'complaint-rate')).toBe(
			0
		);
	});

	it('measures the rate against the reported window, not against all history', () => {
		// Small enough that the §6.3 net cap does not bind: this case is about the
		// denominator's period, and a capped contribution would hide it.
		const recent = accusation({
			index: 20,
			volumeIndex: 21,
			observer: 'claimer-0.example',
			subject: { domain: DOMAIN },
			reports: 60,
			volume: 20_000,
			volumePassRate: 0.99,
			windowFromDaysAgo: 20,
			windowToDaysAgo: 1,
			loggedAtDaysAgo: 1,
		});
		// Five years of unrelated volume, from a party that reported nothing.
		const ancientHistory = trafficEntry({
			index: 22,
			observer: 'historian.example',
			subject: { domain: DOMAIN },
			messages: 50_000_000,
			passRate: 0.99,
			windowFromDaysAgo: 1_800,
			windowToDaysAgo: 400,
			loggedAtDaysAgo: 400,
		});
		expect(contribution(score([clean, ...recent], { domain: DOMAIN }), 'complaint-rate')).toBe(
			contribution(score([clean, ...recent, ancientHistory], { domain: DOMAIN }), 'complaint-rate')
		);
	});
});

describe('poisoned traffic summaries', () => {
	const DOMAIN = 'bouncy.example';
	const honest = (index: number, observer: string, bounceBucket: number): SequencedAttestation =>
		trafficEntry({
			index,
			observer,
			subject: { domain: DOMAIN },
			messages: 30_000,
			passRate: 0.99,
			bounceBucket,
			windowFromDaysAgo: 300,
			windowToDaysAgo: 2,
			loggedAtDaysAgo: 2,
		});
	const poison = (bounceBucket: number): SequencedAttestation =>
		trafficEntry({
			index: 99,
			observer: 'friend.example',
			subject: { domain: DOMAIN },
			messages: 1,
			passRate: 1,
			bounceBucket,
			windowFromDaysAgo: 300,
			windowToDaysAgo: 2,
			loggedAtDaysAgo: 2,
		});
	const corpus = (): SequencedAttestation[] => [
		honest(1, 'mx.observer-a.net', 2),
		honest(2, 'mail.observer-b.org', 2),
	];

	it('cannot be cancelled by an absurd negative bucket', () => {
		const clean = contribution(score(corpus(), { domain: DOMAIN }), 'bounce-rate');
		const poisoned = contribution(
			score([...corpus(), poison(-1e9)], { domain: DOMAIN }),
			'bounce-rate'
		);
		expect(clean).toBeLessThan(0);
		expect(poisoned).toBeLessThan(0);
		expect(Math.abs(poisoned - clean)).toBeLessThan(0.1);
	});

	it('cannot be manufactured by an absurd positive bucket', () => {
		const clean = score([honest(1, 'mx.observer-a.net', 0), honest(2, 'mail.observer-b.org', 0)], {
			domain: DOMAIN,
		});
		const attacked = score(
			[honest(1, 'mx.observer-a.net', 0), honest(2, 'mail.observer-b.org', 0), poison(1e6)],
			{ domain: DOMAIN }
		);
		expect(contribution(clean, 'bounce-rate')).toBe(0);
		expect(Math.abs(contribution(attacked, 'bounce-rate'))).toBeLessThan(0.01);
	});

	it('cannot backdate a subject’s history with one ancient window', () => {
		const short = (index: number, observer: string): SequencedAttestation =>
			trafficEntry({
				index,
				observer,
				subject: { domain: DOMAIN },
				messages: 1_000_000,
				passRate: 0.99,
				windowFromDaysAgo: 4,
				windowToDaysAgo: 1,
				loggedAtDaysAgo: 1,
			});
		const honestPair = [short(1, 'mx.observer-a.net'), short(2, 'mail.observer-b.org')];
		const liar = trafficEntry({
			index: 3,
			observer: 'liar.example',
			subject: { domain: DOMAIN },
			messages: 1,
			passRate: 1,
			windowFromDaysAgo: 20_000,
			windowToDaysAgo: 1,
			loggedAtDaysAgo: 1,
		});
		const before = score(honestPair, { domain: DOMAIN });
		const after = score([...honestPair, liar], { domain: DOMAIN });
		expect(
			contribution(after, 'history-volume') - contribution(before, 'history-volume')
		).toBeLessThan(0.5);
		expect(after.tier).not.toBe('trusted');
	});
});

describe('a ring with no history (plan §6.2, §7.3)', () => {
	const DOMAIN = 'ringleader.example';
	/**
	 * Four observers the attacker also controls, publishing perfect
	 * authentication and years of claimed history for a domain that was
	 * registered — and first logged — yesterday. The names are unrelated
	 * registrable domains, so control grouping does not collapse them: the ring
	 * has paid for four domains and four DNS keys, and that is the whole cost.
	 */
	const ring = (loggedAtDaysAgo: number, windowFromDaysAgo: number): SequencedAttestation[] =>
		[0, 1, 2, 3].map((i) =>
			trafficEntry({
				index: 10 + i,
				observer: `watcher-${i}.example`,
				subject: { domain: DOMAIN },
				messages: 40_000 - i * 5_000,
				passRate: 1,
				windowFromDaysAgo,
				windowToDaysAgo: 1,
				loggedAtDaysAgo,
			})
		);
	const posture = entry(
		'posture',
		{ dmarcPolicy: 'reject', dmarcAlignment: 'strict', dnssec: true, mtaSts: true, tlsRpt: true },
		{ index: 1, observer: DOMAIN, subject: { domain: DOMAIN }, loggedAtDaysAgo: 1 }
	);

	it('cannot reach trusted on windows the log cannot corroborate', () => {
		const result = score([...ring(1, 2_000), posture], { domain: DOMAIN });
		// The claimed decade buys no history at all, and the sustained-history
		// rule holds the tier down even though the rest of the ring's evidence
		// puts the score inside the top band.
		expect(contribution(result, 'history-volume')).toBe(0);
		expect(result.score).toBeGreaterThanOrEqual(POLICY_V1.tiers.establishingBelow);
		expect(result.tier).toBe(POLICY_V1.history.maxTierWithoutSustainedHistory);
	});

	/** The same claims, from observers that have published since the window opened. */
	const withTrackRecord = (): SequencedAttestation[] => [
		...ring(1, 2_000),
		...ring(600, 2_000).map((seed, i) => ({ ...seed, index: 20 + i })),
		posture,
	];

	it('reaches trusted only once the same evidence has a logged track record', () => {
		expect(score(withTrackRecord(), { domain: DOMAIN }).tier).toBe('trusted');
	});

	it('gains nothing by cross-submitting the same claims to more logs', () => {
		const single = score(withTrackRecord(), { domain: DOMAIN });
		const everywhere = [
			...withTrackRecord(),
			...withTrackRecord().map((copy, i) => ({ ...copy, logId: 'log-b', index: 70 + i })),
			...withTrackRecord().map((copy, i) => ({ ...copy, logId: 'log-c', index: 90 + i })),
		];
		const merged = score(everywhere, { domain: DOMAIN });
		expect(merged.score).toBe(single.score);
		expect(merged.tier).toBe(single.tier);
		// The attested volume is the signal three copies would have tripled.
		expect(contribution(merged, 'history-volume')).toBe(contribution(single, 'history-volume'));
	});
});

describe('vouch stake (plan §6.4)', () => {
	it('dilutes a voucher underwriting many tenants', () => {
		const vouch = (index: number, subject: string): SequencedAttestation =>
			entry(
				'vouch',
				{ scope: 'transactional mail only', expires: daysBefore(-120) },
				{
					index,
					observer: 'host.provider.example',
					subject: { domain: subject },
					loggedAtDaysAgo: 30,
				}
			);
		const target = { domain: 'tenant-1.example' };
		const alone = score([vouch(1, 'tenant-1.example')], target);
		const crowded = score(
			[
				vouch(1, 'tenant-1.example'),
				...Array.from({ length: 39 }, (_u, i) => vouch(2 + i, `tenant-${i + 2}.example`)),
			],
			target
		);
		expect(contribution(alone, 'vouches')).toBe(POLICY_V1.vouch.pointsPerVouch);
		expect(contribution(crowded, 'vouches')).toBeLessThan(1);
		expect(contribution(crowded, 'vouches')).toBeGreaterThan(0);
	});
});
