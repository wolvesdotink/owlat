// @vitest-environment happy-dom
/**
 * PostboxReviewSlot — the draft-on-arrival "Draft ready — review & send" slot
 * on a Reply Queue row (postbox.aiDraft).
 *
 * Covers:
 *   - a generated slot renders the draft preview + a HUMAN trust chip
 *     ("Ready to send" / "Worth a look" / "Needs you") derived from the
 *     quality self-check — never a raw confidence percentage;
 *   - the chip popover translates self-check flags into plain-language
 *     reasons (raw flag strings never render) and keeps the numeric
 *     confidence as quiet footer detail;
 *   - a slot whose self-check failed reads "Needs you" (the old Unverified);
 *   - "Review & send" emits the draft (opens the composer — never auto-sends)
 *     and "Dismiss" emits dismiss.
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';

import PostboxReviewSlot from '../PostboxReviewSlot.vue';
import type { ReplyQueueDraftSlot } from '~/utils/postboxReplyQueue';

const iconStub = { props: ['name'], template: '<span />' };

function makeSlot(over: Partial<ReplyQueueDraftSlot> = {}): ReplyQueueDraftSlot {
	return {
		draft: 'Hi Sam — Friday works for me, see you at 2pm.',
		draftSubject: 'Re: Meeting',
		confidence: 0.85,
		quality: { score: 0.85, complete: true, grounded: true, flags: [] },
		generatedAt: 1,
		...over,
	};
}

function mountSlot(slot: ReplyQueueDraftSlot) {
	return mount(PostboxReviewSlot, {
		props: { draftSlot: slot },
		global: { stubs: { Icon: iconStub } },
	});
}

describe('PostboxReviewSlot', () => {
	it('renders the draft preview + a human trust chip from the self-check', () => {
		const wrapper = mountSlot(makeSlot());
		expect(wrapper.find('[data-testid="review-slot"]').exists()).toBe(true);
		expect(wrapper.text()).toContain('Draft ready');
		expect(wrapper.text()).toContain('Friday works for me');
		expect(wrapper.find('[data-testid="trust-chip"]').text()).toBe('Ready to send');
		// No raw percentage on the row itself.
		expect(wrapper.text()).not.toMatch(/\d+%/);
	});

	it('translates self-check flags into plain-language popover reasons — never the raw string', async () => {
		const wrapper = mountSlot(
			makeSlot({
				confidence: 0.5,
				quality: {
					score: 0.5,
					complete: false,
					grounded: true,
					flags: ['missing the date they asked about'],
				},
			})
		);
		expect(wrapper.find('[data-testid="trust-chip"]').text()).toBe('Needs you');
		await wrapper.find('[data-testid="trust-chip"]').trigger('click');
		const popover = wrapper.find('[data-testid="trust-chip-popover"]');
		expect(popover.exists()).toBe(true);
		expect(popover.text()).toContain('Mentions a date or time worth confirming');
		expect(popover.text()).not.toContain('missing the date they asked about');
		// Progressive disclosure: the number survives as quiet footer detail.
		expect(wrapper.find('[data-testid="trust-chip-detail"]').text()).toContain(
			'Agent confidence 50%'
		);
	});

	it('reads "Needs you" when the quality self-check failed (old Unverified state)', () => {
		const wrapper = mountSlot(makeSlot({ quality: undefined, confidence: 0.4 }));
		expect(wrapper.find('[data-testid="trust-chip"]').text()).toBe('Needs you');
	});

	it('shows the option count when alternatives were generated', () => {
		const wrapper = mountSlot(makeSlot({ options: ['a', 'b', 'c'] }));
		expect(wrapper.find('[data-testid="review-slot-options"]').text()).toContain('3 options');
	});

	it('emits the draft on "Review & send" (opens the composer — never sends) and dismiss', async () => {
		const wrapper = mountSlot(makeSlot());
		await wrapper.find('[data-testid="review-slot-send"]').trigger('click');
		expect(wrapper.emitted('review')![0]![0]).toBe('Hi Sam — Friday works for me, see you at 2pm.');
		await wrapper.find('[data-testid="review-slot-dismiss"]').trigger('click');
		expect(wrapper.emitted('dismiss')).toBeTruthy();
	});
});
