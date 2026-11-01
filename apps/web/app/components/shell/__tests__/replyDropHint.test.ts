/**
 * The reply-drop hint says who the reply goes to and how many files ride
 * along, in the real catalog's words, and leaves out what the drag cannot say.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { shallowRef } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import type { ReplyDropHover } from '~/composables/useReplyFileDrop';

const hover = shallowRef<ReplyDropHover | null>(null);
vi.mock('~/composables/useReplyFileDrop', () => ({
	useReplyDropHost: () => ({ hover }),
}));

import ReplyDropHint from '../ReplyDropHint.vue';

let mounted: VueWrapper | null = null;

beforeEach(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
	mounted?.unmount();
	mounted = null;
	hover.value = null;
});

function show(recipient: string, count: number | null) {
	hover.value = {
		target: { kind: 'message', id: 'm1', recipient },
		count,
		rect: { top: 40, left: 300, width: 380, height: 84 },
	};
}

function render() {
	mounted?.unmount();
	mounted = mount(ReplyDropHint, {
		attachTo: document.body,
		global: { plugins: [createTestI18n()] },
	});
	return document.body.querySelector<HTMLElement>('[data-testid="reply-drop-hint"]');
}

describe('ReplyDropHint', () => {
	it('draws nothing while no file drag is over a conversation', () => {
		expect(render()).toBeNull();
	});

	it('names the recipient and the files, over the conversation', () => {
		show('Ines Weber', 2);
		const hint = render()!;
		expect(hint.textContent?.trim()).toBe('Drop to reply to Ines Weber with 2 files');
		expect(hint.style.top).toBe('40px');
		expect(hint.style.height).toBe('84px');
		expect(hint.getAttribute('aria-hidden')).toBe('true');
	});

	it('uses the singular for one file', () => {
		show('Ines Weber', 1);
		expect(render()!.textContent?.trim()).toBe('Drop to reply to Ines Weber with 1 file');
	});

	it('leaves out a count the platform hides, and a name the row cannot give', () => {
		show('Ines Weber', null);
		expect(render()!.textContent?.trim()).toBe('Drop to reply to Ines Weber with these files');
		show('', 3);
		expect(render()!.textContent?.trim()).toBe('Drop to reply with 3 files');
		show('', null);
		expect(render()!.textContent?.trim()).toBe('Drop to reply with these files');
	});
});
