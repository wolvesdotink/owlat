// @vitest-environment happy-dom
/**
 * The boundary every pane failure lands in. What it has to guarantee:
 *   - a failing child is replaced by an alert with Retry, and its siblings and
 *     the parent keep rendering (the error stops at the boundary);
 *   - Retry renders the slot again, and so does a CHANGE of reset keys, compared
 *     by value: a parent passing a fresh `[id]` array on every render must not
 *     clear a failure, and healthy content is never remounted by a key change;
 *   - errors its `capture` predicate declines pass through untouched.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, onErrorCaptured, onMounted, ref, type Ref } from 'vue';
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
