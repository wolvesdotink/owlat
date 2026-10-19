// @vitest-environment happy-dom
/**
 * The version list's "Show older versions" control: offered only while older
 * versions wait behind the last one shown, and it says so when a read failed.
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { formatCompactFileSize, formatDateTime } from '~/utils/formatters';
import VersionHistory from '../VersionHistory.vue';

Object.assign(globalThis, { useI18n: i18nStubs.useI18n });

const UiButton = defineComponent({
	props: { loading: Boolean },
	emits: ['click'],
	setup(props, { emit, slots }) {
		return () =>
			h(
				'button',
				{ 'data-loading': String(props.loading), onClick: () => emit('click') },
				slots.default?.()
			);
	},
});

const versions = [
	{ _id: 'v2', filename: 'report.txt', fileSize: 10, createdAt: 2, version: 2, url: null },
	{ _id: 'v1', filename: 'report.txt', fileSize: 9, createdAt: 1, version: 1, url: null },
];

function mountList(props: Record<string, unknown>) {
	return mount(VersionHistory, {
		props: { versions, currentVersionId: 'v2', ...props },
		global: {
			plugins: [createTestI18n()],
			mocks: { formatCompactFileSize, formatDateTime },
			stubs: { UiButton, Icon: true },
		},
	});
}

describe('FilesVersionHistory — older versions', () => {
	it('offers no control when the whole history is shown', () => {
		const wrapper = mountList({});
		expect(wrapper.find('button').exists()).toBe(false);
	});

	it('asks for older versions while some wait behind the list', async () => {
		const wrapper = mountList({ hasOlder: true });
		const button = wrapper.find('button');
		expect(button.text()).toContain('Show older versions');
		await button.trigger('click');
		expect(wrapper.emitted('loadOlder')).toHaveLength(1);
	});

	it('still offers them when no version on this page could be shown', () => {
		const wrapper = mountList({ versions: [], hasOlder: true });
		expect(wrapper.text()).toContain('No previous versions.');
		expect(wrapper.find('button').exists()).toBe(true);
	});

	it('shows the load in progress and a failed read', () => {
		const wrapper = mountList({ hasOlder: true, loadingOlder: true, loadOlderFailed: true });
		expect(wrapper.find('button').attributes('data-loading')).toBe('true');
		expect(wrapper.find('[role="alert"]').text()).toContain('could not be loaded');
	});
});
