/**
 * The boundary every pane failure lands in. What it has to guarantee:
 *   - a failing child is replaced by an alert with Retry, and its siblings and
 *     the parent keep rendering (the error stops at the boundary);
 *   - Retry renders the slot again, and so does a CHANGE of reset keys, compared
 *     by value: a parent passing a fresh `[id]` array on every render must not
 *     clear a failure, and healthy content is never remounted by a key change;
 *   - errors its `capture` predicate declines pass through untouched;
 *   - after Retry from the default fallback, focus lands somewhere deliberate
 *     instead of falling to <body> with the button that held it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	Fragment,
	Transition,
	createVNode,
	defineComponent,
	h,
	nextTick,
	onErrorCaptured,
	onMounted,
	reactive,
	ref,
	renderSlot,
	type Ref,
} from 'vue';
import ErrorBoundary from '../components/ui/ErrorBoundary.vue';
import { mountUi, type MountedUi, type UiLocale } from './i18n';

let mounted: MountedUi | null = null;

afterEach(() => {
	mounted?.unmount();
	mounted = null;
	vi.restoreAllMocks();
});

/** A child that throws from render while `failing.value` is true. */
function flakyChild(failing: Ref<boolean>, mounts?: { count: number }) {
	return defineComponent({
		name: 'FlakyChild',
		setup() {
			onMounted(() => {
				if (mounts) mounts.count += 1;
			});
			return () => {
				if (failing.value) throw new Error('render failed');
				return h('p', { 'data-testid': 'child' }, 'child content');
			};
		},
	});
}

interface HarnessOptions {
	keys?: Ref<unknown[]>;
	capture?: (error: unknown, info: string) => boolean;
	onCaptured?: (error: unknown, info: string) => void;
	outerCaptured?: (error: unknown) => void;
	fallbackSlot?: boolean;
	locale?: UiLocale;
}

async function mountHarness(
	child: ReturnType<typeof flakyChild>,
	options: HarnessOptions = {}
): Promise<HTMLElement> {
	const Harness = defineComponent({
		setup() {
			onErrorCaptured((error) => {
				options.outerCaptured?.(error);
				return false;
			});
			return () =>
				h('div', [
					h('span', { 'data-testid': 'sibling' }, 'sibling'),
					h(
						ErrorBoundary,
						{
							// A fresh array on every render: identity must not matter.
							resetKeys: options.keys ? [...options.keys.value] : undefined,
							capture: options.capture,
							onCaptured: options.onCaptured,
						},
						{
							default: () => h(child),
							...(options.fallbackSlot
								? {
										fallback: ({ error, retry }: { error: unknown; retry: () => void }) =>
											h('button', { 'data-testid': 'custom', onClick: retry }, String(error)),
									}
								: {}),
						}
					),
				]);
		},
	});
	mounted = mountUi(Harness, {}, options.locale ?? 'en');
	// A captured failure re-renders the boundary on the next tick.
	await nextTick();
	return mounted.el;
}

const quietConsole = () => vi.spyOn(console, 'error').mockImplementation(() => {});

describe('UiErrorBoundary — containment', () => {
	it('replaces only the failing slot with an alert and keeps siblings rendering', async () => {
		quietConsole();
		const outer = vi.fn();
		const el = await mountHarness(flakyChild(ref(true)), { outerCaptured: outer });

		expect(el.querySelector('[data-testid="sibling"]')?.textContent).toBe('sibling');
		const alert = el.querySelector('[role="alert"]');
		expect(alert?.textContent).toContain('Something went wrong. Please try again.');
		expect(alert?.querySelector('button')?.textContent?.trim()).toBe('Try again');
		expect(el.querySelector('[data-testid="child"]')).toBeNull();
		expect(outer).not.toHaveBeenCalled();
	});

	it('renders the German copy under the German catalog', async () => {
		quietConsole();
		const el = await mountHarness(flakyChild(ref(true)), { locale: 'de' });
		expect(el.querySelector('[role="alert"]')?.textContent).toContain(
			'Etwas ist schiefgelaufen. Bitte versuche es erneut.'
		);
	});

	it('reports what it contained', async () => {
		quietConsole();
		const onCaptured = vi.fn();
		await mountHarness(flakyChild(ref(true)), { onCaptured });
		expect(onCaptured).toHaveBeenCalledTimes(1);
		expect((onCaptured.mock.calls[0]![0] as Error).message).toBe('render failed');
		expect(typeof onCaptured.mock.calls[0]![1]).toBe('string');
	});

	it('lets an error its capture predicate declines propagate', async () => {
		quietConsole();
		const outer = vi.fn();
		const el = await mountHarness(flakyChild(ref(true)), {
			capture: () => false,
			outerCaptured: outer,
		});
		expect(outer).toHaveBeenCalledTimes(1);
		expect(el.querySelector('[role="alert"]')).toBeNull();
	});

	it('hands error and retry to a custom fallback slot', async () => {
		quietConsole();
		const failing = ref(true);
		const el = await mountHarness(flakyChild(failing), { fallbackSlot: true });
		const custom = el.querySelector<HTMLButtonElement>('[data-testid="custom"]');
		expect(custom?.textContent).toBe('Error: render failed');

		failing.value = false;
		custom!.click();
		await nextTick();
		expect(el.querySelector('[data-testid="child"]')).not.toBeNull();
	});
});

describe('UiErrorBoundary — recovery', () => {
	it('renders the slot again on Retry once the child recovers', async () => {
		quietConsole();
		const failing = ref(true);
		const el = await mountHarness(flakyChild(failing));

		failing.value = false;
		el.querySelector<HTMLButtonElement>('[role="alert"] button')!.click();
		await nextTick();

		expect(el.querySelector('[role="alert"]')).toBeNull();
		expect(el.querySelector('[data-testid="child"]')?.textContent).toBe('child content');
	});

	it('shows the fallback again when Retry fails again', async () => {
		quietConsole();
		const el = await mountHarness(flakyChild(ref(true)));
		el.querySelector<HTMLButtonElement>('[role="alert"] button')!.click();
		await nextTick();
		expect(el.querySelector('[role="alert"]')).not.toBeNull();
	});

	it('recovers when a reset key changes value', async () => {
		quietConsole();
		const failing = ref(true);
		const keys = ref<unknown[]>(['message-1']);
		const el = await mountHarness(flakyChild(failing), { keys });
		expect(el.querySelector('[role="alert"]')).not.toBeNull();

		failing.value = false;
		keys.value = ['message-2'];
		await nextTick();

		expect(el.querySelector('[role="alert"]')).toBeNull();
		expect(el.querySelector('[data-testid="child"]')).not.toBeNull();
	});

	it('does not reset for an equal key list in a new array', async () => {
		quietConsole();
		const failing = ref(true);
		const keys = ref<unknown[]>(['message-1', 2]);
		const el = await mountHarness(flakyChild(failing), { keys });

		failing.value = false;
		keys.value = ['message-1', 2];
		await nextTick();

		expect(el.querySelector('[role="alert"]')).not.toBeNull();
	});

	it('stays failed when the content fails again under the new keys', async () => {
		quietConsole();
		const keys = ref<unknown[]>(['message-1']);
		const el = await mountHarness(flakyChild(ref(true)), { keys });

		keys.value = ['message-2'];
		await nextTick();

		expect(el.querySelector('[role="alert"]')).not.toBeNull();
	});

	it('never remounts healthy content when keys change', async () => {
		const mounts = { count: 0 };
		const keys = ref<unknown[]>(['message-1']);
		const el = await mountHarness(flakyChild(ref(false), mounts), { keys });

		keys.value = ['message-2'];
		await nextTick();

		expect(mounts.count).toBe(1);
		expect(el.querySelector('[data-testid="child"]')).not.toBeNull();
	});
});

describe('UiErrorBoundary — reset keys held in a reactive array', () => {
	it('resets when an entry of the same array changes in place', async () => {
		quietConsole();
		const failing = ref(true);
		const keys = reactive<unknown[]>(['message-1']);
		// The parent hands over the same array every time, so only the entry changes.
		const Harness = defineComponent({
			setup: () => () =>
				h('div', [
					h(ErrorBoundary, { resetKeys: keys }, { default: () => h(flakyChild(failing)) }),
				]),
		});
		mounted = mountUi(Harness);
		await nextTick();
		expect(mounted.el.querySelector('[role="alert"]')).not.toBeNull();

		failing.value = false;
		keys[0] = 'message-2';
		await nextTick();

		expect(mounted.el.querySelector('[role="alert"]')).toBeNull();
		expect(mounted.el.querySelector('[data-testid="child"]')).not.toBeNull();
	});
});

describe('UiErrorBoundary — focus after Retry', () => {
	/** Content that throws while `failing` is true and otherwise renders `render()`. */
	function contentChild(failing: Ref<boolean>, render: () => ReturnType<typeof h>) {
		return defineComponent({
			name: 'FocusChild',
			setup: () => () => {
				if (failing.value) throw new Error('render failed');
				return render();
			},
		});
	}

	async function mountInRegion(child: ReturnType<typeof contentChild>): Promise<HTMLElement> {
		const Harness = defineComponent({
			setup: () => () =>
				h('section', { tabindex: '-1', 'data-testid': 'region' }, [
					h(ErrorBoundary, null, { default: () => h(child) }),
				]),
		});
		mounted = mountUi(Harness);
		await nextTick();
		return mounted.el;
	}

	async function pressRetry(el: HTMLElement) {
		const button = el.querySelector<HTMLButtonElement>('[role="alert"] button')!;
		button.focus();
		expect(document.activeElement).toBe(button);
		button.click();
		await nextTick();
		await nextTick();
	}

	it('moves focus to the first focusable element of the recovered content', async () => {
		quietConsole();
		const failing = ref(true);
		const el = await mountInRegion(
			contentChild(failing, () =>
				h('div', [h('p', 'text'), h('button', { 'data-testid': 'first' }, 'first')])
			)
		);
		failing.value = false;
		await pressRetry(el);
		expect(document.activeElement).toBe(el.querySelector('[data-testid="first"]'));
	});

	it('falls back to the focusable container when the content has nothing to focus', async () => {
		quietConsole();
		const failing = ref(true);
		const el = await mountInRegion(contentChild(failing, () => h('p', 'only text')));
		failing.value = false;
		await pressRetry(el);
		expect(document.activeElement).toBe(el.querySelector('[data-testid="region"]'));
	});

	it('keeps focus on the new Retry button when the content fails again', async () => {
		quietConsole();
		const el = await mountInRegion(contentChild(ref(true), () => h('p')));
		await pressRetry(el);
		const button = el.querySelector('[role="alert"] button');
		expect(button).not.toBeNull();
		expect(document.activeElement).toBe(button);
	});

	it('leaves focus the recovered content took for itself', async () => {
		quietConsole();
		const failing = ref(true);
		const Autofocus = defineComponent({
			setup() {
				const input = ref<HTMLInputElement | null>(null);
				onMounted(() => input.value?.focus());
				return () =>
					h('div', [h('button', 'first'), h('input', { ref: input, 'data-testid': 'auto' })]);
			},
		});
		const el = await mountInRegion(contentChild(failing, () => h(Autofocus)));
		failing.value = false;
		await pressRetry(el);
		expect(document.activeElement).toBe(el.querySelector('[data-testid="auto"]'));
	});
});

describe('UiErrorBoundary — root shape', () => {
	it('hands a transition the content element itself, not a fragment', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const Page = defineComponent({ setup: () => () => h('article', { 'data-testid': 'page' }) });
		// A boundary that is a page's root, wrapped the way NuxtPage wraps pages:
		// the content arrives through a nested slot outlet.
		const Wrapper = defineComponent({
			setup:
				(_p, { slots }) =>
				() =>
					h(ErrorBoundary, null, { default: () => [renderSlot(slots, 'default')] }),
		});
		const shown = ref(true);
		const Harness = defineComponent({
			setup: () => () =>
				h('main', [
					h(Transition, { name: 'page' }, () =>
						shown.value ? h(Wrapper, null, { default: () => h(Page) }) : null
					),
				]),
		});
		mounted = mountUi(Harness);
		await nextTick();

		expect(mounted.el.querySelector('main > article[data-testid="page"]')).not.toBeNull();
		const transitionWarnings = warn.mock.calls.filter((call) =>
			String(call[0]).includes('non-element root node')
		);
		expect(transitionWarnings).toHaveLength(0);
	});

	it('keeps several content nodes side by side', async () => {
		const Harness = defineComponent({
			setup: () => () =>
				h('div', [
					h(ErrorBoundary, null, {
						default: () => [h('p', { 'data-testid': 'a' }), h('p', { 'data-testid': 'b' })],
					}),
				]),
		});
		mounted = mountUi(Harness);
		await nextTick();
		expect(mounted.el.querySelectorAll('[data-testid]')).toHaveLength(2);
	});

	it('does not remount a list entry when the list grows', async () => {
		const mounts = { count: 0 };
		const Item = defineComponent({
			props: { id: { type: String, required: true } },
			setup(props) {
				onMounted(() => {
					mounts.count += 1;
				});
				return () => h('li', { 'data-testid': props.id });
			},
		});
		const ids = ref(['one']);
		const Harness = defineComponent({
			setup: () => () =>
				h('ul', [
					h(ErrorBoundary, null, {
						// A v-for fragment, as a template's `v-for` compiles to (keyed list flag).
						default: () => [
							createVNode(
								Fragment,
								null,
								ids.value.map((id) => h(Item, { key: id, id })),
								128
							),
						],
					}),
				]),
		});
		mounted = mountUi(Harness);
		await nextTick();
		expect(mounts.count).toBe(1);

		ids.value = ['one', 'two'];
		await nextTick();
		expect(mounted.el.querySelectorAll('li')).toHaveLength(2);
		expect(mounts.count).toBe(2);
	});
});
