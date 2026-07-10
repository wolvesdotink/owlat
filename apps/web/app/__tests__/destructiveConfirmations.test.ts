// @vitest-environment happy-dom
/**
 * Irreversible one-click destructive actions must not fire immediately. Deleting
 * a chat (assistant) and blocking a sender (quarantine) now go through the shared
 * UiConfirmationDialog; removing a Postbox contact now surfaces an undo toast.
 *
 * Two layers of coverage:
 *   1. A behavioural harness proves the confirm-gate contract — the trigger only
 *      arms the action, cancel discards it without mutating, and confirm is what
 *      actually mutates (exactly once).
 *   2. Source assertions prove the three real pages adopt that gate rather than
 *      calling their mutation straight from the trigger's click handler.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineComponent, h, ref } from 'vue';
import { mount } from '@vue/test-utils';

// Mirrors the pending-target + confirm/cancel pattern the pages use. The mutation
// is a spy so we can assert exactly when (and whether) it runs.
function makeGateHarness(mutate: () => void) {
	return defineComponent({
		setup() {
			const pending = ref<{ id: string } | null>(null);
			const arm = () => {
				pending.value = { id: 'target-1' };
			};
			const cancel = () => {
				pending.value = null;
			};
			const confirm = () => {
				if (!pending.value) return;
				mutate();
				pending.value = null;
			};
			return { pending, arm, cancel, confirm };
		},
		render() {
			return h('div', [
				h('button', { class: 'trigger', onClick: this.arm }, 'delete'),
				this.pending
					? h('div', { class: 'dialog' }, [
							h('button', { class: 'cancel', onClick: this.cancel }, 'cancel'),
							h('button', { class: 'confirm', onClick: this.confirm }, 'confirm'),
						])
					: null,
			]);
		},
	});
}

describe('destructive confirmation gate', () => {
	it('arms but does not mutate when the trigger is clicked', async () => {
		const mutate = vi.fn();
		const wrapper = mount(makeGateHarness(mutate));

		await wrapper.find('button.trigger').trigger('click');

		expect(mutate).not.toHaveBeenCalled();
		expect(wrapper.find('.dialog').exists()).toBe(true);
	});

	it('cancel discards the action without mutating', async () => {
		const mutate = vi.fn();
		const wrapper = mount(makeGateHarness(mutate));

		await wrapper.find('button.trigger').trigger('click');
		await wrapper.find('button.cancel').trigger('click');

		expect(mutate).not.toHaveBeenCalled();
		expect(wrapper.find('.dialog').exists()).toBe(false);
	});

	it('confirm mutates exactly once and closes the dialog', async () => {
		const mutate = vi.fn();
		const wrapper = mount(makeGateHarness(mutate));

		await wrapper.find('button.trigger').trigger('click');
		await wrapper.find('button.confirm').trigger('click');

		expect(mutate).toHaveBeenCalledTimes(1);
		expect(wrapper.find('.dialog').exists()).toBe(false);
	});
});

const readPage = (relPath: string) =>
	readFileSync(resolve(__dirname, '..', 'pages', relPath), 'utf8');

describe('assistant chat delete confirms first', () => {
	const source = readPage('dashboard/assistant/index.vue');

	it('routes the trash button to a pending target instead of removing directly', () => {
		expect(source).toContain('pendingDelete = {');
		expect(source).not.toContain('onDelete(c._id)');
	});

	it('performs the removal only from the confirmation dialog', () => {
		expect(source).toContain('<UiConfirmationDialog');
		expect(source).toContain('@confirm="confirmDelete"');
		expect(source).toMatch(/confirmDelete[\s\S]*await remove\(/);
	});
});

describe('quarantine block-sender confirms first', () => {
	const source = readPage('dashboard/inbox/quarantine.vue');

	it('routes the block button to a pending target instead of blocking directly', () => {
		expect(source).toContain('pendingBlock = {');
		expect(source).not.toContain('@click="onBlock(message._id)"');
	});

	it('performs the block only from the confirmation dialog', () => {
		expect(source).toContain('<UiConfirmationDialog');
		expect(source).toContain('@confirm="confirmBlock"');
		expect(source).toMatch(/confirmBlock[\s\S]*await onBlock\(/);
	});
});

describe('postbox contact removal offers undo', () => {
	const source = readPage('dashboard/postbox/contacts.vue');

	it('routes the trash button through a handler rather than removing silently', () => {
		expect(source).toContain('@click="removeContact(c)"');
		expect(source).not.toContain('@click="remove(c._id as Id<\'mailContacts\'>)"');
	});

	it('shows an undo toast that re-adds the contact', () => {
		expect(source).toMatch(/showToast\([\s\S]*label: 'Undo'/);
		expect(source).toMatch(/onAction[\s\S]*save\(/);
	});
});
