/**
 * P4.2 / D8 — ONE destination taxonomy: every consumer agrees on the key.
 *
 * The taxonomy is declared once, in `@owlat/shared/deliverabilityRouting`. The
 * MTA used to re-declare the union in `types.ts` and the key list in
 * `config/ispProfiles.ts`, and to re-implement the domain→provider fold a third
 * time inside `canonicalProfileKey`. A single declaration is only worth
 * anything if the consumers that turn a recipient DOMAIN into a KEY all land on
 * the same one, so this suite drives the corpus through each of them for real —
 * through the shipped writer AND the shipped reader, never through a re-stated
 * expectation:
 *
 *   ipReputation.ts          collector.record() labels the ISP metric row from
 *                            the domain; the snapshot route reads it back by
 *                            iterating the taxonomy. Disagreement = a signal
 *                            attributed to the wrong provider, or lost.
 *   warmingProviderStore.ts  a send recorded on the provider dimension has to
 *                            be found again by the day evaluation that
 *                            enumerates the taxonomy. Disagreement = a warming
 *                            cap that never advances.
 *   bounce/outcome.ts        an ARF complaint's forwarded `sourceIsp` has to be
 *                            the cell the send was counted in. Disagreement =
 *                            a complaint booked against the wrong cell.
 *   config/ispProfiles.ts    the PINNED DIVERGENCE: profile-key selection
 *                            deliberately keeps unknown operators domain
 *                            scoped, and agrees with the taxonomy everywhere
 *                            else.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';

vi.mock('../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
	DESTINATION_PROVIDER_KEYS,
	destinationProviderForDomain,
	// The expectation is the SHIPPED normalizer, not a restatement of it: a test
	// that re-spells `trim/lowercase/trailing-dot` would keep passing on the day
	// the shared normalizer gains a step and `canonicalProfileKey`'s two branches
	// silently start answering on differently-normalized strings.
	normalizeDestinationDomain,
	type DestinationProviderKey,
} from '@owlat/shared/deliverabilityRouting';
import { canonicalProfileKey, getProfile } from '../config/ispProfiles.js';
import { DESTINATION_PROVIDER_PROFILES } from '../config.js';
import { record } from '../monitoring/collector.js';
import { classifyIsp } from '../queue/groups.js';
import { createIpReputationRoutes } from '../routes/ipReputation.js';
import {
	evaluateProviderWarmingDay,
	recordProviderWarmingSend,
} from '../intelligence/warmingProviderStore.js';
import { warmingProviderDailyStatsKey } from '../intelligence/warmingKeys.js';
import { reduce } from '../bounce/outcome.js';
import type { BasePhaseCtx, BounceAttempt } from '../bounce/types.js';
import type { FblSourceIspToken } from '../bounce/fblProcessor.js';
import { destinationFromMx } from '../smtp/destinationProvider.js';
import { isAttemptSnapshot } from '../queue/smtpOutcomeSnapshot.js';
import type { ParsedMessage } from '@owlat/mail-message';
import { createTestConfig } from './helpers/fixtures.js';
import {
	DESTINATION_DOMAIN_CORPUS,
	FBL_OPERATOR_DOMAINS,
	PROVIDER_MX_EXCHANGES,
} from './helpers/destinationDomainCorpus.js';

const IP = '10.0.0.9';
/** Fixed clock: the ISP metric row and the snapshot route each derive their own
 *  UTC date, and a real clock can put them on opposite sides of midnight. */
const NOW = Date.UTC(2026, 7, 8, 12, 0, 0);
const UTC_DATE = '2026-08-08';

let redis: RealRedis;

beforeEach(async () => {
	redis = new Redis() as unknown as RealRedis;
	// ioredis-mock shares one keyspace across instances — a fresh `new Redis()`
	// is not a fresh database.
	await redis.flushall();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('the corpus itself', () => {
	it('names only keys the taxonomy declares', () => {
		for (const { domain, provider } of DESTINATION_DOMAIN_CORPUS) {
			expect(DESTINATION_PROVIDER_KEYS, domain).toContain(provider);
		}
	});

	it('is what the one declared classifier answers', () => {
		for (const { domain, provider, note } of DESTINATION_DOMAIN_CORPUS) {
			expect(destinationProviderForDomain(domain), `${domain} — ${note}`).toBe(provider);
		}
	});

	it('covers every key in the taxonomy, so no consumer is exercised on a subset', () => {
		const covered = new Set(DESTINATION_DOMAIN_CORPUS.map((entry) => entry.provider));
		expect([...covered].sort()).toEqual([...DESTINATION_PROVIDER_KEYS].sort());
	});
});

describe('consumer: ipReputation.ts — the ISP-metrics axis', () => {
	/** Enough deferrals on one domain to trip `persistent_defers` for its cell. */
	const DEFERS = 6;

	async function snapshotSignals(): Promise<Array<{ provider: string; source: string }>> {
		const config = createTestConfig({
			apiKey: 'taxonomy-test-key',
			ipPools: { transactional: [], campaign: [] },
		});
		const app = createIpReputationRoutes(redis, config);
		const res = await app.request('/', {
			headers: { Authorization: 'Bearer taxonomy-test-key' },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			routing: { signals: Array<{ provider: string; source: string }> };
		};
		return body.routing.signals;
	}

	it('reads back the cell the shipped metric writer labelled from the domain', async () => {
		for (const { domain, provider, note } of DESTINATION_DOMAIN_CORPUS) {
			await redis.flushall();
			vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
			try {
				// The SHIPPED writer: no providerKey, so the label comes from the
				// domain exactly as it does when no MX observation exists.
				for (let i = 0; i < DEFERS; i += 1) {
					await record(redis, domain, IP, 'campaign', 'deferred');
				}
				const defers = (await snapshotSignals()).filter(
					(signal) => signal.source === 'persistent_defers'
				);
				expect(defers, `${domain} — ${note}`).toEqual([
					{ provider, source: 'persistent_defers', severity: 'warning', observedAt: NOW },
				]);
			} finally {
				vi.useRealTimers();
			}
		}
	});

	it('labels the metric row through the same classifier the taxonomy declares', () => {
		for (const { domain, provider, note } of DESTINATION_DOMAIN_CORPUS) {
			expect(classifyIsp(domain), `${domain} — ${note}`).toBe(provider);
		}
	});

	it('reads back every key the taxonomy declares', async () => {
		for (const provider of DESTINATION_PROVIDER_KEYS) {
			await redis.flushall();
			vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
			try {
				// Written straight onto the cell (the MX-derived writer path), bypassing
				// the domain classifier: this asks only whether the snapshot's provider
				// axis IS the declared taxonomy, which a re-forked local key list breaks.
				for (let i = 0; i < DEFERS; i += 1) {
					await record(redis, 'unused.test', IP, 'campaign', 'deferred', undefined, provider);
				}
				const defers = (await snapshotSignals()).filter(
					(signal) => signal.source === 'persistent_defers'
				);
				expect(
					defers.map((signal) => signal.provider),
					provider
				).toEqual([provider]);
			} finally {
				vi.useRealTimers();
			}
		}
	});
});

describe('consumer: warmingProviderStore.ts — the warming provider dimension', () => {
	/**
	 * The SHIPPED producer for this dimension. `dispatch/effects.ts` hands
	 * `recordProviderWarmingSend` the `providerKey` of the destination snapshot,
	 * so the corpus domain has to travel through `destinationFromMx` — computing
	 * the cell in the test and handing it straight back to the store would assert
	 * the test's own input.
	 */
	function shippedSnapshot(domain: string, provider: DestinationProviderKey) {
		return destinationFromMx(domain, {
			status: 'deliverable',
			source: 'mx',
			hosts: [{ exchange: PROVIDER_MX_EXCHANGES[provider], priority: 10 }],
		});
	}

	it('finds the day the shipped producer recorded, for every domain in the corpus', async () => {
		for (const { domain, provider, note } of DESTINATION_DOMAIN_CORPUS) {
			await redis.flushall();
			const snapshot = shippedSnapshot(domain, provider);
			// The MX-derived producer and the address classifier are two different
			// classifiers; on an operator's OWN MX they have to land on one cell.
			expect(snapshot.providerKey, `${domain} — ${note}`).toBe(provider);

			await recordProviderWarmingSend(
				redis,
				{ ip: IP, provider: snapshot.providerKey, utcDate: UTC_DATE },
				'campaign'
			);

			const evaluations = await evaluateProviderWarmingDay(redis, IP, UTC_DATE);
			expect(
				evaluations.map((evaluation) => evaluation.provider),
				`${domain} — ${note}`
			).toEqual([provider]);
		}
	});

	it('round-trips every key the taxonomy declares', async () => {
		for (const provider of DESTINATION_PROVIDER_KEYS) {
			await redis.flushall();
			await recordProviderWarmingSend(redis, { ip: IP, provider, utcDate: UTC_DATE }, 'campaign');
			const evaluations = await evaluateProviderWarmingDay(redis, IP, UTC_DATE);
			expect(
				evaluations.map((evaluation) => evaluation.provider),
				provider
			).toEqual([provider]);
		}
	});

	it('keys its Redis dimension by the taxonomy key, never by the domain', async () => {
		for (const { domain, provider } of DESTINATION_DOMAIN_CORPUS) {
			await redis.flushall();
			const snapshot = shippedSnapshot(domain, provider);
			// The snapshot carries BOTH keys, and for an unknown operator they
			// DIFFER — `throttleKey` is the domain there. So the domain is genuinely
			// within reach of this keyspace, and "no domain leaked" is a falsifiable
			// claim about writing `providerKey` rather than `throttleKey`.
			if (provider === 'other') {
				expect(snapshot.throttleKey).toBe(snapshot.recipientDomain);
				expect(snapshot.throttleKey).not.toBe(snapshot.providerKey);
			}
			await recordProviderWarmingSend(
				redis,
				{ ip: IP, provider: snapshot.providerKey, utcDate: UTC_DATE },
				'campaign'
			);

			const written = await redis.keys('*');
			expect(written, domain).toContain(warmingProviderDailyStatsKey(IP, provider, UTC_DATE));
			expect(
				written.some((key) => key.includes(snapshot.recipientDomain)),
				`${domain} must not leak into the warming keyspace`
			).toBe(false);
		}
	});
});

describe('consumer: bounce/outcome.ts — the complaint cell', () => {
	function fblAttempt(sourceIsp: FblSourceIspToken): Extract<BounceAttempt, { kind: 'fbl' }> {
		return {
			kind: 'fbl',
			arf: {
				type: 'complained',
				bounceType: 'hard',
				message: 'FBL complaint from yahoo',
				originalMessageId: 'send-taxonomy-1',
				organizationId: 'org-taxonomy',
				sourceIsp,
			},
		};
	}

	const ctx: BasePhaseCtx = {
		parsed: { headers: new Map<string, string>(), attachments: [] } as unknown as ParsedMessage,
		rawBuffer: Buffer.from('raw'),
		rcptTo: 'fbl@owlat.test',
	};

	it('forwards the cell the taxonomy gives that operator, for every FBL token', () => {
		for (const [token, operatorDomain] of Object.entries(FBL_OPERATOR_DOMAINS) as Array<
			[FblSourceIspToken, string]
		>) {
			const { effects } = reduce(fblAttempt(token), ctx);
			const notify = effects.find((effect) => effect.kind === 'notify_convex');
			if (notify?.kind !== 'notify_convex') throw new Error(`no notify_convex for ${token}`);

			const expected: DestinationProviderKey = destinationProviderForDomain(operatorDomain);
			expect(notify.event.sourceIsp, `${token} (${operatorDomain})`).toBe(expected);
			expect(DESTINATION_PROVIDER_KEYS).toContain(notify.event.sourceIsp);
		}
	});
});

describe('consumer: config/ispProfiles.ts — the PINNED DIVERGENCE', () => {
	it('agrees with the taxonomy on every domain the taxonomy names', () => {
		for (const { domain, provider, note } of DESTINATION_DOMAIN_CORPUS) {
			if (provider === 'other') continue;
			expect(canonicalProfileKey(domain), `${domain} — ${note}`).toBe(provider);
		}
	});

	it('keeps unknown operators DOMAIN scoped instead of folding them into `other`', () => {
		const unknown = DESTINATION_DOMAIN_CORPUS.filter((entry) => entry.provider === 'other');
		expect(unknown.length).toBeGreaterThan(0);
		for (const { domain, note } of unknown) {
			// The divergence, stated as an assertion: the taxonomy says `other`,
			// profile selection says "this domain's own shaping row".
			expect(destinationProviderForDomain(domain)).toBe('other');
			expect(canonicalProfileKey(domain), `${domain} — ${note}`).toBe(
				normalizeDestinationDomain(domain)
			);
		}
	});

	it('normalizes the unknown-operator branch exactly like the fold branch', () => {
		// The one input class where the two halves of `canonicalProfileKey` could
		// disagree: an unknown operator spelled in a form the shared classifier
		// folds away. Two rows for one operator would split its shaping and
		// throttle budget, each half never backing off on the other's evidence.
		expect(canonicalProfileKey('example.com.')).toBe(canonicalProfileKey('example.com'));
		expect(canonicalProfileKey('  EXAMPLE.com.  ')).toBe('example.com');
		// …and the same normalization on the folding side, which is what makes the
		// two branches one contract rather than two.
		expect(canonicalProfileKey('gmail.com.')).toBe('gmail');
		expect(canonicalProfileKey('  GMAIL.COM  ')).toBe('gmail');
	});

	it('accepts a bare provider key, which is not a domain the classifier could fold', () => {
		for (const key of DESTINATION_PROVIDER_KEYS) {
			expect(canonicalProfileKey(key)).toBe(key);
		}
	});

	async function writeProfileRow(
		key: string,
		profile: (typeof DESTINATION_PROVIDER_PROFILES)[string]
	): Promise<void> {
		await redis.hset(
			key,
			Object.fromEntries(Object.entries(profile).map(([field, value]) => [field, String(value)]))
		);
	}

	it('reads an unknown operator from ITS OWN Redis row, not from the `other` row', async () => {
		const shaped = { ...DESTINATION_PROVIDER_PROFILES['__default__']!, defaultRate: 7 };
		await writeProfileRow('mta:isp-profile:example.com', shaped);

		// The domain-scoped branch, exercised the way the `providerKey = throttleKey`
		// default would reach it.
		expect(await getProfile(redis, 'example.com')).toEqual(shaped);
		// …and that row is emphatically not the one an `other`-keyed read finds.
		expect(await getProfile(redis, 'other')).toEqual(DESTINATION_PROVIDER_PROFILES['__default__']);
	});

	it('shapes `other`-keyed traffic from `mta:isp-profile:other` — an absent row, not an inert one', async () => {
		// `other` is deliberately missing from the checked-in shaping table, so the
		// read falls through to `__default__`. That is ABSENCE, and the reason the
		// exclusion is behaviour-preserving; it is NOT inertness. `smtp/sender.ts`
		// passes `destination.providerKey`, which is `other` for every destination
		// whose MX set is not one of the four named operators, and
		// `PUT /isp-profiles/other` writes exactly this row. Pinning both halves
		// keeps the comment on `CheckedInProfileKey` honest.
		expect(await getProfile(redis, 'other')).toEqual(DESTINATION_PROVIDER_PROFILES['__default__']);

		const shapedOther = { ...DESTINATION_PROVIDER_PROFILES['__default__']!, defaultRate: 11 };
		await writeProfileRow('mta:isp-profile:other', shapedOther);

		expect(await getProfile(redis, 'other')).toEqual(shapedOther);
		// …and it shapes that key ONLY: the domain-scoped branch is a different row,
		// so an `other` override does not reach through to per-operator reads.
		expect(await getProfile(redis, 'example.com')).toEqual(
			DESTINATION_PROVIDER_PROFILES['__default__']
		);
	});

	it('routes a named provider domain to the shared provider row, not a per-domain row', async () => {
		await redis.hset('mta:isp-profile:gmail.com', 'defaultRate', '3', 'ceiling', '3', 'floor', '3');
		// `gmail.com` folds to `gmail` before the read, so a stray per-domain row is
		// never consulted — the whole point of canonicalizing first.
		expect(await getProfile(redis, 'gmail.com')).toEqual(DESTINATION_PROVIDER_PROFILES['gmail']);
	});
});

describe('consumer: queue/smtpOutcomeSnapshot.ts — the replay guard fails closed', () => {
	/**
	 * The journal replays this payload verbatim after the SMTP transaction, so
	 * the guard is the only thing standing between a corrupt `providerKey` and
	 * the outcome journal. It used to be `[...].includes(String(providerKey))`,
	 * which COERCED — an object whose `toString()` said `'gmail'` was accepted.
	 * Delegating to the taxonomy's own guard tightened that, and these cases pin
	 * the tightening so a later edit back to a truthiness or `typeof` check is a
	 * red test rather than a silent hole.
	 */
	function snapshotWithProviderKey(providerKey: unknown): unknown {
		return {
			domain: 'example.com',
			pool: 'campaign',
			ip: IP,
			eligibilityGeneration: 1,
			utcDate: UTC_DATE,
			providerVolumePressure: 0,
			destination: {
				recipientDomain: 'example.com',
				providerKey,
				throttleKey: 'example.com',
				daneDiscoveryAuthenticated: true,
				mx: { status: 'deliverable', source: 'mx', hosts: [{ exchange: 'mx.test', priority: 10 }] },
			},
		};
	}

	it('accepts exactly the keys the taxonomy declares', () => {
		for (const provider of DESTINATION_PROVIDER_KEYS) {
			expect(isAttemptSnapshot(snapshotWithProviderKey(provider)), provider).toBe(true);
		}
	});

	it('rejects a provider key outside the taxonomy', () => {
		expect(isAttemptSnapshot(snapshotWithProviderKey('proton'))).toBe(false);
		expect(isAttemptSnapshot(snapshotWithProviderKey(''))).toBe(false);
		expect(isAttemptSnapshot(snapshotWithProviderKey(undefined))).toBe(false);
	});

	it('rejects a non-string that merely STRINGIFIES to a taxonomy key', () => {
		expect(isAttemptSnapshot(snapshotWithProviderKey({ toString: () => 'gmail' }))).toBe(false);
		expect(isAttemptSnapshot(snapshotWithProviderKey(['gmail']))).toBe(false);
	});
});
