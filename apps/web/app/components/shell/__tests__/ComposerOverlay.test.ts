// @vitest-environment happy-dom
/**
 * The shell's composer host: Compose opens over the current page, so the shell
 * mounts the floating composer stack — except where the page already mounts its
 * own, which would draw every composer twice.
 *
 * The stack is the whole composer, so the shell loads it only once something
 * needs it: a composer opening, or an undo-send window (a reply sent from the
 * Today reader's inline box arms the toast without any popup).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick, ref } from 'vue';
import ComposerOverlay from '../ComposerOverlay.vue';

let path = '/dashboard';
let composers: ReturnType<typeof ref<unknown[]>>;
let undoSend: ReturnType<typeof ref<{ visible: boolean; sendAt: number }>>;

beforeEach(() => {
	path = '/dashboard';
	composers = ref<unknown[]>([]);
	undoSend = ref({ visible: false, sendAt: 0 });
	// The real composables read these shared states; hand them the test's refs.
	const states: Record<string, unknown> = {
		'postbox:composer-stack': composers,
		'postbox:undo-send': undoSend,
	};
	Object.assign(globalThis, {
		useRoute: () => ({ path }),
		useState: (key: string, init: () => unknown) => (states[key] ??= ref(init())),
	});
});

function mountOverlay() {
	return mount(ComposerOverlay, {
		global: { stubs: { LazyPostboxComposerStack: { template: '<div data-testid="stack" />' } } },
	});
}

const hasStack = (wrapper: ReturnType<typeof mountOverlay>) =>
	wrapper.find('[data-testid="stack"]').exists();

describe('ShellComposerOverlay', () => {
	it('leaves the composer stack unloaded until a composer opens', async () => {
		path = '/dashboard/audience/contacts/c_1';
		const wrapper = mountOverlay();
		expect(hasStack(wrapper)).toBe(false);

		composers.value = [{ id: 'cmp_1', minimized: false }];
		await nextTick();
		expect(hasStack(wrapper)).toBe(true);
	});

	it('keeps the stack mounted after the last composer closes', async () => {
		composers.value = [{ id: 'cmp_1', minimized: false }];
		const wrapper = mountOverlay();
		expect(hasStack(wrapper)).toBe(true);

		composers.value = [];
		await nextTick();
		expect(hasStack(wrapper)).toBe(true);
	});

	it('mounts the stack for an undo-send window armed without a popup', async () => {
		const wrapper = mountOverlay();
		expect(hasStack(wrapper)).toBe(false);

		undoSend.value = { visible: true, sendAt: Date.now() + 10_000 };
		await nextTick();
		expect(hasStack(wrapper)).toBe(true);
	});

	it('stays out of the way where the page hosts its own stack', () => {
		composers.value = [{ id: 'cmp_1', minimized: false }];
		path = '/dashboard/postbox/inbox';
		expect(hasStack(mountOverlay())).toBe(false);
		path = '/dashboard/answer';
		expect(hasStack(mountOverlay())).toBe(false);
	});
});
