/**
 * Team Updates is where Today's "Filed away" Team Inbox tiles land. Pressing a
 * row's Done (dismiss) button and dragging dismisses the range on release, in
 * the order the rows RENDER (grouped by importance), which is also the order
 * j/k walk.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, nextTick, ref } from 'vue';
import { installNuxtStubs, mountDashboardPage } from '~/__tests__/a11y';
import { i18nStubs } from '~/__tests__/i18n';
import { usePostboxOptimisticHide } from '~/composables/postbox/usePostboxOptimisticHide';

const ROW_PX = 50;
let runs: string[];
let toasts: string[];

/** One informational update; `importance` picks its group (high ≥ .7, normal ≥ .4, else low). */
const update = (id: string, importance: number) => ({
	message: {
		_id: id,
		from: `${id}@example.com`,
		subject: `Update ${id}`,
		receivedAt: 1,
		processingStatus: 'informational',
		classification: { importance, kind: 'update' },
		preview: '',
	},
	thread: null,
	contact: null,
});

function install() {
	installNuxtStubs({
		...i18nStubs,
		useRoute: () => ({ query: {}, params: {}, path: '/dashboard/inbox/updates' }),
		usePostboxOptimisticHide,
		// Server order a, b, c; rendered order c (high), a (normal), b (low).
		useConvexQuery: (_fn: unknown, args: () => unknown) => {
			const isList = typeof args === 'function' && 'view' in (args() as object);
			return {
				data: ref(isList ? [update('a', 0.5), update('b', 0.1), update('c', 0.9)] : undefined),
				isLoading: ref(false),
				error: ref(null),
				refetch: vi.fn(),
			};
		},
		useBackendOperation: () => ({
			run: vi.fn(async (args: { inboundMessageId: string }) => {
				runs.push(args.inboundMessageId);
				return { ok: true, result: { success: true } };
			}),
		}),
		useToast: () => ({ showToast: (message: string) => toasts.push(message) }),
	});
}

const Slot = defineComponent({ template: '<div><slot /><slot name="actions" /></div>' });

async function render() {
	const { default: Page } = await import('../inbox/updates.vue');
	const wrapper = mountDashboardPage(Page, {
		stubs: {
			UiQueryBoundary: Slot,
			UiPageHeader: Slot,
			UiAvatar: true,
			UiConfirmationDialog: true,
			NuxtLink: { template: '<a><slot /></a>' },
			UiButton: { template: '<button type="button"><slot /></button>' },
		},
	});
	for (const [i, li] of wrapper.findAll('li[data-sweep-row]').entries()) {
		li.element.getBoundingClientRect = () =>
			({ top: i * ROW_PX, bottom: (i + 1) * ROW_PX }) as DOMRect;
	}
	return wrapper;
}

function pointer(type: string, y: number): PointerEvent {
	const event = new Event(type, { bubbles: true, cancelable: true });
	Object.defineProperties(event, {
		clientX: { value: 10 },
		clientY: { value: y },
		pointerType: { value: 'mouse' },
		pointerId: { value: 1 },
		isPrimary: { value: true },
		button: { value: 0 },
		shiftKey: { value: false },
		metaKey: { value: false },
		ctrlKey: { value: false },
		altKey: { value: false },
	});
	return event as PointerEvent;
}

async function settle() {
	for (let i = 0; i < 10; i++) await Promise.resolve();
	await nextTick();
}

beforeEach(() => {
	runs = [];
	toasts = [];
	install();
});

describe('Team Updates: dismiss sweep', () => {
	it('dismisses the range in rendered order on release, with one toast', async () => {
		const wrapper = await render();
		const rows = wrapper.findAll('li[data-sweep-row]');
		expect(rows.map((r) => r.attributes('data-sweep-row'))).toEqual(['c', 'a', 'b']);

		const done = rows[0]!.findAll('button').find((b) => b.attributes('title')?.includes('drag'))!;
		done.element.dispatchEvent(pointer('pointerdown', 25));
		window.dispatchEvent(pointer('pointermove', 33));
		window.dispatchEvent(pointer('pointermove', 75));
		await nextTick();
		expect(runs).toEqual([]);
		expect(wrapper.find('[role="status"]').text()).toContain('Dismiss 2 updates');

		window.dispatchEvent(pointer('pointerup', 75));
		await settle();

		expect(runs).toEqual(['c', 'a']);
		expect(toasts).toEqual(['2 updates dismissed']);
		expect(
			wrapper.findAll('li[data-sweep-row]').map((r) => r.attributes('data-sweep-row'))
		).toEqual(['b']);
		wrapper.unmount();
	});
});
