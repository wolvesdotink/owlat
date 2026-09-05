// @vitest-environment happy-dom
/**
 * Irreversible one-click destructive actions must not fire immediately. Deleting
 * a chat (assistant) and blocking a sender (quarantine) now go through the shared
 * UiConfirmationDialog; removing a Postbox contact now surfaces an undo toast.
 *
 * A behavioural mount of the REAL UiConfirmationDialog proves the exact
 * contract the pages depend on: the mutation only runs on @confirm (once),
 * never while the dialog is closed, and never on cancel / backdrop /
 * @update:open(false).
 */
import { describe, it, expect, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { mount } from '@vue/test-utils';
import UiConfirmationDialog from '@owlat/ui/components/ui/ConfirmationDialog.vue';

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
	props: { variant: String, disabled: Boolean, loading: Boolean },
	setup(props, { slots }) {
		// Single root <button> so the parent's @click falls through natively.
		// The variant lands on the class list because BOTH footer buttons are
		// UiButtons now (the confirm button used to be a raw <button> carrying a
		// hand-written brand fill), so the variant is the only thing that tells
		// Cancel and Confirm apart from the outside.
		return () =>
			h('button', { class: ['ui-button', `ui-button--${props.variant}`] }, [
				slots.iconLeft?.(),
				slots.default?.(),
			]);
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

// The harness mounts the dialog with variant="danger", so the confirm button is
// the danger one and Cancel is the secondary one.
const confirmButton = (w: ReturnType<typeof mountPageLikeGate>) =>
	w.find('.footer button.ui-button--danger');
const cancelButton = (w: ReturnType<typeof mountPageLikeGate>) =>
	w.find('.footer button.ui-button--secondary');

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
