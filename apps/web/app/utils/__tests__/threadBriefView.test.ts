/**
 * Which view a thread opens on (SPEC §7): the precedence of cite, `?view=`,
 * this visit's click, the per-thread choice and the saved default, and the
 * rule that a thread with nothing to show opens on Conversation.
 */
import { describe, expect, it } from 'vitest';
import {
	formatCite,
	latestCiteRef,
	parseCite,
	parseQueryView,
	resolveThreadView,
	type ThreadViewInput,
} from '../threadBriefView';

const base: ThreadViewInput = {
	isShared: false,
	hasCite: false,
	savedDefault: 'overview',
	availability: 'available',
};

describe('resolveThreadView', () => {
	it('opens on the Overview by default', () => {
		expect(resolveThreadView(base)).toBe('overview');
	});

	it('never shows an Overview in a shared mailbox', () => {
		expect(resolveThreadView({ ...base, isShared: true, queryView: 'overview' })).toBe(
			'conversation'
		);
	});

	it('a cite opens Conversation over every saved choice', () => {
		expect(
			resolveThreadView({
				...base,
				hasCite: true,
				queryView: 'overview',
				sessionChoice: 'overview',
				override: 'overview',
			})
		).toBe('conversation');
	});

	it('takes ?view= over the click, the click over the per-thread choice, that over the default', () => {
		expect(
			resolveThreadView({ ...base, queryView: 'conversation', sessionChoice: 'overview' })
		).toBe('conversation');
		expect(
			resolveThreadView({ ...base, sessionChoice: 'conversation', override: 'overview' })
		).toBe('conversation');
		expect(resolveThreadView({ ...base, override: 'overview', savedDefault: 'conversation' })).toBe(
			'overview'
		);
		expect(resolveThreadView({ ...base, savedDefault: 'conversation' })).toBe('conversation');
	});

	it('opens on Conversation when there is no interpretation, or the original is the view', () => {
		expect(resolveThreadView({ ...base, availability: 'none' })).toBe('conversation');
		expect(resolveThreadView({ ...base, availability: 'original' })).toBe('conversation');
		expect(resolveThreadView({ ...base, override: 'overview', availability: 'none' })).toBe(
			'conversation'
		);
	});

	it('still shows the (empty) Overview when the viewer asked for it', () => {
		expect(resolveThreadView({ ...base, availability: 'none', sessionChoice: 'overview' })).toBe(
			'overview'
		);
		expect(resolveThreadView({ ...base, availability: 'none', queryView: 'overview' })).toBe(
			'overview'
		);
	});

	it('waits while the brief or the saved default is loading', () => {
		expect(resolveThreadView({ ...base, availability: 'loading' })).toBe('pending');
		expect(resolveThreadView({ ...base, savedDefault: undefined })).toBe('pending');
		// Nothing to show settles it without waiting for the default.
		expect(resolveThreadView({ ...base, savedDefault: undefined, availability: 'none' })).toBe(
			'conversation'
		);
	});
});

describe('cite and view params', () => {
	it('round-trips a cite, including a latest-update line', () => {
		expect(parseCite('item123:2')).toEqual({ ref: 'item123', quoteIndex: 2 });
		expect(parseCite(formatCite({ ref: latestCiteRef(1), quoteIndex: 0 }))).toEqual({
			ref: 'latest-1',
			quoteIndex: 0,
		});
	});

	it('rejects malformed cites and views', () => {
		for (const raw of ['', 'abc', ':1', 'abc:-1', 'abc:x', 3, undefined]) {
			expect(parseCite(raw)).toBeNull();
		}
		expect(parseQueryView('overview')).toBe('overview');
		expect(parseQueryView('summary')).toBeNull();
	});
});
