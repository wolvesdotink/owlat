/**
 * The open conversation's task verbs in the palette: Make task always, Done
 * on the top item only while the purpose header offers it, the conversation's
 * open tasks only while there are some. Only on the reader and Team Inbox
 * routes, only for the conversation in front (the Today overlay over the
 * folder reader), and gone once the conversation closes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref, type Ref } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { installNuxtStubs } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import type { PaletteItem } from '~/lib/commandPalette';
import { resolvePaletteGroups } from '~/lib/commandPaletteRegistry';
import {
	registerCommandPaletteProvider,
	useCommandPaletteRegistry,
} from '~/composables/useCommandPaletteRegistry';
import {
	CONVERSATION_TASK_COMMAND_GROUP_KEY,
	type ConversationTaskCommandSources,
	useConversationTaskCommands,
} from '../useConversationTaskCommands';

let tasks: Ref<Array<{ _id: string; status: string }>>;
let queried: unknown[];
let navigateTo: ReturnType<typeof vi.fn>;

beforeEach(() => {
	tasks = ref([
		{ _id: 'task_1', status: 'open' },
		{ _id: 'task_2', status: 'open' },
		{ _id: 'task_3', status: 'done' },
	]);
	queried = [];
	navigateTo = vi.fn();
	installNuxtStubs({
		...i18nStubs,
		registerCommandPaletteProvider,
		navigateTo,
		useConvexQuery: (_query: unknown, args: () => unknown) => {
			queried.push(args());
			return { data: tasks };
		},
	});
});

const wrappers: VueWrapper[] = [];
afterEach(() => {
	for (const w of wrappers.splice(0)) w.unmount();
	vi.useRealTimers();
});

function sources(
	over: Partial<ConversationTaskCommandSources> = {}
): ConversationTaskCommandSources {
	return {
		mailThreadId: () => 'thread_1' as never,
		conversationThreadId: () => undefined,
		doneItem: () => 'Approve the revised quote',
		openMakeTask: vi.fn(),
		markDone: vi.fn(),
		...over,
	};
}

function mountHeader(src: ConversationTaskCommandSources): VueWrapper {
	const w = mount(
		defineComponent({
			setup() {
				useConversationTaskCommands(src);
				return () => h('div');
			},
		}),
		{ global: { plugins: [createTestI18n()] } }
	);
	wrappers.push(w);
	return w;
}

function items(path = '/dashboard/postbox/inbox/m1'): PaletteItem[] {
	return resolvePaletteGroups(
		[],
		useCommandPaletteRegistry().value,
		{ path, isFlagEnabled: () => true },
		{ query: '', mode: 'commands' }
	).flatMap((group) => (group.key === CONVERSATION_TASK_COMMAND_GROUP_KEY ? group.items : []));
}

const byId = (list: PaletteItem[], id: string) => list.find((item) => item.id === id);

describe('useConversationTaskCommands', () => {
	it('offers Make task, Done on the top item and the open tasks, each running its own action', () => {
		vi.useFakeTimers();
		const src = sources();
		mountHeader(src);
		const list = items();
		expect(list.map((item) => [item.label, item.subtitle])).toEqual([
			['Make task from this conversation', undefined],
			['Mark “Approve the revised quote” done', undefined],
			['Open tasks from this conversation', '2 open'],
		]);
		expect(queried).toEqual([{ mailThreadId: 'thread_1' }]);

		// Make task waits for the palette to hand focus back before the popover opens.
		byId(list, 'conversation:make-task')!.run();
		expect(src.openMakeTask).not.toHaveBeenCalled();
		vi.runAllTimers();
		expect(src.openMakeTask).toHaveBeenCalledOnce();

		byId(list, 'conversation:mark-done')!.run();
		expect(src.markDone).toHaveBeenCalledOnce();
		byId(list, 'conversation:open-tasks')!.run();
		expect(navigateTo).toHaveBeenCalledWith('/dashboard/tasks?task=task_1');
	});

	it('leaves out Done when the header does not offer it, and the tasks when none is open', () => {
		tasks.value = [{ _id: 'task_3', status: 'done' }];
		mountHeader(sources({ doneItem: () => null }));
		expect(items().map((item) => item.id)).toEqual(['conversation:make-task']);
	});

	it('reads a Team Inbox thread by its conversation, on the Team Inbox route', () => {
		mountHeader(
			sources({ mailThreadId: () => undefined, conversationThreadId: () => 'conv_1' as never })
		);
		expect(queried).toEqual([{ conversationThreadId: 'conv_1' }]);
		expect(items('/dashboard/inbox/conv_1').length).toBe(3);
	});

	it('offers nothing without a conversation, or away from the reader and the Team Inbox', () => {
		mountHeader(sources());
		expect(items('/dashboard/campaigns')).toEqual([]);
		expect(items('/dashboard/postbox-archive')).toEqual([]);
		for (const w of wrappers.splice(0)) w.unmount();

		mountHeader(sources({ mailThreadId: () => undefined }));
		expect(queried.at(-1)).toBe('skip');
		expect(items()).toEqual([]);
	});

	it('answers for the conversation in front only, and is gone once it closes', async () => {
		const Header = defineComponent({
			props: { src: { type: Object, required: true } },
			setup(props) {
				useConversationTaskCommands(props.src as ConversationTaskCommandSources);
				return () => h('div');
			},
		});
		// One app, as in the dashboard: the Today overlay's header mounts over the reader's.
		const shown = ref(['under', 'over']);
		const all = {
			under: sources({ doneItem: () => 'Under' }),
			over: sources({ doneItem: () => 'Over' }),
		};
		const w = mount(
			defineComponent({
				setup: () => () =>
					shown.value.map((key) => h(Header, { key, src: all[key as keyof typeof all] })),
			}),
			{ global: { plugins: [createTestI18n()] } }
		);
		wrappers.push(w);
		expect(items().filter((item) => item.id === 'conversation:make-task')).toHaveLength(1);
		expect(byId(items(), 'conversation:mark-done')!.label).toBe('Mark “Over” done');

		shown.value = ['under'];
		await nextTick();
		expect(byId(items(), 'conversation:mark-done')!.label).toBe('Mark “Under” done');

		shown.value = [];
		await nextTick();
		expect(items()).toEqual([]);
	});
});
