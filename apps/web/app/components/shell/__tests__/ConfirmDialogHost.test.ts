/**
 * The one dialog behind `useConfirm()`, mounted for real: the host imports
 * UiConfirmationDialog itself on the first question, and UiModal and UiButton
 * are the real ones, so focus, Escape and the backdrop behave as they do in the
 * app.
 *
 * What it has to guarantee: the caller's copy is what the person reads; only
 * the confirm button resolves yes; every other way out resolves no; queued
 * questions come one at a time, each opening on Cancel; and focus goes back to
 * whatever opened the question.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import UiModal from '@owlat/ui/components/ui/Modal.vue';
import UiButton from '@owlat/ui/components/ui/Button.vue';
// Loaded up front so the host's own import() of it resolves from the module
// cache within one flushPromises, as a chunk already fetched would in the app.
import '@owlat/ui/components/ui/ConfirmationDialog.vue';
import { createTestI18n } from '~/__tests__/i18n';
import { useConfirm, type ConfirmOptions } from '~/composables/useConfirm';
import ConfirmDialogHost from '../ConfirmDialogHost.vue';

const global = {
	components: { UiModal, UiButton },
	plugins: [createTestI18n()],
	stubs: { teleport: true },
};

afterEach(() => {
	for (const el of document.querySelectorAll('[data-opener]')) el.remove();
});

function mountHost() {
	return mount(ConfirmDialogHost, { attachTo: document.body, global });
}

/** A caller mounted the way a component is, so its scope can be torn down. */
function mountCaller() {
	let confirm!: (options: ConfirmOptions) => Promise<boolean>;
	const wrapper = mount(
		defineComponent({
			setup() {
				confirm = useConfirm();
				return () => h('div');
			},
		})
	);
	return { confirm, unmount: () => wrapper.unmount() };
}

function opener() {
	const button = document.createElement('button');
	button.textContent = 'Delete forever';
	button.dataset['opener'] = '';
	document.body.append(button);
	button.focus();
	return button;
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const active = () => document.activeElement as HTMLElement | null;
const button = (selector: string) => dialog()!.querySelector<HTMLElement>(selector)!;

async function ask(options: ConfirmOptions, caller = mountCaller()) {
	const answer = caller.confirm(options);
	await flushPromises();
	return answer;
}

describe('ConfirmDialogHost', () => {
	it('shows nothing until a question is asked', () => {
		mountHost();
		expect(dialog()).toBeNull();
	});

	it("renders the caller's copy and opens on Cancel", async () => {
		mountHost();
		opener();
		void ask({
			title: 'Clear this record?',
			body: 'First consequence.\nSecond consequence.',
			confirmText: 'Start over',
			variant: 'danger',
		});
		await flushPromises();

		const panel = dialog()!;
		expect(panel.textContent).toContain('Clear this record?');
		const body = panel.querySelector('.whitespace-pre-line')!;
		// Line breaks survive: multi-line consequences stay one statement per line.
		expect(body.textContent).toBe('First consequence.\nSecond consequence.');
		expect(document.getElementById(panel.getAttribute('aria-labelledby')!)?.textContent).toContain(
			'Clear this record?'
		);
		expect(button('[data-confirmation-confirm]').textContent).toContain('Start over');
		expect(active()?.textContent?.trim()).toBe('Cancel');
	});

	it('shows no body at all when the caller gives none', async () => {
		mountHost();
		void ask({ title: 'Unsubscribe from 2 senders?' });
		await flushPromises();
		expect(dialog()!.textContent).not.toContain('This action cannot be undone');
		expect(dialog()!.querySelector('.whitespace-pre-line')!.textContent).toBe('');
	});

	it('resolves true on the confirm button and returns focus to the opener', async () => {
		mountHost();
		const trigger = opener();
		const answer = ask({ title: 'Delete forever?' });
		await flushPromises();

		button('[data-confirmation-confirm]').click();
		await expect(answer).resolves.toBe(true);
		await flushPromises();
		expect(dialog()).toBeNull();
		expect(active()).toBe(trigger);
	});

	it.each([
		['Cancel', () => button('[data-confirmation-cancel]').click()],
		// The header's close button, the only one named by an aria-label.
		['Close', () => button('button[aria-label]').click()],
		[
			'Escape',
			() =>
				document.body.dispatchEvent(
					new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
				),
		],
		['the backdrop', () => dialog()!.parentElement!.click()],
	])('resolves false on %s', async (_way, dismiss) => {
		mountHost();
		const answer = ask({ title: 'Delete forever?' });
		await flushPromises();

		dismiss();
		await expect(answer).resolves.toBe(false);
		await flushPromises();
		expect(dialog()).toBeNull();
	});

	it('asks queued questions one at a time, each opening on Cancel', async () => {
		mountHost();
		const trigger = opener();
		const first = ask({ title: 'First question?' });
		const second = ask({ title: 'Second question?' });
		await flushPromises();
		expect(dialog()!.textContent).toContain('First question?');
		expect(dialog()!.textContent).not.toContain('Second question?');

		// Focus where a keyboard user's Enter would leave it.
		const confirmFirst = button('[data-confirmation-confirm]');
		confirmFirst.focus();
		confirmFirst.click();
		await expect(first).resolves.toBe(true);
		await flushPromises();

		expect(dialog()!.textContent).toContain('Second question?');
		// Reopened, not swapped in place: the press that confirmed the first
		// question does not sit on the second one's confirm button.
		expect(active()?.textContent?.trim()).toBe('Cancel');
		button('[data-confirmation-cancel]').click();
		await expect(second).resolves.toBe(false);
		await flushPromises();
		expect(dialog()).toBeNull();
		expect(active()).toBe(trigger);
	});

	it('closes and answers no when the asking component goes away', async () => {
		mountHost();
		const caller = mountCaller();
		const answer = ask({ title: 'Reset?' }, caller);
		await flushPromises();
		expect(dialog()).not.toBeNull();

		caller.unmount();
		await expect(answer).resolves.toBe(false);
		await flushPromises();
		expect(dialog()).toBeNull();
	});

	it('answers no to everything open when the host unmounts', async () => {
		const shown = ref(true);
		mount(
			defineComponent({
				setup: () => () => (shown.value ? h(ConfirmDialogHost) : null),
			}),
			{ attachTo: document.body, global }
		);
		const first = ask({ title: 'First?' });
		const second = ask({ title: 'Second?' });
		await flushPromises();

		shown.value = false;
		await flushPromises();
		await expect(Promise.all([first, second])).resolves.toEqual([false, false]);
	});
});
