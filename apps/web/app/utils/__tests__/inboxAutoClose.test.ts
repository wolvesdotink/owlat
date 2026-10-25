import { describe, expect, it } from 'vitest';
import {
	autoCloseDaysProblem,
	isAutoClosed,
	threadAutoCloseFact,
	threadAutoCloseSwitch,
	type ThreadAutoCloseView,
} from '../inboxAutoClose';

const view = (over: Partial<ThreadAutoCloseView> = {}): ThreadAutoCloseView => ({
	isPolicyEnabled: true,
	quietDays: 7,
	isDisabledForThread: false,
	dueAt: null,
	autoClosedAt: null,
	autoClosedQuietDays: null,
	...over,
});

describe('autoCloseDaysProblem', () => {
	it('accepts the same whole days the backend does', () => {
		expect(autoCloseDaysProblem(1)).toBe(false);
		expect(autoCloseDaysProblem(365)).toBe(false);
		for (const days of [0, 366, 2.5, Number.NaN]) expect(autoCloseDaysProblem(days)).toBe(true);
	});
});

describe('threadAutoCloseSwitch', () => {
	it('is on with the rule, off when the thread opted out, hidden otherwise', () => {
		expect(threadAutoCloseSwitch(view())).toBe('on');
		expect(threadAutoCloseSwitch(view({ isDisabledForThread: true }))).toBe('off');
		// Opted out while the rule is off: still offered, to let it back in.
		expect(threadAutoCloseSwitch(view({ isPolicyEnabled: false, isDisabledForThread: true }))).toBe(
			'off'
		);
		expect(threadAutoCloseSwitch(view({ isPolicyEnabled: false }))).toBeNull();
		expect(threadAutoCloseSwitch(null)).toBeNull();
	});
});

describe('threadAutoCloseFact', () => {
	it('says when a waiting thread closes, else after how many days it would', () => {
		expect(threadAutoCloseFact(view({ dueAt: 123 }))).toEqual({
			key: 'dashboard.inbox.detail.autoClose.closesAt',
			dueAt: 123,
		});
		expect(threadAutoCloseFact(view())).toEqual({
			key: 'dashboard.inbox.detail.autoClose.onWhenWaiting',
			days: 7,
		});
		expect(threadAutoCloseFact(view({ isDisabledForThread: true }))).toEqual({
			key: 'dashboard.inbox.detail.autoClose.off',
		});
		expect(threadAutoCloseFact(view({ isPolicyEnabled: false }))).toBeNull();
	});
});

describe('isAutoClosed', () => {
	it('only while the resolve the sweep made stands', () => {
		expect(isAutoClosed({ status: 'resolved', autoClosedAt: 1 })).toBe(true);
		expect(isAutoClosed({ status: 'closed', autoClosedAt: 1 })).toBe(true);
		expect(isAutoClosed({ status: 'resolved' })).toBe(false);
		expect(isAutoClosed({ status: 'open', autoClosedAt: 1 })).toBe(false);
		expect(isAutoClosed(null)).toBe(false);
	});
});
