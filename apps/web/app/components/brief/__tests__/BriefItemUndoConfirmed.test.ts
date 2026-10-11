// @vitest-environment happy-dom
/**
 * A confirmed change can be taken back (review round 3, F3): a personal item
 * closed by confirming a held transition offers Undo, and so does an open item
 * whose held change was confirmed. Confirming says so in a toast with Undo.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { mount } from '@vue/test-utils';
import BriefItem from '../BriefItem.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { item } from '~/utils/__tests__/threadBriefFixtures';
import { useBriefReactions } from '~/composables/threadBrief/useBriefReactions';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, { get: () => anyPath });
	return { api: anyPath };
});

const runs = new Map<string, ReturnType<typeof vi.fn>>();
const showToast = vi.fn();
let operation = 0;
beforeAll(() => {
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useToast: () => ({ showToast }),
		useBackendOperation: () => {
			const run = vi.fn(async () => ({ ok: true, result: {} }));
			runs.set(String(operation++), run);
			return { run, isLoading: ref(false) };
		},
	});
});

const Plain = defineComponent({ setup: () => () => h('span') });
const MenuStub = defineComponent({
	setup:
		(_, { slots }) =>
		() =>
			h('div', slots['default']?.({ close: () => {} })),
});

function mountItem(over: Record<string, unknown>) {
	return mount(BriefItem, {
		props: { item: item({ id: 'i1', text: 'Pay the invoice', ...over }) },
		global: {
			plugins: [createTestI18n()],
			components: { UiButton: Plain, PostboxOverflowMenu: MenuStub },
		},
	});
}

describe('Undo after a confirmation', () => {
	it('is offered on an item a confirmed transition closed', () => {
		const w = mountItem({
			status: 'done',
			stateKey: 'reportedDone',
			correction: { kind: 'confirmed', at: 1 },
		});
		expect(w.findAll('[data-action]').map((b) => b.attributes('data-action'))).toEqual(['undo']);
	});

	it('is offered on an open item whose held change was confirmed', () => {
		const w = mountItem({ correction: { kind: 'confirmed', at: 1 } });
		expect(w.find('[data-action="undo"]').exists()).toBe(true);
	});

	it('confirming toasts with Undo, which reverses it', async () => {
		let reactions!: ReturnType<typeof useBriefReactions>;
		mount(
			defineComponent({
				setup() {
					reactions = useBriefReactions({ onReply: () => {} });
					return () => h('div');
				},
			}),
			{ global: { plugins: [createTestI18n()] } }
		);
		await reactions.run(item({ id: 'i1', text: 'x' }), 'confirmProposal');
		const [message, , opts] = showToast.mock.calls.at(-1)!;
		expect(message).toBe('Confirmed. You can undo it.');
		opts.action.onAction();
		const undoCalls = [...runs.values()].filter((r) =>
			r.mock.calls.some((c) => c[0]?.itemId === 'i1')
		);
		// confirmProposal and undo both ran for the item.
		expect(undoCalls.length).toBe(2);
	});
});
