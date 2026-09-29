/**
 * Plan 2.5: the reader renders the row it was opened with, plus its inline
 * body, while the thread query loads, instead of a skeleton.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, ref, type Ref } from 'vue';
import { getFunctionName } from 'convex/server';
import {
	rowCarriesBody,
	usePostboxReaderOpenRow,
	withInlineBody,
} from '../usePostboxReaderOpenRow';

const row = { _id: 'm1', subject: 'Hello' };

describe('withInlineBody', () => {
	it('marks the row pending until the inline body answers', () => {
		expect(withInlineBody(row, undefined, false)).toEqual({ ...row, bodyPending: true });
	});

	it('folds an inline answer into the row', () => {
		expect(
			withInlineBody(
				row,
				{ htmlInline: '<p>hi</p>', textInline: 'hi', hasHtmlBlob: false, hasTextBlob: false },
				false
			)
		).toEqual({ ...row, htmlBodyInline: '<p>hi</p>', textBodyInline: 'hi', hasBodyBlob: false });
	});

	it('flags a blob-only body for the body component to download', () => {
		expect(
			withInlineBody(
				row,
				{ htmlInline: null, textInline: null, hasHtmlBlob: true, hasTextBlob: false },
				false
			)
		).toMatchObject({ htmlBodyInline: undefined, textBodyInline: undefined, hasBodyBlob: true });
	});

	it('leaves the row as it is for an unreadable message or a failed query', () => {
		expect(withInlineBody(row, null, false)).toBe(row);
		expect(withInlineBody(row, undefined, true)).toBe(row);
	});
});

describe('rowCarriesBody', () => {
	it('is true for inline bodies and storage blobs, false for a slim list row', () => {
		expect(rowCarriesBody({ _id: 'a', textBodyInline: 'x' })).toBe(true);
		expect(rowCarriesBody({ _id: 'a', htmlBodyStorageId: 's' })).toBe(true);
		expect(rowCarriesBody({ _id: 'a' })).toBe(false);
	});
});

describe('usePostboxReaderOpenRow', () => {
	const body = ref<unknown>(undefined);
	const calls: Array<{ name: string; args: unknown }> = [];

	beforeEach(() => {
		body.value = undefined;
		calls.length = 0;
		vi.stubGlobal('useConvexQuery', (query: unknown, args: () => unknown) => {
			const name = getFunctionName(query as never);
			calls.push({ name, args: args() });
			return { data: body as Ref<unknown>, error: ref(null), isLoading: ref(false) };
		});
	});

	function setup(
		message: Ref<Record<string, unknown> & { _id: string }>,
		thread: Ref<unknown[] | undefined>
	) {
		const scope = effectScope();
		const openRow = scope.run(() =>
			usePostboxReaderOpenRow({ message: () => message.value, threadMessages: () => thread.value })
		);
		if (!openRow) throw new Error('no result');
		return openRow;
	}

	it('asks for the inline body of a slim row while the thread loads, then hands over to the thread', () => {
		const message = ref<Record<string, unknown> & { _id: string }>({ ...row });
		const thread = ref<unknown[] | undefined>(undefined);
		const openRow = setup(message, thread);

		expect(calls[0]).toEqual({
			name: 'mail/mailbox/messages:getMessageInlineBody',
			args: { messageId: 'm1' },
		});
		expect(openRow.value).toMatchObject({ bodyPending: true });

		body.value = { htmlInline: null, textInline: 'plain', hasHtmlBlob: false, hasTextBlob: false };
		expect(openRow.value).toMatchObject({ textBodyInline: 'plain' });
		expect(openRow.value.bodyPending).toBeUndefined();

		thread.value = [{ _id: 'm1' }];
		expect(openRow.value).toBe(message.value);
	});

	it('uses a row that already carries its body as it is', () => {
		const message = ref<Record<string, unknown> & { _id: string }>({
			...row,
			htmlBodyInline: '<p>here</p>',
		});
		const openRow = setup(message, ref(undefined));
		expect(calls[0]?.args).toBe('skip');
		expect(openRow.value).toBe(message.value);
	});
});
