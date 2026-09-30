/**
 * "Files in this thread" (utils/answerThreadFiles): real attachments only,
 * newest first, each file once; the drag payload survives the round trip and a
 * foreign drop reads as nothing.
 */
import { describe, it, expect } from 'vitest';
import {
	THREAD_FILE_DRAG_TYPE,
	threadFileFromDrop,
	threadFilesOf,
} from '../answerThreadFiles';

const pdf = (partIndex: string, filename = 'invoice.pdf', size = 1000) => ({
	filename,
	contentType: 'application/pdf',
	size,
	partIndex,
});

describe('threadFilesOf', () => {
	it('lists attachments newest first, with their sender', () => {
		const files = threadFilesOf([
			{ _id: 'm1', receivedAt: 1, fromAddress: 'jonas@example.com', attachments: [pdf('1', 'po.pdf')] },
			{ _id: 'm2', receivedAt: 2, fromAddress: 'ada@example.com', attachments: [pdf('2')] },
		]);
		expect(files.map((f) => [f.key, f.filename, f.fromAddress])).toEqual([
			['m2:2', 'invoice.pdf', 'ada@example.com'],
			['m1:1', 'po.pdf', 'jonas@example.com'],
		]);
	});

	it('leaves out inline images and calendar invites', () => {
		const files = threadFilesOf([
			{
				_id: 'm1',
				receivedAt: 1,
				attachments: [
					{ ...pdf('1', 'logo.png'), contentType: 'image/png', contentId: 'logo' },
					{ ...pdf('2', 'invite.ics'), contentType: 'text/calendar' },
					pdf('3'),
				],
			},
		]);
		expect(files.map((f) => f.filename)).toEqual(['invoice.pdf']);
	});

	it('lists a file sent twice once, at its newest copy', () => {
		const files = threadFilesOf([
			{ _id: 'm1', receivedAt: 1, attachments: [pdf('1')] },
			{ _id: 'm2', receivedAt: 2, attachments: [pdf('1')] },
		]);
		expect(files.map((f) => f.messageId)).toEqual(['m2']);
	});
});

describe('threadFileFromDrop', () => {
	const transfer = (data: Record<string, string>) =>
		({ getData: (type: string) => data[type] ?? '' }) as unknown as DataTransfer;

	it('reads back a dragged chip', () => {
		const [file] = threadFilesOf([{ _id: 'm1', receivedAt: 5, attachments: [pdf('2')] }]);
		const read = threadFileFromDrop(transfer({ [THREAD_FILE_DRAG_TYPE]: JSON.stringify(file) }));
		expect(read).toEqual(file);
	});

	it('is null for anything else', () => {
		expect(threadFileFromDrop(transfer({ 'text/plain': 'hi' }))).toBeNull();
		expect(threadFileFromDrop(transfer({ [THREAD_FILE_DRAG_TYPE]: '{not json' }))).toBeNull();
		expect(threadFileFromDrop(transfer({ [THREAD_FILE_DRAG_TYPE]: '{"filename":"x"}' }))).toBeNull();
		expect(threadFileFromDrop(null)).toBeNull();
	});
});
