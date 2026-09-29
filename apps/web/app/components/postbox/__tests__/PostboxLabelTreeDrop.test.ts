// @vitest-environment happy-dom
/**
 * Dropping dragged messages on a label in the folder rail applies the label.
 *
 * A label is not a location, so the rows stay put and the toast is the only
 * sign the drop did anything — which is why it has to be honest: it counts the
 * messages that actually gained the label, and says so when none did.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { computed, nextTick, ref } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { buildLabelTree } from '~/utils/postboxLabelTree';
import { usePostboxMessageDrag } from '~/composables/postbox/usePostboxMessageDrag';
import PostboxLabelTree from '../PostboxLabelTree.vue';

const labels = ref([{ _id: 'lbl-1', name: 'Billing', mailboxId: 'mbx-1' }]);
const applyToMessages = vi.fn();
const showToast = vi.fn();

beforeAll(() => {
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		LABEL_PRESET_HEXES: [],
		useToast: () => ({ showToast }),
		usePostboxLabels: () => ({
			labels,
			labelTree: computed(() => buildLabelTree(labels.value)),
			reorder: vi.fn(),
			setParent: vi.fn(),
			rename: vi.fn(),
			setColor: vi.fn(),
			remove: vi.fn(),
			applyToMessages,
		}),
		usePostboxLabelCollapse: () => ({
			collapsedIds: ref(new Set<string>()),
			toggle: vi.fn(),
			expandAll: vi.fn(),
		}),
		usePostboxManageDialog: () => ({ openManager: vi.fn(), editLabelId: ref(null) }),
	});
});

beforeEach(() => {
	applyToMessages.mockReset();
	showToast.mockReset();
});

afterEach(() => usePostboxMessageDrag().end());

function mountTree() {
	return mount(PostboxLabelTree, {
		props: { mailboxId: 'mbx-1' as never },
		global: {
			plugins: [createTestI18n()],
			components: {
				NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
				UiContextMenu: {
					props: ['items'],
					template: '<slot :on-contextmenu="() => {}" :on-keydown="() => {}" />',
				},
			},
			stubs: { Icon: true },
		},
	});
}

function startDrag(messageIds: string[], mailboxId = 'mbx-1') {
	usePostboxMessageDrag().start(
		{ dataTransfer: { setData: vi.fn(), setDragImage: vi.fn() } } as unknown as DragEvent,
		{
			mailboxId: mailboxId as never,
			messageIds: messageIds as never,
			sourceFolder: 'inbox',
			moveTo: vi.fn(async () => {}),
		},
		'Subject'
	);
}

/** Dispatch a cancelable drag event; `true` means the row claimed it. */
function fire(el: Element, type: string) {
	const event = new Event(type, { bubbles: true, cancelable: true });
	el.dispatchEvent(event);
	return event.defaultPrevented;
}

describe('PostboxLabelTree as a drop target', () => {
	it('applies the label to every dragged message and says how many gained it', async () => {
		applyToMessages.mockResolvedValue({ ok: true, result: { changed: 2 } });
		const w = mountTree();
		startDrag(['m1', 'm2']);
		const link = w.get('a[href="/dashboard/postbox/label/lbl-1"]');

		expect(fire(link.element, 'dragover')).toBe(true);
		await nextTick();
		expect(link.classes()).toContain('pbx-drop-target');

		expect(fire(link.element, 'drop')).toBe(true);
		await vi.waitFor(() => expect(showToast).toHaveBeenCalled());
		expect(applyToMessages).toHaveBeenCalledWith(['m1', 'm2'], 'lbl-1');
		expect(showToast).toHaveBeenCalledWith('Added “Billing” to 2 messages', 'success');
	});

	it('says so when every message already carried the label', async () => {
		applyToMessages.mockResolvedValue({ ok: true, result: { changed: 0 } });
		const w = mountTree();
		startDrag(['m1']);
		fire(w.get('a').element, 'drop');
		await vi.waitFor(() => expect(showToast).toHaveBeenCalled());
		expect(showToast).toHaveBeenCalledWith('Already labelled “Billing”', 'info');
	});

	it('stays quiet when the mutation fails (the operation reports the error)', async () => {
		applyToMessages.mockResolvedValue({ ok: false });
		const w = mountTree();
		startDrag(['m1']);
		fire(w.get('a').element, 'drop');
		await vi.waitFor(() => expect(applyToMessages).toHaveBeenCalled());
		await nextTick();
		expect(showToast).not.toHaveBeenCalled();
	});

	it("refuses messages from another mailbox, and anything that isn't a message drag", () => {
		const w = mountTree();
		expect(fire(w.get('li').element, 'dragover')).toBe(false);
		startDrag(['m1'], 'mbx-2');
		expect(fire(w.get('a').element, 'dragover')).toBe(false);
	});
});
