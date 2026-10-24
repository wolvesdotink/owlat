/**
 * Family `postbox-list`: the real `PostboxThreadList` holding a folder's
 * loaded rows, with its own windowing (rows past `POSTBOX_VIRTUAL_THRESHOLD`
 * mount only a window), keyboard model, optimistic layers and row triage.
 *
 * The rows reach the list the way the folder query hands them over: parsed
 * JSON through `shareStructure` into a `shallowRef`. A live update is the same
 * delivery with one row changed (marked read elsewhere), so structural sharing
 * keeps every other row's identity and the counters show how much of the list
 * one changed row re-renders. The host mirrors the Postbox layout around the
 * list: the density root and the list pane's scroll box.
 */
import { defineComponent, h, nextTick, shallowRef } from 'vue';
import { shareStructure } from '~/lib/structuralSharing';
import {
	firstUnread,
	markRead,
	postboxListWorkload,
	type SyntheticPostboxRow,
} from '../listWorkload';
import type { PostboxListScenario } from '../scenarios';
import { counter, percentile, timing, type Sample } from '../stats';
import { component } from './components';
import { nextFrame, sum, type Probe } from './probe';

const ROW_SELECTOR = 'li.pbx-row-li';

export function postboxList(scenario: PostboxListScenario) {
	const rows = postboxListWorkload(scenario);
	const data = shallowRef<SyntheticPostboxRow[] | undefined>(undefined);
	const deliver = (next: readonly SyntheticPostboxRow[]) => {
		data.value = shareStructure(
			data.value,
			JSON.parse(JSON.stringify(next)) as SyntheticPostboxRow[]
		);
	};
	deliver(rows);

	const PostboxThreadList = component('PostboxThreadList');
	const Host = defineComponent({
		name: 'PostboxListHost',
		setup() {
			return () =>
				h('div', { class: 'flex h-full flex-col', 'data-density': 'comfortable' }, [
					h('div', { class: 'flex-1 overflow-auto' }, [
						h(PostboxThreadList, {
							mailboxId: 'perf-mailbox',
							messages: data.value ?? [],
							loading: false,
							folderRole: 'inbox',
							activeMessageId: null,
							hasMore: false,
						}),
					]),
				]);
		},
	});

	async function run(probe: Probe, stage: HTMLElement): Promise<Sample> {
		const scroller = stage.querySelector<HTMLElement>('.postbox-thread-list');
		if (!scroller) throw new Error('PostboxThreadList rendered no scroll container');
		const rowsMountedAtTop = stage.querySelectorAll(ROW_SELECTOR).length;
		probe.takeUpdates();
		probe.takeMutations();
		probe.takeLongTasks();

		// One row changes on the server: the first unread row on screen is read.
		// An unread row's sender is set semibold (PostboxRowCore); a read one is not.
		const changed = firstUnread(rows);
		const isUnread = () =>
			stage.querySelector(`#postbox-row-${rows[changed]?._id} .font-semibold`) !== null;
		const wasUnread = isUnread();
		deliver(markRead(rows, changed));
		await nextTick();
		await nextFrame();
		const liveUpdates = probe.takeUpdates();
		const liveMutations = probe.takeMutations();
		const landed = wasUnread && !isUnread() ? 1 : 0;

		const scrollHeight = scroller.scrollHeight;
		const stepMs: number[] = [];
		const seen = new Set<string>();
		const noteRows = () => {
			for (const el of stage.querySelectorAll<HTMLElement>(`${ROW_SELECTOR} [role="option"]`)) {
				seen.add(el.id);
			}
		};
		noteRows();
		// Two frames a step: the list derives its window in an animation frame
		// after the scroll event, so a second step inside that frame would merge
		// with the first and the window counts would follow the frame timing.
		let last = await nextFrame();
		while (scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1) {
			scroller.scrollTop += scenario.scrollStepPx;
			await nextFrame();
			const now = await nextFrame();
			stepMs.push(now - last);
			last = now;
			noteRows();
		}
		const scrollUpdates = probe.takeUpdates();
		const scrollMutations = probe.takeMutations();
		const longTasks = probe.takeLongTasks();
		const total = (m: ReturnType<Probe['takeMutations']>) =>
			m.nodesAdded + m.nodesRemoved + m.textChanges + m.attributeChanges;

		return {
			'rows mounted at the top': counter(rowsMountedAtTop),
			'live update landed': counter(landed, 'bool'),
			'rows re-rendered by a one-row update': counter(liveUpdates.get('PostboxThreadRow') ?? 0),
			'component updates for a one-row update': counter(sum(liveUpdates.values())),
			'DOM mutations for a one-row update': counter(total(liveMutations)),
			'scroll height': counter(scrollHeight, 'px'),
			'scroll steps': counter(stepMs.length),
			'rows shown while scrolling': counter(seen.size),
			// Moving the window mounts and unmounts rows; a row that stays must not re-render.
			'rows re-rendered while scrolling': counter(scrollUpdates.get('PostboxThreadRow') ?? 0),
			'component updates while scrolling': counter(sum(scrollUpdates.values())),
			'DOM mutations while scrolling': counter(total(scrollMutations)),
			'step interval p50': timing(percentile(stepMs, 0.5)),
			'step interval p95': timing(percentile(stepMs, 0.95)),
			'step interval max': timing(Math.max(...stepMs)),
			'long tasks': timing(longTasks.length, 'count'),
			'long task time': timing(sum(longTasks)),
		};
	}

	return { Host, rows: rows.length, run };
}
