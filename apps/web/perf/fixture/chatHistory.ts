/**
 * Family `chat-history`: the real `ChatMessageList` holding a room's whole
 * loaded window (500 messages, the `listMessages` cap), scrolled from the
 * newest message to the oldest one step per animation frame.
 *
 * The rows reach the list the way `useChatRoom` hands them over: parsed JSON
 * through `shareStructure`. The list opens at the bottom on its own
 * (`onMounted` scrolls there), so the scroll covers the full history.
 */
import { defineComponent, h, shallowRef } from 'vue';
import { shareStructure } from '~/lib/structuralSharing';
import type { ChatHistoryScenario } from '../scenarios';
import { counter, percentile, timing, type Sample } from '../stats';
import { CHAT_CURRENT_USER_ID, chatHistoryWorkload, type SyntheticChatRow } from '../workload';
import { component } from './components';
import { nextFrame, sum, type Probe } from './probe';

export function chatHistory(scenario: ChatHistoryScenario) {
	const rows = chatHistoryWorkload(scenario);
	const data = shallowRef(
		shareStructure(undefined, JSON.parse(JSON.stringify(rows)) as SyntheticChatRow[])
	);

	const ChatMessageList = component('ChatMessageList');
	const Host = defineComponent({
		name: 'ChatHistoryHost',
		setup() {
			return () =>
				h(ChatMessageList, { messages: data.value, currentUserId: CHAT_CURRENT_USER_ID });
		},
	});

	async function run(probe: Probe, stage: HTMLElement): Promise<Sample> {
		const scroller = stage.querySelector<HTMLElement>('.overflow-y-auto');
		if (!scroller) throw new Error('ChatMessageList rendered no scroll container');
		probe.takeUpdates();
		probe.takeMutations();
		probe.takeLongTasks();

		const scrollHeight = scroller.scrollHeight;
		const startTop = scroller.scrollTop;
		const frameMs: number[] = [];
		let last = await nextFrame();
		while (scroller.scrollTop > 0) {
			scroller.scrollTop = Math.max(0, scroller.scrollTop - scenario.scrollStepPx);
			const now = await nextFrame();
			frameMs.push(now - last);
			last = now;
		}
		const updates = probe.takeUpdates();
		const mutations = probe.takeMutations();
		const longTasks = probe.takeLongTasks();

		return {
			messages: counter(rows.length),
			'scroll height': counter(scrollHeight, 'px'),
			'opened at the bottom': counter(
				startTop + scroller.clientHeight >= scrollHeight - 1 ? 1 : 0,
				'bool'
			),
			'scroll frames': counter(frameMs.length),
			'component updates while scrolling': counter(sum(updates.values())),
			'DOM mutations while scrolling': counter(
				mutations.nodesAdded +
					mutations.nodesRemoved +
					mutations.textChanges +
					mutations.attributeChanges
			),
			'frame interval p50': timing(percentile(frameMs, 0.5)),
			'frame interval p95': timing(percentile(frameMs, 0.95)),
			'frame interval max': timing(Math.max(...frameMs)),
			'long tasks': timing(longTasks.length, 'count'),
			'long task time': timing(sum(longTasks)),
		};
	}

	return { Host, rows: rows.length, run };
}
