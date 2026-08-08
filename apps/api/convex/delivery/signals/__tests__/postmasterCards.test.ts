/**
 * Postmaster telemetry → operator actions.
 *
 * The rule under test: every card names the failing check AND what to do about
 * it, and no signal at all produces no cards — never a warning, never a nag.
 */
import { describe, expect, it } from 'vitest';
import {
	GOOGLE_POSTMASTER_SIGNAL_SOURCE,
	POSTMASTER_AUTH_SUCCESS_FLOOR,
	POSTMASTER_SPAM_RATE_LIMIT,
	derivePostmasterCards,
	type PostmasterDomainSignals,
} from '../postmaster';

function signals(overrides: Partial<PostmasterDomainSignals> = {}): PostmasterDomainSignals {
	return {
		domain: 'example.com',
		userReportedSpamRatio: null,
		spfSuccessRatio: null,
		dkimSuccessRatio: null,
		dmarcSuccessRatio: null,
		deliveryErrorRatio: null,
		deliveryErrors: [],
		checks: [],
		...overrides,
	};
}

describe('Postmaster compliance cards', () => {
	it('renders a failing check as an action naming the check and the remedy', () => {
		const cards = derivePostmasterCards(
			signals({ checks: [{ name: 'DOMAIN_REPUTATION', state: 'failing' }] })
		);

		expect(cards).toHaveLength(1);
		const card = cards[0]!;
		expect(card.check).toBe('DOMAIN_REPUTATION');
		expect(card.severity).toBe('critical');
		expect(card.title).not.toContain('DOMAIN_REPUTATION');
		expect(card.detail).toContain('DOMAIN_REPUTATION');
		expect(card.detail).toContain('example.com');
		expect(card.remedy.length).toBeGreaterThan(20);
		expect(card.remedy).toMatch(/engaged contacts/i);
	});

	it('renders a check it has no copy for rather than swallowing it', () => {
		const cards = derivePostmasterCards(
			signals({ checks: [{ name: 'A_CHECK_GOOGLE_ADDED_LATER', state: 'failing' }] })
		);

		expect(cards).toHaveLength(1);
		expect(cards[0]!.title).toContain('A_CHECK_GOOGLE_ADDED_LATER');
		expect(cards[0]!.remedy).toContain('Google Postmaster Tools');
	});

	it('says nothing at all when there is nothing to say', () => {
		expect(derivePostmasterCards(signals())).toEqual([]);
		expect(
			derivePostmasterCards(
				signals({
					userReportedSpamRatio: 0.0001,
					spfSuccessRatio: 1,
					dkimSuccessRatio: 1,
					dmarcSuccessRatio: 1,
					deliveryErrorRatio: 0,
					checks: [
						{ name: 'SPAM_RATE', state: 'passing' },
						{ name: 'IP_REPUTATION', state: 'unknown' },
					],
				})
			)
		).toEqual([]);
	});

	it('raises a card at the published spam-rate line and not below it', () => {
		expect(
			derivePostmasterCards(signals({ userReportedSpamRatio: POSTMASTER_SPAM_RATE_LIMIT - 0.0001 }))
		).toEqual([]);
		const cards = derivePostmasterCards(
			signals({ userReportedSpamRatio: POSTMASTER_SPAM_RATE_LIMIT })
		);
		expect(cards).toHaveLength(1);
		expect(cards[0]!.check).toBe('SPAM_RATE');
		expect(cards[0]!.detail).toContain('0.30%');
	});

	it('raises one card per authentication mechanism below the floor', () => {
		const cards = derivePostmasterCards(
			signals({
				spfSuccessRatio: POSTMASTER_AUTH_SUCCESS_FLOOR,
				dkimSuccessRatio: 0.4,
				dmarcSuccessRatio: 0.9,
			})
		);

		expect(cards.map((card) => card.check)).toEqual(['DKIM', 'DMARC']);
		expect(cards[0]!.detail).toContain('40.0%');
	});

	it("prefers Google's own verdict over our threshold on the same check", () => {
		const cards = derivePostmasterCards(
			signals({
				userReportedSpamRatio: 0.05,
				checks: [{ name: 'SPAM_RATE', state: 'failing' }],
			})
		);

		expect(cards).toHaveLength(1);
		expect(cards[0]!.id).toBe('check:SPAM_RATE');
	});

	it('names the worst delivery-error category and orders critical cards first', () => {
		const cards = derivePostmasterCards(
			signals({
				dkimSuccessRatio: 0.1,
				checks: [{ name: 'IP_REPUTATION', state: 'failing' }],
				deliveryErrors: [
					{ category: 'RATE_LIMIT_EXCEEDED', ratio: 0.01 },
					{ category: 'SUSPECTED_SPAM', ratio: 0.2 },
				],
			})
		);

		expect(cards.map((card) => card.severity)).toEqual(['critical', 'warning', 'warning']);
		expect(cards.map((card) => card.check)).toEqual(['IP_REPUTATION', 'DKIM', 'SUSPECTED_SPAM']);
		expect(cards[2]!.detail).toContain('20.0%');
	});

	it('survives degenerate numbers without emitting a NaN', () => {
		const cards = derivePostmasterCards(
			signals({
				userReportedSpamRatio: 0,
				spfSuccessRatio: 0,
				deliveryErrors: [{ category: 'BAD_PTR_RECORD', ratio: 0 }],
			})
		);

		expect(cards.map((card) => card.check)).toEqual(['SPF']);
		expect(JSON.stringify(cards)).not.toContain('NaN');
	});
});

/**
 * THE SOURCE MAY NOT HIDE A CARD.
 *
 * `getPostmasterStatus` renders `collect()`'s reading, so "this domain is not
 * configured" and "this domain has nothing to show" have to be the same set of
 * domains. The dangerous direction is a stored field that produces a card while
 * the observation predicate does not count it: the card would vanish and the
 * screen would invite the operator to connect an account they already have.
 *
 * The fixture table is keyed by the signal fields themselves, so a field added
 * to `PostmasterDomainSignals` does not compile until someone has said what
 * evidence looks like for it.
 */
describe('a collected absence is exactly a domain Google has said nothing about', () => {
	const ONLY_EVIDENCE: Readonly<
		Record<keyof Omit<PostmasterDomainSignals, 'domain'>, PostmasterDomainSignals>
	> = {
		userReportedSpamRatio: signals({ userReportedSpamRatio: 0.05 }),
		spfSuccessRatio: signals({ spfSuccessRatio: 0.1 }),
		dkimSuccessRatio: signals({ dkimSuccessRatio: 0.1 }),
		dmarcSuccessRatio: signals({ dmarcSuccessRatio: 0.1 }),
		deliveryErrorRatio: signals({ deliveryErrorRatio: 0.2 }),
		deliveryErrors: signals({ deliveryErrors: [{ category: 'SUSPECTED_SPAM', ratio: 0.2 }] }),
		checks: signals({ checks: [{ name: 'SPAM_RATE', state: 'failing' }] }),
	};

	it.each(Object.entries(ONLY_EVIDENCE))(
		'a domain whose only stored evidence is %s is collected, not declared absent',
		(_field, only) => {
			const collected = GOOGLE_POSTMASTER_SIGNAL_SOURCE.collect(only);
			expect(collected.available).toBe(true);
			if (!collected.available) return;
			expect(collected.reading).toEqual(derivePostmasterCards(only));
		}
	);

	/**
	 * CONNECTED BUT QUIET — the case the `omit` absence exists to distinguish, and
	 * the one an "absent means no cards" predicate would get wrong. Each fixture
	 * stores the field at a value that is healthy, so the derivation renders
	 * NOTHING and the only thing separating it from an unconfigured domain is that
	 * Google said something. Keyed by field for the same reason as the table
	 * above: a new signal field has to be given a quiet value before it compiles.
	 */
	const QUIET: Readonly<
		Record<keyof Omit<PostmasterDomainSignals, 'domain'>, PostmasterDomainSignals>
	> = {
		userReportedSpamRatio: signals({ userReportedSpamRatio: 0 }),
		spfSuccessRatio: signals({ spfSuccessRatio: 1 }),
		dkimSuccessRatio: signals({ dkimSuccessRatio: 1 }),
		dmarcSuccessRatio: signals({ dmarcSuccessRatio: 1 }),
		deliveryErrorRatio: signals({ deliveryErrorRatio: 0 }),
		deliveryErrors: signals({ deliveryErrors: [{ category: 'SUSPECTED_SPAM', ratio: 0 }] }),
		checks: signals({ checks: [{ name: 'SPAM_RATE', state: 'passing' }] }),
	};

	it.each(Object.entries(QUIET))(
		'a domain whose only stored %s is healthy is present with no cards, not absent',
		(_field, quiet) => {
			expect(derivePostmasterCards(quiet)).toEqual([]);
			const collected = GOOGLE_POSTMASTER_SIGNAL_SOURCE.collect(quiet);
			// Present, empty — "nothing to report" is not "no account", and only the
			// second is an invitation to go and connect one.
			expect(collected.available).toBe(true);
			if (!collected.available) return;
			expect(collected.reading).toEqual([]);
		}
	);

	it('declares absent only for a domain with nothing stored at all', () => {
		const nothing = GOOGLE_POSTMASTER_SIGNAL_SOURCE.collect(signals());
		expect(nothing.available).toBe(false);
		expect(derivePostmasterCards(signals())).toEqual([]);
	});
});
