// @vitest-environment happy-dom
/**
 * The recipient readout is no longer one number — a bounded count reports HOW
 * complete it is, and the picker renders that as a `+` suffix ("at least this
 * many"). Three of the four `completeness` values must NOT earn the suffix, and
 * one of those (`suppression_truncated`) is an OVER-count, where "at least"
 * would be actively wrong.
 */
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import SetupAudiencePicker from '../SetupAudiencePicker.vue';

type Completeness =
	| 'exact'
	| 'candidate_capped'
	| 'read_budget_exhausted'
	| 'suppression_truncated';

const stubs = { Icon: { template: '<i />' } };

function renderCount(
	audienceCount: { eligible: number; total: number; completeness: Completeness } | null
): string {
	const wrapper = mount(SetupAudiencePicker, {
		props: {
			topics: [],
			segments: [],
			audienceCount,
			error: null,
			audienceType: 'topic' as const,
			selectedTopicId: null,
			selectedSegmentId: null,
		},
		global: { stubs },
	});
	return wrapper.find('[data-testid="audience-eligible-count"]').text();
}

describe('SetupAudiencePicker — the eligible-recipient readout', () => {
	it('renders an exact count as a plain number', () => {
		expect(renderCount({ eligible: 1234, total: 1300, completeness: 'exact' })).toBe('1,234');
	});

	it('marks a capped enumeration as a lower bound', () => {
		expect(renderCount({ eligible: 25_000, total: 25_000, completeness: 'candidate_capped' })).toBe(
			'25,000+'
		);
	});

	it('marks a budget-stopped enumeration as a lower bound', () => {
		expect(
			renderCount({ eligible: 3_000, total: 3_000, completeness: 'read_budget_exhausted' })
		).toBe('3,000+');
	});

	/** An OVER-count bounds nothing from below — "at least" would be a lie. */
	it('never marks a truncated suppression set as a lower bound', () => {
		expect(renderCount({ eligible: 600, total: 600, completeness: 'suppression_truncated' })).toBe(
			'600'
		);
	});

	it('renders zero while the count is still loading', () => {
		expect(renderCount(null)).toBe('0');
	});
});
