/**
 * The Postbox attachment row tells a screen reader about its upload queue
 * (plan item OW-067): a polite status region that is mounted before any file
 * is added, reads how many files wait for a transfer slot, says when none do
 * any more, and stays put while bytes go out.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import type { UploadChip } from '~/composables/postbox/postboxAttachmentUploads';
import { formatCompactFileSize } from '~/utils/formatters';
import { shouldOfferShareLink } from '~/utils/postboxShareLink';
import PostboxComposerAttachments from '../PostboxComposerAttachments.vue';

beforeAll(() => {
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		formatCompactFileSize,
		shouldOfferShareLink,
	});
});

const meter = { visible: false, amber: false, ratio: 0, totalBytes: 0, budgetBytes: 1 };

function chip(id: string, status: UploadChip['status'], progress = 0): UploadChip {
	return {
		id,
		filename: `${id}.pdf`,
		contentType: 'application/pdf',
		size: 1000,
		status,
		progress,
		indeterminate: status !== 'uploading',
		thumbUrl: null,
	};
}

function mountRow(uploads: UploadChip[] = []) {
	return mount(PostboxComposerAttachments, {
		attachTo: document.body,
		props: { attachments: [], uploads, meter, thumbUrlFor: () => null },
		attrs: { inert: true },
		global: { plugins: [createTestI18n()], stubs: { Icon: true } },
	});
}

describe('PostboxComposerAttachments upload queue status', () => {
	it('is a polite status region, mounted and silent before any file is added', () => {
		const wrapper = mountRow();
		const region = wrapper.get('[role="status"]');
		expect(region.attributes('aria-live')).toBe('polite');
		expect(region.text()).toBe('');
	});

	it('reads the queue as it changes, but not byte progress', async () => {
		const wrapper = mountRow();
		const region = () => wrapper.get('[role="status"]').text();

		await wrapper.setProps({
			uploads: [chip('a', 'uploading'), chip('b', 'queued'), chip('c', 'queued')],
		});
		expect(region()).toBe('2 files waiting to upload');

		await wrapper.setProps({
			uploads: [chip('a', 'uploading', 0.6), chip('b', 'queued'), chip('c', 'queued')],
		});
		expect(region()).toBe('2 files waiting to upload');

		await wrapper.setProps({ uploads: [chip('b', 'uploading'), chip('c', 'queued')] });
		expect(region()).toBe('1 file waiting to upload');

		await wrapper.setProps({ uploads: [chip('b', 'uploading'), chip('c', 'uploading')] });
		expect(region()).toBe('No more files waiting to upload');
	});

	it('says nothing for uploads that never queued', async () => {
		const wrapper = mountRow();
		await wrapper.setProps({ uploads: [chip('a', 'uploading')] });
		await wrapper.setProps({ uploads: [] });
		expect(wrapper.get('[role="status"]').text()).toBe('');
	});

	it('keeps the parent attributes on the visible row, not on the status', () => {
		const wrapper = mountRow([chip('a', 'queued')]);
		expect(wrapper.get('[role="status"]').attributes('inert')).toBeUndefined();
		expect(wrapper.get('[role="status"] + div').attributes('inert')).toBeDefined();
	});
});
