/**
 * Postmaster telemetry → operator actions.
 *
 * The rule under test: every card names the failing check AND what to do about
 * it, and no signal at all produces no cards — never a warning, never a nag.
 */
import { describe, expect, it } from 'vitest';
import {
	POSTMASTER_AUTH_SUCCESS_FLOOR,
	POSTMASTER_SPAM_RATE_LIMIT,
	derivePostmasterCards,
	type PostmasterDomainSignals,
} from '../postmasterCards';

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
