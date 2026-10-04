// @vitest-environment happy-dom
/**
 * The "What's new" part of the update card: the summary, the changes grouped
 * by kind with long groups and minor kinds folded away, and one toggle that
 * shows everything.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';
import AssistantInline from '~/components/assistant/AssistantInline.vue';
import { parseReleaseNotes } from '~/utils/releaseNotes';

import ReleaseNotes from '../ReleaseNotes.vue';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

const fixes = Array.from(
	{ length: 7 },
	(_, i) => `- **Fix ${i + 1}.** Details. (#${100 + i})`
).join('\n');
const BODY = `A fix release.

### Added

- **Saved replies.** Type a shortcut. (#1156)

### Fixed

${fixes}

### Documentation

- Every anchor link is checked. (#1234)
`;

function mountNotes() {
	return mount(ReleaseNotes, {
		props: { notes: parseReleaseNotes(BODY), version: '0.6.9' },
		global: {
			plugins: [createTestI18n()],
			components: { AssistantInline },
			stubs: { Icon: true },
		},
	});
}

describe('SystemReleaseNotes', () => {
	it('shows the summary and folds long and minor groups behind one toggle', () => {
		const wrapper = mountNotes();
		const text = wrapper.text();
		expect(text).toContain("What's new in v0.6.9");
		expect(text).toContain('A fix release.');
		expect(text).toContain('Saved replies.');
		expect(text).toContain('Fix 5.');
		expect(text).not.toContain('Fix 6.');
		expect(text).not.toContain('Every anchor link is checked.');
		expect(text).toContain('Show all changes (3 more)');
		expectFullyLocalized(wrapper);
	});

	it('shows every change once expanded, and folds them again', async () => {
		const wrapper = mountNotes();
		const toggle = wrapper.get('button[aria-expanded]');
		await toggle.trigger('click');
		expect(wrapper.text()).toContain('Fix 7.');
		expect(wrapper.text()).toContain('Every anchor link is checked.');
		expect(toggle.attributes('aria-expanded')).toBe('true');
		await toggle.trigger('click');
		expect(wrapper.text()).not.toContain('Fix 7.');
	});

	it('links PR references to the repository', () => {
		const link = mountNotes().get('a[href$="/pull/1156"]');
		expect(link.attributes('href')).toBe('https://github.com/wolvesdotink/owlat/pull/1156');
		expect(link.text()).toBe('#1156');
	});
});
