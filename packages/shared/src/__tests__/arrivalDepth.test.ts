import { describe, expect, it } from 'vitest';
import type { ChooseArrivalDepthInput } from '../arrival';
import { ARRIVAL_DEPTH_REASONS, chooseArrivalDepth } from '../arrivalDepth';

/** A display-only, eligible, AI-on, preference-on person mail with budget. */
const base: ChooseArrivalDepthInput = {
	isReadOnArrival: true,
	isAiOn: true,
	isEligible: true,
	isDisplayOnly: true,
	senderStatus: undefined,
	category: 'person',
	categorySource: 'heuristic',
	isSecurityMail: false,
	isExactWordingCandidate: false,
	budget: 'normal',
};

const decide = (patch: Partial<ChooseArrivalDepthInput>) =>
	chooseArrivalDepth({ ...base, ...patch });
const keysOf = (patch: Partial<ChooseArrivalDepthInput>) =>
	decide(patch).reasonKeys.map((r) => r.key);

describe('chooseArrivalDepth, one test per row of the §2.2 table', () => {
	it('row 1: AI off or ineligible reads nothing, terminally', () => {
		expect(decide({ isAiOn: false })).toEqual({
			depth: 'none',
			reasonKeys: [{ key: ARRIVAL_DEPTH_REASONS.aiOff }],
			isUpgradeable: false,
		});
		expect(decide({ isEligible: false })).toMatchObject({ depth: 'none', isUpgradeable: false });
		expect(keysOf({ isEligible: false })).toEqual([ARRIVAL_DEPTH_REASONS.ineligible]);
		// Row 1 wins over everything below it, open work included.
		expect(decide({ isAiOn: false, isDisplayOnly: false }).depth).toBe('none');
	});

	it('row 2: open work keeps the full read, whatever else holds', () => {
		expect(decide({ isDisplayOnly: false })).toMatchObject({ depth: 'full', isUpgradeable: false });
		expect(keysOf({ isDisplayOnly: false })).toEqual([ARRIVAL_DEPTH_REASONS.openWork]);
		// Never lowered by budget, overrides, sender status or category.
		for (const patch of [
			{ budget: 'refused' as const },
			{ placementOverride: 'digest' as const },
			{ senderStatus: 'unsubscribed' as const },
			{ category: 'newsletter' as const },
			{ isSecurityMail: true },
			{ isReadOnArrival: false },
		]) {
			expect(decide({ isDisplayOnly: false, ...patch }).depth).toBe('full');
		}
	});

	it('row 3: the preference off defers (deferred)', () => {
		expect(decide({ isReadOnArrival: false })).toMatchObject({ depth: 'deferred' });
		expect(keysOf({ isReadOnArrival: false })).toEqual([ARRIVAL_DEPTH_REASONS.readOnArrivalOff]);
	});

	it('row 4: an unsubscribed or auto-archived sender reads nothing, terminally', () => {
		for (const senderStatus of ['unsubscribed', 'auto_archive'] as const) {
			expect(decide({ senderStatus })).toEqual({
				depth: 'none',
				reasonKeys: [{ key: ARRIVAL_DEPTH_REASONS.senderStatus, params: { status: senderStatus } }],
				isUpgradeable: false,
			});
		}
	});

	it('row 5: security mail reads nothing, terminally', () => {
		expect(decide({ isSecurityMail: true })).toMatchObject({ depth: 'none', isUpgradeable: false });
		expect(keysOf({ isSecurityMail: true })).toEqual([ARRIVAL_DEPTH_REASONS.security]);
	});

	it('row 6: a refused budget counts, upgradeable', () => {
		expect(decide({ budget: 'refused' })).toEqual({
			depth: 'count',
			reasonKeys: [{ key: ARRIVAL_DEPTH_REASONS.budget }],
			isUpgradeable: true,
		});
	});

	it('row 7: digest override, a sendToDigest rule or a digest sender count', () => {
		expect(decide({ placementOverride: 'digest' })).toEqual({
			depth: 'count',
			reasonKeys: [{ key: ARRIVAL_DEPTH_REASONS.digest, params: { by: 'override' } }],
			isUpgradeable: true,
		});
		expect(decide({ ruleDepthHint: 'count' }).reasonKeys).toEqual([
			{ key: ARRIVAL_DEPTH_REASONS.digest, params: { by: 'rule' } },
		]);
		expect(decide({ senderStatus: 'digest' }).reasonKeys).toEqual([
			{ key: ARRIVAL_DEPTH_REASONS.digest, params: { by: 'sender' } },
		]);
		expect(decide({ senderStatus: 'digest', category: 'person' }).depth).toBe('count');
	});

	it('row 7: only the message-scope digest Fix still counts an exact-wording candidate', () => {
		expect(
			decide({ placementOverride: 'digest', isExactWordingCandidate: true, category: 'person' })
		).toEqual({
			depth: 'count',
			reasonKeys: [{ key: ARRIVAL_DEPTH_REASONS.digest, params: { by: 'override' } }],
			isUpgradeable: true,
		});
	});

	it('row 8: a digest rule or a digest sender never counts an exact-wording candidate (#1384)', () => {
		for (const patch of [
			{ ruleDepthHint: 'count' as const },
			{ senderStatus: 'digest' as const },
			{ ruleDepthHint: 'count' as const, senderStatus: 'digest' as const },
		]) {
			for (const category of ['person', 'newsletter', 'promotion', 'notification'] as const) {
				expect(decide({ ...patch, category, isExactWordingCandidate: true })).toEqual({
					depth: 'full',
					reasonKeys: [
						{ key: ARRIVAL_DEPTH_REASONS.category, params: { category, source: 'heuristic' } },
						{ key: ARRIVAL_DEPTH_REASONS.exactWording },
					],
					isUpgradeable: false,
				});
			}
		}
	});

	it('row 9: a needs_me or today override reads in full', () => {
		for (const placementOverride of ['needs_me', 'today'] as const) {
			expect(decide({ placementOverride, category: 'newsletter' })).toEqual({
				depth: 'full',
				reasonKeys: [
					{ key: ARRIVAL_DEPTH_REASONS.override, params: { placement: placementOverride } },
				],
				isUpgradeable: false,
			});
		}
	});

	it('row 10: an updates override gists, unless the wording must be exact', () => {
		expect(decide({ placementOverride: 'updates', category: 'person' })).toEqual({
			depth: 'gist',
			reasonKeys: [{ key: ARRIVAL_DEPTH_REASONS.override, params: { placement: 'updates' } }],
			isUpgradeable: true,
		});
		// The exact-wording candidate is read in full, whatever its category.
		const exact = { placementOverride: 'updates' as const, isExactWordingCandidate: true };
		expect(decide({ ...exact, category: 'person' }).depth).toBe('full');
		expect(decide({ ...exact, category: 'receipt' }).depth).toBe('full');
		expect(decide({ ...exact, category: 'newsletter' }).depth).toBe('full');
	});

	it('row 11: an exact-wording candidate reads in full, whatever its category (#1384)', () => {
		for (const category of [
			'newsletter',
			'promotion',
			'notification',
			'receipt',
			'person',
			'other',
		] as const) {
			expect(decide({ category, isExactWordingCandidate: true })).toEqual({
				depth: 'full',
				reasonKeys: [
					{ key: ARRIVAL_DEPTH_REASONS.category, params: { category, source: 'heuristic' } },
					{ key: ARRIVAL_DEPTH_REASONS.exactWording },
				],
				isUpgradeable: false,
			});
		}
	});

	it('row 12: newsletters and promotions count, upgradeable', () => {
		for (const category of ['newsletter', 'promotion'] as const) {
			expect(decide({ category })).toEqual({
				depth: 'count',
				reasonKeys: [
					{ key: ARRIVAL_DEPTH_REASONS.category, params: { category, source: 'heuristic' } },
				],
				isUpgradeable: true,
			});
		}
	});

	it('row 13: notifications and receipts gist, upgradeable', () => {
		for (const category of ['notification', 'receipt'] as const) {
			expect(decide({ category })).toEqual({
				depth: 'gist',
				reasonKeys: [
					{ key: ARRIVAL_DEPTH_REASONS.category, params: { category, source: 'heuristic' } },
				],
				isUpgradeable: true,
			});
		}
	});

	it('row 14: person and other mail read in full', () => {
		for (const category of ['person', 'other', 'spam'] as const) {
			expect(decide({ category })).toMatchObject({ depth: 'full', isUpgradeable: false });
		}
	});
});

describe('chooseArrivalDepth, combinations', () => {
	it('an override never buys a read past the budget', () => {
		for (const placementOverride of ['needs_me', 'today', 'updates', 'digest'] as const) {
			expect(decide({ placementOverride, budget: 'refused' })).toMatchObject({
				depth: 'count',
				reasonKeys: [{ key: ARRIVAL_DEPTH_REASONS.budget }],
			});
		}
		expect(decide({ ruleDepthHint: 'count', budget: 'refused' }).reasonKeys).toEqual([
			{ key: ARRIVAL_DEPTH_REASONS.budget },
		]);
	});

	it('an exact-wording candidate never reads past the budget or a terminal exclusion', () => {
		const exact = { isExactWordingCandidate: true, senderStatus: 'digest' as const };
		expect(decide({ ...exact, budget: 'refused' })).toEqual({
			depth: 'count',
			reasonKeys: [{ key: ARRIVAL_DEPTH_REASONS.budget }],
			isUpgradeable: true,
		});
		expect(decide({ ...exact, isSecurityMail: true }).depth).toBe('none');
		for (const senderStatus of ['unsubscribed', 'auto_archive'] as const) {
			expect(decide({ ...exact, senderStatus }).depth).toBe('none');
		}
	});

	it('the terminal exclusions come before the budget', () => {
		expect(decide({ isSecurityMail: true, budget: 'refused' }).depth).toBe('none');
		expect(decide({ senderStatus: 'auto_archive', budget: 'refused' }).depth).toBe('none');
	});

	it('the preference off defers, whatever the sender status or budget', () => {
		for (const senderStatus of ['unsubscribed', 'auto_archive', 'digest', 'keep'] as const) {
			expect(decide({ isReadOnArrival: false, senderStatus }).depth).toBe('deferred');
		}
		expect(decide({ isReadOnArrival: false, budget: 'refused' }).depth).toBe('deferred');
		expect(decide({ isReadOnArrival: false, isSecurityMail: true }).depth).toBe('deferred');
	});

	it('a user category decides like a heuristic one, and the reason names its source', () => {
		for (const category of ['newsletter', 'notification', 'person'] as const) {
			const heuristic = decide({ category, categorySource: 'heuristic' });
			const user = decide({ category, categorySource: 'user' });
			expect(user.depth).toBe(heuristic.depth);
			expect(user.reasonKeys[0]).toEqual({
				key: ARRIVAL_DEPTH_REASONS.category,
				params: { category, source: 'user' },
			});
		}
	});

	it('overrides apply before the category', () => {
		expect(decide({ placementOverride: 'today', category: 'promotion' }).depth).toBe('full');
		expect(decide({ placementOverride: 'digest', category: 'person' }).depth).toBe('count');
		expect(decide({ placementOverride: 'updates', category: 'newsletter' }).depth).toBe('gist');
		// An archived override is no depth row: the category decides.
		expect(decide({ placementOverride: 'archived', category: 'receipt' }).depth).toBe('gist');
	});

	it('a keep sender is the same as no profile', () => {
		expect(decide({ senderStatus: 'keep', category: 'receipt' })).toEqual(
			decide({ category: 'receipt' })
		);
	});
});
