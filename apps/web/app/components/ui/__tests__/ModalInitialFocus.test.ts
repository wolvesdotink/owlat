/**
 * WHERE FOCUS LANDS WHEN A DIALOG OPENS, AND WHERE IT GOES WHEN IT CLOSES.
 *
 * UiModal used to focus the first focusable descendant, which is the header's
 * Close button whenever the dialog is closable, so every confirmation opened
 * on Close. A dialog without a single control fell back to focusing the panel,
 * a div with no tabindex, so that call did nothing and focus stayed on the page
 * behind the backdrop.
 *
 * The panel is now focusable (tabindex="-1") so the fallback lands, UiModal
 * takes an `initialFocus` target, and UiConfirmationDialog points it at Cancel:
 * Enter on a freshly opened confirmation never performs the action.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import UiModal from '@owlat/ui/components/ui/Modal.vue';
import UiButton from '@owlat/ui/components/ui/Button.vue';
import UiConfirmationDialog from '@owlat/ui/components/ui/ConfirmationDialog.vue';
import { createTestI18n } from '~/__tests__/i18n';

const global = {
	components: { UiModal, UiButton },
	plugins: [createTestI18n()],
	stubs: { teleport: true },
};

afterEach(() => {
	for (const el of document.querySelectorAll('[data-opener]')) el.remove();
});

function opener(label = 'Open') {
	const button = document.createElement('button');
	button.textContent = label;
	button.dataset['opener'] = '';
	document.body.append(button);
	button.focus();
	return button;
}

function tab(shiftKey = false) {
	const event = new KeyboardEvent('keydown', {
		key: 'Tab',
		shiftKey,
		bubbles: true,
		cancelable: true,
	});
	(document.activeElement ?? document.body).dispatchEvent(event);
	return event;
}

const active = () => document.activeElement as HTMLElement | null;

function mountConfirmation(props: Record<string, unknown> = {}) {
	return mount(UiConfirmationDialog, {
		props: { open: false, title: 'Delete topic', confirmText: 'Delete topic', ...props },
		attachTo: document.body,
		global,
	});
}

async function open(wrapper: { setProps: (p: Record<string, unknown>) => Promise<void> }) {
	await wrapper.setProps({ open: true });
	await flushPromises();
}

describe('UiConfirmationDialog initial focus', () => {
	it.each(['danger', 'warning', 'default'] as const)(
		'focuses Cancel, not Close or the action, for the %s variant',
		async (variant) => {
			opener();
			const wrapper = mountConfirmation({ variant });
			await open(wrapper);
			expect(active()?.textContent?.trim()).toBe('Cancel');
		}
	);

	it('focuses the action when the consumer asks for it', async () => {
		opener();
		const wrapper = mountConfirmation({ initialFocus: 'confirm' });
		await open(wrapper);
		expect(active()?.textContent?.trim()).toBe('Delete topic');
	});

	it('falls back to Cancel when the requested action is refused', async () => {
		opener();
		const wrapper = mountConfirmation({ initialFocus: 'confirm', confirmDisabled: true });
		await open(wrapper);
		expect(active()?.textContent?.trim()).toBe('Cancel');
	});

	it('focuses the panel when every control is disabled mid-request', async () => {
		opener();
		const wrapper = mountConfirmation({ isLoading: true });
		await open(wrapper);
		expect(active()).toBe(wrapper.find('[role="dialog"]').element);
	});

	it('restores focus to the opener when it closes', async () => {
		const trigger = opener('Delete topic');
		const wrapper = mountConfirmation({ variant: 'danger' });
		await open(wrapper);
		expect(active()).not.toBe(trigger);
		await wrapper.setProps({ open: false });
		await flushPromises();
		expect(active()).toBe(trigger);
	});

	it('returns focus to the parent dialog when a stacked confirmation closes', async () => {
		const trigger = opener();
		const parent = mount(UiModal, {
			props: { open: true, title: 'Edit topic' },
			slots: { default: () => h('button', { 'data-testid': 'delete' }, 'Delete this topic') },
			attachTo: document.body,
			global,
		});
		await flushPromises();
		const deleteButton = parent.find('[data-testid="delete"]').element as HTMLElement;
		deleteButton.focus();
		const confirmation = mountConfirmation({ variant: 'danger' });
		await open(confirmation);
		expect(active()?.textContent?.trim()).toBe('Cancel');
		await confirmation.setProps({ open: false });
		await flushPromises();
		expect(active()).toBe(deleteButton);
		await parent.setProps({ open: false });
		await flushPromises();
		expect(active()).toBe(trigger);
	});
});

describe('UiModal initial focus', () => {
	function mountModal(props: Record<string, unknown>, body?: () => ReturnType<typeof h>[]) {
		return mount(UiModal, {
			props: { open: false, ...props },
			slots: body ? { default: body } : {},
			attachTo: document.body,
			global,
		});
	}

	it('focuses the panel itself when it holds no control, and keeps Tab there', async () => {
		const trigger = opener();
		const wrapper = mountModal({ closable: false, persistent: true }, () => [
			h('p', 'Importing your mailbox…'),
		]);
		await open(wrapper);
		const panel = wrapper.find('[role="dialog"]').element;
		expect(panel?.getAttribute('tabindex')).toBe('-1');
		expect(active()).toBe(panel);
		expect(tab().defaultPrevented).toBe(true);
		expect(active()).toBe(panel);
		expect(tab(true).defaultPrevented).toBe(true);
		expect(active()).toBe(panel);
		await wrapper.setProps({ open: false });
		await flushPromises();
		expect(active()).toBe(trigger);
	});

	it('focuses the first control by default, which is Close on a closable dialog', async () => {
		opener();
		const wrapper = mountModal({ title: 'Rename' }, () => [h('input', { name: 'name' })]);
		await open(wrapper);
		expect(active()?.getAttribute('aria-label')).toBeTruthy();
		expect(active()?.tagName).toBe('BUTTON');
	});

	it('focuses an initialFocus selector resolved inside the panel', async () => {
		opener();
		const wrapper = mountModal({ title: 'Rename', initialFocus: 'input[name="name"]' }, () => [
			h('input', { name: 'name' }),
		]);
		await open(wrapper);
		expect(active()?.getAttribute('name')).toBe('name');
	});

	it('accepts an element as the initialFocus target', async () => {
		opener();
		const isOpen = ref(false);
		const target = ref<HTMLElement | null>(null);
		const wrapper = mount(
			defineComponent({
				setup() {
					return () =>
						h('div', [
							h('input', { name: 'outside', ref: target }),
							h(
								UiModal,
								{ open: isOpen.value, title: 'Rename', initialFocus: target.value },
								{ default: () => [h('input', { name: 'inside' })] }
							),
						]);
				},
			}),
			{ attachTo: document.body, global }
		);
		await flushPromises();
		// An element outside the panel is ignored: focus never leaves the dialog.
		isOpen.value = true;
		await flushPromises();
		expect(active()?.tagName).toBe('BUTTON');
	});

	it('focuses an element target that lives inside the panel', async () => {
		opener();
		const isOpen = ref(false);
		const target = ref<HTMLElement | null>(null);
		mount(
			defineComponent({
				setup() {
					return () =>
						h(
							UiModal,
							{ open: isOpen.value, title: 'Rename', initialFocus: target.value },
							{ default: () => [h('button', 'Other'), h('input', { name: 'name', ref: target })] }
						);
				},
			}),
			// The real Teleport: the stub re-creates its children on every render,
			// so the ref would never settle.
			{ attachTo: document.body, global: { ...global, stubs: {} } }
		);
		isOpen.value = true;
		await flushPromises();
		expect(target.value).not.toBeNull();
		expect(active()).toBe(target.value);
	});

	it('keeps Tab inside from a tabindex="-1" initial target that precedes the controls', async () => {
		opener();
		const wrapper = mountModal({ closable: false, initialFocus: '#intro' }, () => [
			h('h3', { id: 'intro', tabindex: -1 }, 'Before you continue'),
			h('button', 'Back'),
			h('button', 'Continue'),
		]);
		await open(wrapper);
		const intro = wrapper.find('#intro').element as HTMLElement;
		const [back, next] = wrapper.findAll('button').map((b) => b.element);
		expect(active()).toBe(intro);
		expect(tab(true).defaultPrevented).toBe(true);
		expect(active()).toBe(next);
		intro.focus();
		expect(tab().defaultPrevented).toBe(true);
		expect(active()).toBe(back);
	});

	it('keeps Tab inside when the panel itself holds focus', async () => {
		opener();
		const wrapper = mountModal({ closable: false }, () => [
			h('button', 'Back'),
			h('button', 'Continue'),
		]);
		await open(wrapper);
		const panel = wrapper.find('[role="dialog"]').element as HTMLElement;
		const [back, next] = wrapper.findAll('button').map((b) => b.element);
		panel.focus();
		expect(tab(true).defaultPrevented).toBe(true);
		expect(active()).toBe(next);
		panel.focus();
		expect(tab().defaultPrevented).toBe(true);
		expect(active()).toBe(back);
	});

	it('ignores a target that cannot take focus and uses the first control', async () => {
		opener();
		const wrapper = mountModal({ title: 'Rename', initialFocus: '[data-missing]' }, () => [
			h('input', { name: 'name' }),
		]);
		await open(wrapper);
		expect(active()?.tagName).toBe('BUTTON');
	});
});
