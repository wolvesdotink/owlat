/**
 * Mark-as-read policy derivations: an unset value is exactly the pre-existing
 * mark-on-render behaviour, the three modes map to the three things the reader
 * can do on open, and the manual affordance only appears when it has work to do.
 */
import { describe, it, expect } from 'vitest';
import {
	POSTBOX_MARK_READ_DWELL_MS,
	POSTBOX_MARK_READ_POLICY_DEFAULT,
	POSTBOX_MARK_READ_POLICY_OPTIONS,
	markReadOnOpen,
	resolvePostboxMarkReadPolicy,
	showsManualMarkRead,
} from '../postboxMarkReadPolicy';

describe('resolvePostboxMarkReadPolicy', () => {
	it("defaults an unset preference to immediate — today's behaviour", () => {
		expect(resolvePostboxMarkReadPolicy(undefined)).toBe('immediate');
		expect(resolvePostboxMarkReadPolicy(null)).toBe('immediate');
		expect(POSTBOX_MARK_READ_POLICY_DEFAULT).toBe('immediate');
	});

	it('passes through every valid policy', () => {
		expect(resolvePostboxMarkReadPolicy('immediate')).toBe('immediate');
		expect(resolvePostboxMarkReadPolicy('after-dwell')).toBe('after-dwell');
		expect(resolvePostboxMarkReadPolicy('manual')).toBe('manual');
	});

	it('normalises an unknown stored value to immediate', () => {
		expect(resolvePostboxMarkReadPolicy('on-scroll')).toBe('immediate');
	});
});

describe('markReadOnOpen', () => {
	it('fires immediately, defers, or never fires', () => {
		expect(markReadOnOpen('immediate')).toBe('now');
		expect(markReadOnOpen('after-dwell')).toBe('defer');
		expect(markReadOnOpen('manual')).toBe('never');
	});

	it('uses a dwell short enough to feel automatic but long enough to skim past', () => {
		expect(POSTBOX_MARK_READ_DWELL_MS).toBeGreaterThanOrEqual(1000);
		expect(POSTBOX_MARK_READ_DWELL_MS).toBeLessThanOrEqual(5000);
	});
});

describe('showsManualMarkRead', () => {
	it('only offers the button under the manual policy on an unread thread', () => {
		expect(showsManualMarkRead('manual', true)).toBe(true);
		expect(showsManualMarkRead('manual', false)).toBe(false);
		expect(showsManualMarkRead('immediate', true)).toBe(false);
		expect(showsManualMarkRead('after-dwell', true)).toBe(false);
	});
});

describe('POSTBOX_MARK_READ_POLICY_OPTIONS', () => {
	it('offers every policy exactly once, each as a catalog key', () => {
		expect(POSTBOX_MARK_READ_POLICY_OPTIONS.map((o) => o.value)).toEqual([
			'immediate',
			'after-dwell',
			'manual',
		]);
		// Module scope never speaks: labels are keys the settings screen resolves.
		for (const option of POSTBOX_MARK_READ_POLICY_OPTIONS) {
			expect(option.label).toMatch(/^shared\.postboxMarkReadPolicy\./);
		}
	});
});
