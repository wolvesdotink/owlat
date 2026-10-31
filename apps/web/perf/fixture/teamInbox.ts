/**
 * Family `team-inbox`: real `InboxThreadRow` rows in the Team Inbox page's
 * list (pages/dashboard/inbox/index.vue): the same listbox, the same row props
 * and the page's keyboard model (`usePostboxListKeyboard`). The page itself
 * needs its signed-in queries, so the host rebuilds only its list.
 *
 * Threads arrive like the page's `listThreads` rows, through `shareStructure`.
 * Two live changes follow the mount: one thread read by the viewer (one row's
 * data changes) and one tick of the list's clock (the page hands every row the
 * same `now`, so a tick reaches each row with a waiting or deadline chip).
 */
import { computed, defineComponent, h, nextTick, shallowRef, type Ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { shareStructure } from '~/lib/structuralSharing';
import { SCENARIO_NOW } from '../browserContext';
import {
	INBOX_MEMBERS,
	markThreadRead,
	teamInboxWorkload,
	type SyntheticInboxThread,
} from '../listWorkload';
import type { TeamInboxScenario } from '../scenarios';
import { decodeInboxThreads } from '../wireRows';
import { counter, timing, type Sample } from '../stats';
import { autoImported } from './autoImports';
import { component } from './components';
import { nextFrame, sum, type Probe } from './probe';

/** The list clock's step: `useInbox` ticks once a minute. */
const CLOCK_TICK_MS = 60_000;

/** The part of `usePostboxListKeyboard`'s contract the page uses. */
type ListKeyboard = (opts: {
	items: Ref<SyntheticInboxThread[]>;
	resetKey: Ref<unknown>;
	rowDomId: (thread: SyntheticInboxThread) => string;
	scope: 'inboxList';
	onActivate: (thread: SyntheticInboxThread) => void;
}) => {
	focusedIndex: Ref<number>;
	activeId: Ref<string | undefined>;
	onKeydown: (event: KeyboardEvent) => void;
};

export function teamInbox(scenario: TeamInboxScenario) {
	const threads = teamInboxWorkload(scenario);
	const data = shallowRef<SyntheticInboxThread[] | undefined>(undefined);
	const deliver = (next: readonly SyntheticInboxThread[]) => {
		data.value = shareStructure(data.value, decodeInboxThreads(JSON.parse(JSON.stringify(next))));
	};
	deliver(threads);
	const now = shallowRef(SCENARIO_NOW);

	const InboxThreadRow = component('InboxThreadRow');
	const usePostboxListKeyboard = autoImported<ListKeyboard>('usePostboxListKeyboard');
	const formatCompactRelativeTime = autoImported<(timestamp: number) => string>(
		'formatCompactRelativeTime'
	);
	const Host = defineComponent({
		name: 'TeamInboxHost',
		setup() {
			const { t } = useI18n();
			const visible = computed(() => data.value ?? []);
			// The page's reset key: filter, assignee, sort and the mentions view.
			const { focusedIndex, activeId, onKeydown } = usePostboxListKeyboard({
				items: visible,
				resetKey: computed(() => 'open:anyone:newest:false'),
				rowDomId: (thread) => `inbox-row-${thread._id}`,
				scope: 'inboxList',
				onActivate: () => undefined,
			});
			return () =>
				h('div', { class: 'h-full overflow-auto' }, [
					h('div', { class: 'mx-auto w-full max-w-page p-6 lg:p-8' }, [
						h(
							'ul',
							{
								role: 'listbox',
								tabindex: 0,
								'aria-label': t('dashboard.inbox.index.listAriaLabel'),
								'aria-activedescendant': activeId.value,
								class:
									'divide-y divide-border-subtle focus:outline-none focus-visible:ring-1 focus-visible:ring-brand/50',
								onKeydown,
							},
							visible.value.map((thread, index) =>
								h(InboxThreadRow, {
									key: thread._id,
									thread,
									focused: index === focusedIndex.value,
									formatCompactRelativeTime,
									members: INBOX_MEMBERS,
									currentUserId: INBOX_MEMBERS[0]?.userId ?? null,
									canManage: true,
									now: now.value,
									assigneePresent: false,
									noteCount: index % 7 === 0 ? 2 : 0,
									hasDraft: false,
								})
							)
						),
					]),
				]);
		},
	});

	async function run(probe: Probe, stage: HTMLElement): Promise<Sample> {
		const rowsMounted = stage.querySelectorAll('li [role="option"]').length;
		probe.takeUpdates();
		probe.takeMutations();
		probe.takeLongTasks();
		const total = (m: ReturnType<Probe['takeMutations']>) =>
			m.nodesAdded + m.nodesRemoved + m.textChanges + m.attributeChanges;

		// An unread thread's row carries the brand dot; a read one does not.
		const changed = threads.findIndex((thread) => thread.unread);
		const isUnread = () =>
			stage.querySelector(`#inbox-row-${threads[changed]?._id} .rounded-full.bg-brand`) !== null;
		const wasUnread = isUnread();
		deliver(markThreadRead(threads, changed));
		await nextTick();
		await nextFrame();
		const liveUpdates = probe.takeUpdates();
		const liveMutations = probe.takeMutations();
		const landed = wasUnread && !isUnread() ? 1 : 0;

		const t0 = performance.now();
		now.value += CLOCK_TICK_MS;
		await nextTick();
		await nextFrame();
		const tickMs = performance.now() - t0;
		const tickUpdates = probe.takeUpdates();
		const tickMutations = probe.takeMutations();
		const longTasks = probe.takeLongTasks();

		return {
			'rows mounted': counter(rowsMounted),
			'live update landed': counter(landed, 'bool'),
			'rows re-rendered by a one-row update': counter(liveUpdates.get('InboxThreadRow') ?? 0),
			'component updates for a one-row update': counter(sum(liveUpdates.values())),
			'DOM mutations for a one-row update': counter(total(liveMutations)),
			'rows re-rendered by a clock tick': counter(tickUpdates.get('InboxThreadRow') ?? 0),
			'component updates for a clock tick': counter(sum(tickUpdates.values())),
			'DOM mutations for a clock tick': counter(total(tickMutations)),
			'clock tick to next frame': timing(tickMs),
			'long tasks': timing(longTasks.length, 'count'),
			'long task time': timing(sum(longTasks)),
		};
	}

	return { Host, rows: threads.length, run };
}
