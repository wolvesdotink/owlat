/**
 * Answer mode's session state: the way back (Esc returns to exactly the page
 * the reply started from), the list's place across the round trip, the draft
 * left behind, the pending AI body, and the Cmd/Ctrl+J focus hook.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { mount } from '@vue/test-utils';

let state: Map<string, ReturnType<typeof ref>>;
const navigateTo = vi.fn();
const back = vi.fn();
const currentRoute = ref({
	path: '/dashboard/postbox/inbox',
	fullPath: '/dashboard/postbox/inbox',
});

vi.stubGlobal('useState', (key: string, init: () => unknown) => {
	if (!state.has(key)) state.set(key, ref(init()));
	return state.get(key);
});
vi.stubGlobal('useRouter', () => ({ currentRoute, back }));
vi.stubGlobal('navigateTo', navigateTo);

import {
	answerDoneTarget,
	rememberListPlace,
	takeListPlace,
	useListAnswerRoundTrip,
	useAnswerAiFocus,
	useAnswerLeftDraft,
	useAnswerModeNav,
	useAnswerPendingLead,
} from '../useAnswerMode';

beforeEach(() => {
	state = new Map();
	navigateTo.mockClear();
	back.mockClear();
	currentRoute.value = { path: '/dashboard/postbox/inbox', fullPath: '/dashboard/postbox/inbox' };
	window.history.replaceState({}, '');
	// Drain any place a previous test left pending.
	takeListPlace('__drain__');
});

describe('useAnswerModeNav', () => {
	it('opens the route and remembers the page it came from', () => {
		currentRoute.value = {
			path: '/dashboard/postbox/inbox/msg_1',
			fullPath: '/dashboard/postbox/inbox/msg_1?mailbox=mbx_1',
		};
		const nav = useAnswerModeNav();
		void nav.open('msg_1', { kind: 'replyAll' });
		expect(navigateTo).toHaveBeenCalledWith('/dashboard/answer/m/msg_1?kind=replyAll');
		expect(nav.returnPath.value).toBe('/dashboard/postbox/inbox/msg_1?mailbox=mbx_1');
	});

	it('walks back through history when the previous entry is where it came from', () => {
		const nav = useAnswerModeNav();
		void nav.open('msg_1');
		window.history.replaceState({ back: '/dashboard/postbox/inbox' }, '');
		nav.leave();
		expect(back).toHaveBeenCalledTimes(1);
		expect(navigateTo).toHaveBeenCalledTimes(1);
	});

	it('replaces instead when there is no such entry (a deep link, a reload)', () => {
		const nav = useAnswerModeNav();
		nav.leave();
		expect(back).not.toHaveBeenCalled();
		expect(navigateTo).toHaveBeenCalledWith('/dashboard/postbox/inbox', { replace: true });
	});

	it('falls back to the Team inbox from a team thread opened by deep link or reload', () => {
		currentRoute.value = { path: '/dashboard/answer/t/ct_1', fullPath: '/dashboard/answer/t/ct_1' };
		const nav = useAnswerModeNav({ currentPath: () => '/dashboard/answer/t/ct_1' });
		expect(nav.returnPath.value).toBe('/dashboard/inbox');
		nav.leave();
		expect(navigateTo).toHaveBeenCalledWith('/dashboard/inbox', { replace: true });
	});

	it('falls back to the Postbox inbox from a Postbox reply opened the same way', () => {
		currentRoute.value = {
			path: '/dashboard/answer/m/msg_1',
			fullPath: '/dashboard/answer/m/msg_1',
		};
		const nav = useAnswerModeNav();
		nav.leave();
		expect(navigateTo).toHaveBeenCalledWith('/dashboard/postbox/inbox', { replace: true });
	});

	it('names the way back without touching the router (safe outside a component)', () => {
		const useRouterSpy = vi.fn(() => ({ currentRoute, back }));
		vi.stubGlobal('useRouter', useRouterSpy);
		const nav = useAnswerModeNav({ currentPath: () => '/dashboard/answer/t/ct_1' });
		expect(nav.returnPath.value).toBe('/dashboard/inbox');
		expect(useRouterSpy).not.toHaveBeenCalled();
		vi.stubGlobal('useRouter', () => ({ currentRoute, back }));
	});

	it('keeps the original way back while moving between replies', () => {
		const nav = useAnswerModeNav();
		void nav.open('msg_1');
		currentRoute.value = {
			path: '/dashboard/answer/m/msg_1',
			fullPath: '/dashboard/answer/m/msg_1',
		};
		void nav.open('msg_2');
		expect(nav.returnPath.value).toBe('/dashboard/postbox/inbox');
	});
});

describe('the list place', () => {
	it('is handed back once, and only on the way back from Answer mode', () => {
		rememberListPlace('inbox', { focusedId: 'msg_3' });
		// A later plain visit to the folder starts fresh.
		expect(takeListPlace('inbox')).toBeNull();

		rememberListPlace('inbox', { focusedId: 'msg_3' });
		void useAnswerModeNav().open('msg_3');
		expect(takeListPlace('inbox')).toEqual({ focusedId: 'msg_3' });
		expect(takeListPlace('inbox')).toBeNull();
	});
});

describe('a reply marked done', () => {
	const rows = (...ids: string[]) => ids.map((id) => ({ id, threadId: `t_${id}` }));
	const origin = {
		listPath: '/dashboard/postbox/inbox',
		messagePath: '/dashboard/postbox/inbox',
		query: '?placement=other',
		rows: rows('msg_0', 'msg_1', 'msg_2'),
		activeId: null,
	};
	const done = (messageId: string, threadId: string | null = `t_${messageId}`) => ({
		messageId,
		threadId,
	});

	it('moves on through the list it came from, per the auto-advance preference', () => {
		expect(answerDoneTarget(origin, done('msg_1'), 'next')).toBe(
			'/dashboard/postbox/inbox/msg_2?placement=other'
		);
		expect(answerDoneTarget(origin, done('msg_1'), 'previous')).toBe(
			'/dashboard/postbox/inbox/msg_0?placement=other'
		);
		expect(answerDoneTarget(origin, done('msg_1'), 'back-to-list')).toBe(
			'/dashboard/postbox/inbox?placement=other'
		);
		// Past the end there is nothing to open: the list itself.
		expect(answerDoneTarget(origin, done('msg_2'), 'next')).toBe(
			'/dashboard/postbox/inbox?placement=other'
		);
	});

	it('skips the other rows of the conversation the same send archives, both ways', () => {
		// A flat feed: a1 and a2 are one conversation, b and z others.
		const feed = {
			...origin,
			query: '',
			rows: [
				{ id: 'z', threadId: 't_z' },
				{ id: 'a2', threadId: 't_a' },
				{ id: 'a1', threadId: 't_a' },
				{ id: 'b', threadId: 't_b' },
			],
		};
		expect(answerDoneTarget(feed, done('a2', 't_a'), 'next')).toBe('/dashboard/postbox/inbox/b');
		expect(answerDoneTarget(feed, done('a1', 't_a'), 'previous')).toBe(
			'/dashboard/postbox/inbox/z'
		);
		// Only the conversation's rows left on that side: back to the list.
		expect(
			answerDoneTarget({ ...feed, rows: feed.rows.slice(0, 3) }, done('a2', 't_a'), 'next')
		).toBe('/dashboard/postbox/inbox');
	});

	it('finds the conversation when it answered a message that is not a row of the list', () => {
		// Another message of its conversation is a row.
		expect(answerDoneTarget(origin, done('msg_old', 't_msg_0'), 'next')).toBe(
			'/dashboard/postbox/inbox/msg_1?placement=other'
		);
		// Without a thread to go by, the row open beside the list.
		expect(answerDoneTarget({ ...origin, activeId: 'msg_0' }, done('msg_old', null), 'next')).toBe(
			'/dashboard/postbox/inbox/msg_1?placement=other'
		);
		expect(answerDoneTarget(origin, done('msg_old', null), 'next')).toBe(
			'/dashboard/postbox/inbox?placement=other'
		);
	});

	it('goes back to a label view, and opens its rows where the label view opens them', () => {
		const label = {
			...origin,
			listPath: '/dashboard/postbox/label/lbl_1',
			query: '',
		};
		expect(answerDoneTarget(label, done('msg_1'), 'back-to-list')).toBe(
			'/dashboard/postbox/label/lbl_1'
		);
		expect(answerDoneTarget(label, done('msg_2'), 'next')).toBe('/dashboard/postbox/label/lbl_1');
		expect(answerDoneTarget(label, done('msg_1'), 'next')).toBe('/dashboard/postbox/inbox/msg_2');
	});

	it('has nowhere to move on to without a list', () => {
		expect(answerDoneTarget(null, done('msg_1'), 'next')).toBeNull();
	});

	function mountList(opts: { routes?: boolean; listPath?: string } = {}) {
		return mount(
			defineComponent({
				setup() {
					useListAnswerRoundTrip({
						folderKey: ref('inbox'),
						rows: ref([
							{ _id: 'msg_0', threadId: 't_0' },
							{ _id: 'msg_1', threadId: 't_1' },
							{ _id: 'msg_1b', threadId: 't_1' },
							{ _id: 'msg_2', threadId: 't_2' },
						]),
						focusedIndex: ref(0),
						origin: () =>
							opts.routes === false
								? null
								: {
										listPath: opts.listPath ?? '/dashboard/postbox/inbox',
										messagePath: '/dashboard/postbox/inbox',
										query: '',
										activeId: 'msg_1',
									},
					});
					return () => h('div');
				},
			})
		);
	}

	it('moves on when Answer mode was opened from a list that routes its opens', () => {
		const list = mountList();
		const nav = useAnswerModeNav();
		void nav.open('msg_1');
		list.unmount();
		navigateTo.mockClear();
		nav.leaveDone({ messageId: 'msg_1', threadId: 't_1' }, 'next');
		expect(navigateTo).toHaveBeenCalledWith('/dashboard/postbox/inbox/msg_2', { replace: true });
	});

	it('goes back to the label view it came from', () => {
		const list = mountList({ listPath: '/dashboard/postbox/label/lbl_1' });
		const nav = useAnswerModeNav();
		void nav.open('msg_1');
		list.unmount();
		navigateTo.mockClear();
		nav.leaveDone({ messageId: 'msg_1', threadId: 't_1' }, 'back-to-list');
		expect(navigateTo).toHaveBeenCalledWith('/dashboard/postbox/label/lbl_1', { replace: true });
	});

	it('goes back the plain way when the list was left for somewhere else first', () => {
		// The list unmounts on a plain navigation, then Answer mode opens elsewhere.
		mountList().unmount();
		const nav = useAnswerModeNav();
		void nav.open('msg_1');
		navigateTo.mockClear();
		nav.leaveDone({ messageId: 'msg_1', threadId: 't_1' }, 'next');
		expect(navigateTo).toHaveBeenCalledWith('/dashboard/postbox/inbox', { replace: true });
	});

	it('forgets the list once Answer mode is left, and for a list that does not route', () => {
		const list = mountList();
		const nav = useAnswerModeNav();
		void nav.open('msg_1');
		list.unmount();
		nav.leave();
		navigateTo.mockClear();
		nav.leaveDone({ messageId: 'msg_1', threadId: 't_1' }, 'next');
		expect(navigateTo).toHaveBeenCalledWith('/dashboard/postbox/inbox', { replace: true });

		const selectable = mountList({ routes: false });
		void nav.open('msg_1');
		selectable.unmount();
		navigateTo.mockClear();
		nav.leaveDone({ messageId: 'msg_1', threadId: 't_1' }, 'next');
		expect(navigateTo).toHaveBeenCalledWith('/dashboard/postbox/inbox', { replace: true });
	});
});

describe('useAnswerLeftDraft / useAnswerPendingLead', () => {
	it('keeps the draft left behind until cleared', () => {
		const { left, set, clear } = useAnswerLeftDraft();
		set({
			draftId: 'd_1' as never,
			messageId: 'msg_1',
			mailboxId: 'mbx_1',
			kind: null,
			recipient: 'Jonas',
		});
		expect(useAnswerLeftDraft().left.value?.recipient).toBe('Jonas');
		clear();
		expect(left.value).toBeNull();
	});

	it('hands a pending AI body to the message it was meant for, once', () => {
		const lead = useAnswerPendingLead();
		lead.set('msg_1', 'Tuesday works');
		expect(lead.take('msg_2')).toBeUndefined();
		expect(lead.take('msg_1')).toBe('Tuesday works');
		expect(lead.take('msg_1')).toBeUndefined();
	});
});

describe('useAnswerAiFocus', () => {
	it('focuses whatever registered, and reports when nothing did', () => {
		const focus = useAnswerAiFocus();
		expect(focus.request()).toBe(false);
		const handler = vi.fn();
		const unregister = focus.register(handler);
		expect(focus.request()).toBe(true);
		expect(handler).toHaveBeenCalledTimes(1);
		unregister();
		expect(focus.request()).toBe(false);
	});
});
