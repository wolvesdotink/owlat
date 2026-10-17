/**
 * The reader's open signal (review r1, F4): each message counts when its body
 * is shown, once, and a collapsed message never does.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import { usePostboxSenderOpen } from '../usePostboxSenderOpen';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, { get: () => anyPath, apply: () => anyPath });
	return { api: anyPath };
});

const run = vi.fn(async () => ({ ok: true }));

beforeAll(() => {
	vi.stubGlobal('useI18n', () => ({ t: (key: string) => key }));
	vi.stubGlobal('useBackendOperation', () => ({ run }));
});

beforeEach(() => run.mockClear());

describe('usePostboxSenderOpen', () => {
	it('counts a message only once its body is shown, and only once', async () => {
		const id = ref('m-old');
		const shown = ref(false);
		usePostboxSenderOpen(
			() => id.value,
			() => shown.value
		);
		expect(run).not.toHaveBeenCalled();

		shown.value = true;
		await nextTick();
		expect(run).toHaveBeenCalledWith({ messageId: 'm-old' });

		shown.value = false;
		await nextTick();
		shown.value = true;
		await nextTick();
		expect(run).toHaveBeenCalledTimes(1);
	});

	it('counts each message of the thread that gets shown', async () => {
		const id = ref('m-1');
		usePostboxSenderOpen(
			() => id.value,
			() => true
		);
		id.value = 'm-2';
		await nextTick();
		expect(run.mock.calls.map(([args]) => args)).toEqual([
			{ messageId: 'm-1' },
			{ messageId: 'm-2' },
		]);
	});
});
