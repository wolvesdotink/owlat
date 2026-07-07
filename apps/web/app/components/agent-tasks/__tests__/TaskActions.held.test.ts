// @vitest-environment happy-dom
/**
 * TaskActions collision soft-hold (UX piece b3b).
 *
 * When a teammate is actively replying to the same thread, the primary
 * send/approve action renders HELD — disabled-styled but still visible — with a
 * plain-language reason beneath it. The hold is advisory and releases on its own
 * when the teammate's presence drops, which for this presentational component is
 * simply `held` flipping back to false (driven by the parent's live presence).
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';

import TaskActions from '../TaskActions.vue';

const stubs = { Icon: { template: '<i />' } };

function mountActions(props: Record<string, unknown> = {}) {
	return mount(TaskActions, {
		props: { primaryLabel: 'Approve & Send', ...props },
		global: { stubs },
	});
}

const primarySel = '[data-testid="task-primary"]';
const reasonSel = '[data-testid="task-held-reason"]';

describe('TaskActions — collision soft-hold', () => {
	it('renders the held reason and disables the primary action while held', () => {
		const reason = 'held while Jordan is editing — takes over automatically if they leave';
		const wrapper = mountActions({ held: true, heldReason: reason });

		// Button stays visible (not hidden) but is disabled — never a lock/modal.
		const primary = wrapper.find(primarySel);
		expect(primary.exists()).toBe(true);
		expect(primary.attributes('disabled')).toBeDefined();
		expect(primary.attributes('aria-disabled')).toBe('true');

		// The plain-language reason is shown beneath the row.
		expect(wrapper.find(reasonSel).text()).toContain(reason);
	});

	it('does not emit primary while held even if clicked', async () => {
		const wrapper = mountActions({ held: true, heldReason: 'held while Amir is editing' });
		await wrapper.find(primarySel).trigger('click');
		expect(wrapper.emitted('primary')).toBeUndefined();
	});

	it('releases the hold when presence drops: reason gone, primary enabled, emits again', async () => {
		const wrapper = mountActions({ held: true, heldReason: 'held while Jordan is editing' });
		expect(wrapper.find(reasonSel).exists()).toBe(true);

		// Teammate left → parent flips `held` back to false (no reason shown).
		await wrapper.setProps({ held: false, heldReason: undefined });
		expect(wrapper.find(reasonSel).exists()).toBe(false);

		const primary = wrapper.find(primarySel);
		expect(primary.attributes('disabled')).toBeUndefined();
		expect(primary.attributes('aria-disabled')).toBeUndefined();

		await primary.trigger('click');
		expect(wrapper.emitted('primary')).toHaveLength(1);
	});

	it('is not held by default (no reason line, primary enabled)', () => {
		const wrapper = mountActions();
		expect(wrapper.find(reasonSel).exists()).toBe(false);
		expect(wrapper.find(primarySel).attributes('disabled')).toBeUndefined();
	});
});
