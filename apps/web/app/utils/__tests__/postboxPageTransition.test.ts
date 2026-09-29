import { describe, it, expect } from 'vitest';
import type { RouteMeta } from 'vue-router';

import {
	POSTBOX_INSTANT_PAGE_TRANSITION,
	isPostboxPath,
	postboxPageTransition,
} from '../postboxPageTransition';

function move(from: string, to: string): RouteMeta {
	const target = { path: to, meta: {} as RouteMeta };
	postboxPageTransition(target, { path: from });
	return target.meta;
}

describe('isPostboxPath', () => {
	it('matches the Postbox root and everything below it', () => {
		expect(isPostboxPath('/dashboard/postbox')).toBe(true);
		expect(isPostboxPath('/dashboard/postbox/')).toBe(true);
		expect(isPostboxPath('/dashboard/postbox/inbox/msg-1')).toBe(true);
		expect(isPostboxPath('/dashboard/postbox/search')).toBe(true);
	});

	it('does not match a sibling that only shares the prefix', () => {
		expect(isPostboxPath('/dashboard/postboxes')).toBe(false);
		expect(isPostboxPath('/dashboard/campaigns')).toBe(false);
		expect(isPostboxPath('/dashboard')).toBe(false);
	});
});

describe('postboxPageTransition', () => {
	it('swaps instantly between two Postbox pages', () => {
		expect(move('/dashboard/postbox/inbox', '/dashboard/postbox/search').pageTransition).toEqual(
			POSTBOX_INSTANT_PAGE_TRANSITION
		);
		expect(
			move('/dashboard/postbox/label/l1', '/dashboard/postbox/inbox/m1').pageTransition
		).toEqual(POSTBOX_INSTANT_PAGE_TRANSITION);
	});

	it('keeps the transition wrapper (css: false) instead of disabling it', () => {
		// `false` would drop the <Transition>, and the next move out of the
		// Postbox would mount a fresh one that fades nothing.
		const transition = move('/dashboard/postbox/inbox', '/dashboard/postbox/files').pageTransition;
		expect(transition).not.toBe(false);
		expect(transition).toMatchObject({ css: false, mode: 'out-in' });
	});

	it('leaves the app-wide fade alone for moves into and out of the Postbox', () => {
		expect(move('/dashboard', '/dashboard/postbox/inbox').pageTransition).toBeUndefined();
		expect(move('/dashboard/postbox/inbox', '/dashboard/campaigns').pageTransition).toBeUndefined();
	});

	it('hands each navigation its own copy', () => {
		const a = move('/dashboard/postbox/inbox', '/dashboard/postbox/sent').pageTransition;
		const b = move('/dashboard/postbox/sent', '/dashboard/postbox/inbox').pageTransition;
		expect(a).not.toBe(b);
		expect(a).not.toBe(POSTBOX_INSTANT_PAGE_TRANSITION);
	});
});
