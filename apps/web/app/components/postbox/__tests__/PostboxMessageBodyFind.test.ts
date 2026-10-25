/**
 * Find in conversation in one message body: a match in the folded quote shows
 * the quote, apart from the reader's own toggle. Hiding it by hand wins while
 * find holds it open, and once find lets go the quote folds back unless the
 * reader opened it.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import type { PostboxMessageFind } from '~/composables/postbox/usePostboxThreadFind';
import PostboxMessageBody from '../PostboxMessageBody.vue';
import {
	splitQuotedText,
	splitQuotedHtml,
} from '../../../composables/postbox/usePostboxQuotedText';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
	vi.stubGlobal('requireConvex', () => ({ action: vi.fn() }));
	vi.stubGlobal('splitQuotedText', splitQuotedText);
	vi.stubGlobal('splitQuotedHtml', splitQuotedHtml);
	vi.stubGlobal('useAppTheme', () => ({ isDark: ref(false) }));
	vi.stubGlobal('usePostboxOfflineCache', () => ({
		isOffline: ref(false),
		persistBody: vi.fn(async () => {}),
		loadBody: vi.fn(async () => null),
	}));
});

const MESSAGE = {
	_id: 'msg-find',
	htmlBodyInline:
		'<p>Thanks, done.</p><blockquote type="cite"><p>Could you refund the second charge?</p></blockquote>',
};
const FOUND: PostboxMessageFind = { needle: 'refund', active: 0, forceQuoted: true, reveal: 1 };

async function mountBody() {
	const w = mount(PostboxMessageBody, {
		props: { message: MESSAGE, find: null },
		global: {
			plugins: [createTestI18n()],
			stubs: { PostboxImageBanner: true, PostboxReaderSkeleton: true, Icon: true },
		},
	});
	await flushPromises();
	return w;
}

const shows = (w: Awaited<ReturnType<typeof mountBody>>) =>
	w.get('iframe').attributes('srcdoc')?.includes('second charge') ?? false;
const toggle = (w: Awaited<ReturnType<typeof mountBody>>) =>
	w.findAll('button').find((b) => /quoted text/i.test(b.text()))!;

describe('PostboxMessageBody with find in conversation', () => {
	it('shows the quote while a match sits in it, and folds it back after', async () => {
		const w = await mountBody();
		expect(shows(w)).toBe(false);
		await w.setProps({ find: FOUND });
		await flushPromises();
		expect(shows(w)).toBe(true);
		expect(toggle(w).text()).toBe('Hide quoted text');
		await w.setProps({ find: null });
		await flushPromises();
		expect(shows(w)).toBe(false);
	});

	it('lets the reader hide it by hand while find holds it open', async () => {
		const w = await mountBody();
		await w.setProps({ find: FOUND });
		await flushPromises();
		await toggle(w).trigger('click');
		await flushPromises();
		expect(shows(w)).toBe(false);
		expect(toggle(w).text()).toBe('Show quoted text');
		// Find lets go and takes hold again: the hand-hide was for that stretch only.
		await w.setProps({ find: null });
		await w.setProps({ find: { ...FOUND, reveal: 2 } });
		await flushPromises();
		expect(shows(w)).toBe(true);
	});

	it('keeps a quote the reader opened when find lets go', async () => {
		const w = await mountBody();
		await toggle(w).trigger('click');
		await w.setProps({ find: FOUND });
		await w.setProps({ find: null });
		await flushPromises();
		expect(shows(w)).toBe(true);
	});
});
