/**
 * The reader header's Reply and Archive run the same reader action as `r` and
 * `e`, so their tooltip and `aria-keyshortcuts` name the key as this person
 * has it bound, and say nothing once it is unbound.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { applyShortcutPreferences, resetShortcutPreferences } from '~/utils/shortcutScope';
import PostboxThreadHeader from '../PostboxThreadHeader.vue';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
	vi.stubGlobal('useClickOutside', () => {});
});
enableAutoUnmount(afterEach);
afterEach(() => resetShortcutPreferences());

function mountHeader() {
	return mount(PostboxThreadHeader, {
		props: { subject: 'Invoice 4471', messageCount: 1, messageId: 'm1' as never },
		global: { plugins: [createTestI18n()], stubs: { PostboxOverflowMenu: true } },
	});
}

describe('reader header shortcuts', () => {
	it('names the reply and archive keys in the tooltip and for assistive tech', () => {
		const wrapper = mountHeader();
		const reply = wrapper.get('[data-testid="thread-header-reply"]');
		const archive = wrapper.get('[data-testid="thread-header-archive"]');
		expect(reply.attributes('title')).toBe('Reply (R)');
		expect(reply.attributes('aria-keyshortcuts')).toBe('r');
		expect(archive.attributes('title')).toBe('Archive (E)');
		expect(archive.attributes('aria-keyshortcuts')).toBe('e');
	});

	it('follows a remap and drops the key once it is unbound', async () => {
		const wrapper = mountHeader();
		applyShortcutPreferences('owlat', [
			{ id: 'postbox.archive', keys: ['y'] },
			{ id: 'postbox.reply', keys: [] },
		]);
		await nextTick();
		const archive = wrapper.get('[data-testid="thread-header-archive"]');
		expect(archive.attributes('title')).toBe('Archive (Y)');
		expect(archive.attributes('aria-keyshortcuts')).toBe('y');
		const reply = wrapper.get('[data-testid="thread-header-reply"]');
		expect(reply.attributes('title')).toBe('Reply');
		expect(reply.attributes('aria-keyshortcuts')).toBeUndefined();
	});
});
