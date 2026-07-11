// @vitest-environment happy-dom
/**
 * Irreversible one-click destructive actions must not fire immediately. Deleting
 * a chat (assistant) and blocking a sender (quarantine) now go through the shared
 * UiConfirmationDialog; removing a Postbox contact now surfaces an undo toast.
 *
 * Two layers of coverage:
 *   1. A behavioural mount of the REAL UiConfirmationDialog proves the exact
 *      contract the pages depend on: the mutation only runs on @confirm (once),
 *      never while the dialog is closed, and never on cancel / backdrop /
 *      @update:open(false).
 *   2. Thin source assertions prove the three real pages wire that gate in rather
 *      than calling their mutation straight from the trigger's click handler.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineComponent, h, ref } from 'vue';
import { mount } from '@vue/test-utils';
import UiConfirmationDialog from '../../../../packages/ui/components/ui/ConfirmationDialog.vue';

// UiConfirmationDialog is authored against Nuxt auto-imports (UiModal/UiButton/Icon).
// Minimal stubs stand in for those so we exercise the dialog's own confirm/cancel/
// close wiring, not its dependencies.
const UiModalStub = defineComponent({
	props: { open: Boolean, persistent: Boolean, closable: Boolean },
	emits: ['update:open'],
	setup(props, { slots, emit }) {
		return () =>
			props.open
				? h('div', { class: 'modal' }, [
						h('button', { class: 'backdrop', onClick: () => emit('update:open', false) }, 'x'),
						h('div', { class: 'body' }, slots.default?.()),
						h('div', { class: 'footer' }, slots.footer?.()),
					])
				: null;
	},
});

const UiButtonStub = defineComponent({
	props: { variant: String, disabled: Boolean },
	setup(_props, { slots }) {
		// Single root <button> so the parent's @click falls through natively.
		return () => h('button', { class: 'ui-button' }, slots.default?.());
	},
});

const globalStubs = {
	global: { stubs: { UiModal: UiModalStub, UiButton: UiButtonStub, Icon: true } },
};

// Mirrors the page pattern: a trigger arms the dialog (sets :open), @confirm runs
// the mutation then closes, and @update:open drives the open state.
function mountPageLikeGate(onMutate: () => void) {
	const Harness = defineComponent({
		setup() {
			const open = ref(false);
			return { open };
		},
		render() {
			return h('div', [
				h('button', { class: 'trigger', onClick: () => (this.open = true) }, 'delete'),
				h(UiConfirmationDialog, {
					open: this.open,
					variant: 'danger',
					onConfirm: () => {
						onMutate();
						this.open = false;
					},
					'onUpdate:open': (v: boolean) => {
						this.open = v;
					},
				}),
			]);
		},
	});
	return mount(Harness, globalStubs);
}

const confirmButton = (w: ReturnType<typeof mountPageLikeGate>) =>
	w.find('.footer button[type="button"]');
const cancelButton = (w: ReturnType<typeof mountPageLikeGate>) =>
	w.find('.footer button.ui-button');

describe('UiConfirmationDialog gate (real component)', () => {
	it('does not mutate before the dialog is armed', () => {
		const mutate = vi.fn();
		const w = mountPageLikeGate(mutate);

		expect(w.find('.modal').exists()).toBe(false);
		expect(mutate).not.toHaveBeenCalled();
	});

	it('arms the dialog on the trigger without mutating', async () => {
		const mutate = vi.fn();
		const w = mountPageLikeGate(mutate);

		await w.find('button.trigger').trigger('click');

		expect(w.find('.modal').exists()).toBe(true);
		expect(mutate).not.toHaveBeenCalled();
	});

	it('mutates exactly once on confirm and closes', async () => {
		const mutate = vi.fn();
		const w = mountPageLikeGate(mutate);

		await w.find('button.trigger').trigger('click');
		await confirmButton(w).trigger('click');

		expect(mutate).toHaveBeenCalledTimes(1);
		expect(w.find('.modal').exists()).toBe(false);
	});

	it('never mutates on cancel and closes', async () => {
		const mutate = vi.fn();
		const w = mountPageLikeGate(mutate);

		await w.find('button.trigger').trigger('click');
		await cancelButton(w).trigger('click');

		expect(mutate).not.toHaveBeenCalled();
		expect(w.find('.modal').exists()).toBe(false);
	});

	it('never mutates on backdrop dismiss and closes', async () => {
		const mutate = vi.fn();
		const w = mountPageLikeGate(mutate);

		await w.find('button.trigger').trigger('click');
		await w.find('.backdrop').trigger('click');

		expect(mutate).not.toHaveBeenCalled();
		expect(w.find('.modal').exists()).toBe(false);
	});
});

const readPage = (relPath: string) =>
	readFileSync(resolve(__dirname, '..', 'pages', relPath), 'utf8');

// Thin secondary guard: prove each page routes its trigger into the gate instead
// of mutating directly, and confirms through UiConfirmationDialog.
describe('pages wire the gate in (source guard)', () => {
	it('assistant delete arms a pending target and removes only on confirm', () => {
		const source = readPage('dashboard/assistant/index.vue');
		expect(source).not.toContain('onDelete(c._id)');
		expect(source).toContain('<UiConfirmationDialog');
		expect(source).toContain('@confirm="confirmDelete"');
	});

	it('quarantine block arms a pending target and blocks only on confirm', () => {
		const source = readPage('dashboard/inbox/quarantine.vue');
		expect(source).not.toContain('@click="onBlock(message._id)"');
		expect(source).toContain('<UiConfirmationDialog');
		expect(source).toContain('@confirm="confirmBlock"');
	});

	it('postbox contact removal routes through a handler with an undo toast', () => {
		const source = readPage('dashboard/postbox/contacts.vue');
		expect(source).toContain('@click="removeContact(c)"');
		expect(source).toMatch(/showToast\([\s\S]*label: 'Undo'/);
	});
});
