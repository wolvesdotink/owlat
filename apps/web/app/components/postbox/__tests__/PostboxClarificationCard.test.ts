// @vitest-environment happy-dom
/**
 * PostboxClarificationCard — the "Needs your input" Reply Queue card.
 *
 * Covers:
 *   - the asking state renders the question, its scoped-option chips and a
 *     free-text box, and answering (chip tap → Answer) emits the collected
 *     answers to the parent;
 *   - a free-typed answer is emitted too;
 *   - once the persisted clarification carries a draft the card flips to
 *     "Draft ready" and Open draft emits the generated starter reply;
 *   - the drafting spinner offers the NON-destructive "I'll answer later"
 *     escape (emits `defer`) next to the destructive Dismiss;
 *   - the card-scoped keyboard: 1–9 picks a chip, Enter answers, s defers —
 *     and stays inert while the free-text input is focused.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { reactive } from 'vue';

import PostboxClarificationCard from '../PostboxClarificationCard.vue';
import type { ReplyQueueItem } from '~/utils/postboxReplyQueue';

beforeAll(() => {
	// The vitest setup polyfills ref/computed; this component also uses reactive.
	vi.stubGlobal('reactive', reactive);
});

const iconStub = { props: ['name'], template: '<span />' };
const avatarStub = { props: ['name', 'email'], template: '<span />' };

function makeItem(over: Partial<ReplyQueueItem['clarification']> = {}): ReplyQueueItem {
	return {
		kind: 'needs_reply',
		threadId: 'thread-1',
		messageId: 'msg-1',
		urgency: 'normal',
		detectedAt: 1,
		source: 'llm',
		fromAddress: 'ann@acme.com',
		fromName: 'Ann',
		subject: 'Refund?',
		snippet: 'Can you approve the refund?',
		receivedAt: 1,
		clarification: {
			isNeeded: true,
			askedAt: 1,
			questions: [
				{
					id: 'clarify_0',
					slotType: 'decision',
					text: 'Should we approve the refund?',
					attribution:
						'Generated from an email from acme.com — Owlat will never ask for your password.',
					options: ['Yes', 'No'],
				},
			],
			...over,
		},
	};
}

function mountCard(item: ReplyQueueItem) {
	return mount(PostboxClarificationCard, {
		props: { item },
		global: { stubs: { Icon: iconStub, UiAvatar: avatarStub } },
	});
}

describe('PostboxClarificationCard', () => {
	it('renders the question, scoped chips and a free-text box (asking state)', () => {
		const wrapper = mountCard(makeItem());
		expect(wrapper.text()).toContain('Needs your input');
		expect(wrapper.text()).toContain('Should we approve the refund?');
		expect(wrapper.text()).toContain('never ask for your password');
		const chips = wrapper.findAll('[data-testid="clarification-chip"]');
		// Chips carry a numeric kbd affordance (1–9 picks a chip) + the option text.
		expect(chips).toHaveLength(2);
		expect(chips[0]!.text()).toContain('Yes');
		expect(chips[1]!.text()).toContain('No');
		expect(wrapper.find('[data-testid="clarification-input"]').exists()).toBe(true);
	});

	it('emits the picked chip answer to the parent', async () => {
		const wrapper = mountCard(makeItem());
		await wrapper.findAll('[data-testid="clarification-chip"]')[0]!.trigger('click');
		await wrapper.find('[data-testid="clarification-submit"]').trigger('click');
		const emitted = wrapper.emitted('answer');
		expect(emitted).toBeTruthy();
		expect(emitted![0]![0]).toEqual([{ questionId: 'clarify_0', value: 'Yes' }]);
	});

	it('emits a free-typed answer', async () => {
		const wrapper = mountCard(makeItem());
		await wrapper.find('[data-testid="clarification-input"]').setValue('Refund half');
		await wrapper.find('[data-testid="clarification-submit"]').trigger('click');
		expect(wrapper.emitted('answer')![0]![0]).toEqual([
			{ questionId: 'clarify_0', value: 'Refund half' },
		]);
	});

	it('typing a free-text answer visually deselects a picked chip', async () => {
		const wrapper = mountCard(makeItem());
		const chip = wrapper.findAll('[data-testid="clarification-chip"]')[0]!;
		await chip.trigger('click');
		expect(chip.attributes('aria-pressed')).toBe('true');
		await wrapper.find('[data-testid="clarification-input"]').setValue('Refund half');
		expect(chip.attributes('aria-pressed')).toBe('false');
		await wrapper.find('[data-testid="clarification-submit"]').trigger('click');
		expect(wrapper.emitted('answer')![0]![0]).toEqual([
			{ questionId: 'clarify_0', value: 'Refund half' },
		]);
	});

	it('keyboard: 1 picks the first chip, Enter submits it (card-scoped, no window handler)', async () => {
		const wrapper = mountCard(makeItem());
		await wrapper.trigger('keydown', { key: '1' });
		expect(
			wrapper.findAll('[data-testid="clarification-chip"]')[0]!.attributes('aria-pressed')
		).toBe('true');
		await wrapper.trigger('keydown', { key: 'Enter' });
		expect(wrapper.emitted('answer')![0]![0]).toEqual([{ questionId: 'clarify_0', value: 'Yes' }]);
	});

	it('keyboard: s emits the non-destructive defer; keys are inert while typing', async () => {
		const wrapper = mountCard(makeItem());
		// Inert while the free-text input has focus — typing "s" is typing.
		await wrapper.find('[data-testid="clarification-input"]').trigger('keydown', { key: 's' });
		expect(wrapper.emitted('defer')).toBeFalsy();
		await wrapper.trigger('keydown', { key: 's' });
		expect(wrapper.emitted('defer')).toBeTruthy();
	});

	it('the drafting state offers "I\'ll answer later" (defer) next to the destructive Dismiss', async () => {
		const wrapper = mountCard(makeItem({ answeredAt: 2 }));
		expect(wrapper.find('[data-testid="clarification-drafting"]').exists()).toBe(true);
		await wrapper.find('[data-testid="clarification-drafting-defer"]').trigger('click');
		expect(wrapper.emitted('defer')).toBeTruthy();
		expect(wrapper.emitted('done')).toBeFalsy();
		await wrapper.find('[data-testid="clarification-drafting-dismiss"]').trigger('click');
		expect(wrapper.emitted('done')).toBeTruthy();
	});

	it('flips to "Draft ready" once a draft is present and emits it on open', async () => {
		const wrapper = mountCard(
			makeItem({
				answeredAt: 2,
				draft: 'Hi Ann — yes, we can approve the refund.',
			})
		);
		expect(wrapper.text()).toContain('Draft ready');
		expect(wrapper.text()).toContain('we can approve the refund');
		expect(wrapper.find('[data-testid="clarification-chip"]').exists()).toBe(false);
		await wrapper.find('[data-testid="clarification-open-draft"]').trigger('click');
		expect(wrapper.emitted('open-draft')![0]![0]).toBe('Hi Ann — yes, we can approve the refund.');
	});
});
