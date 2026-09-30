// @vitest-environment happy-dom
/**
 * Answer mode's session state: the way back (Esc returns to exactly the page
 * the reply started from), the list's place across the round trip, the draft
 * left behind, the pending AI body, and the Cmd/Ctrl+J focus hook.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

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
	rememberListPlace,
	takeListPlace,
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
