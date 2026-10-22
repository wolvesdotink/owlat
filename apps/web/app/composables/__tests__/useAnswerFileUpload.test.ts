/**
 * The answer-file upload is a mint (untracked) plus a transfer (not a write),
 * so on its own the slow-save registry cannot see it: it holds any slow-save
 * episode open until the file is up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import {
	EPISODE_QUIET_MS,
	onSlowEpisodeEnd,
	resetPendingOperations,
	SLOW_OPERATION_MS,
	trackPendingOperation,
	type SlowEpisodeOutcome,
} from '~/lib/pendingOperations';
import { useAnswerFileUpload } from '../useAnswerFileUpload';

const xhrPutFile = vi.fn();
vi.mock('~/composables/postbox/postboxAttachmentUploads', () => ({
	xhrPutFile: (...args: unknown[]) => xhrPutFile(...args),
}));

const file = new File(['scan'], 'contract.pdf', { type: 'application/pdf' });

let outcomes: SlowEpisodeOutcome[];
let stop: () => void;

beforeEach(() => {
	vi.useFakeTimers();
	outcomes = [];
	stop = onSlowEpisodeEnd((outcome) => outcomes.push(outcome));
	vi.stubGlobal('useI18n', () => ({ t: (key: string) => key }));
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
	vi.stubGlobal('useBackendOperation', () => ({
		run: vi.fn(async () => ({ ok: true, result: 'https://upload.owlat.example' })),
	}));
});
afterEach(() => {
	stop();
	resetPendingOperations();
	vi.useRealTimers();
	xhrPutFile.mockReset();
});

function setup() {
	const scope = effectScope();
	const uploader = scope.run(() => useAnswerFileUpload())!;
	return { uploader, scope };
}

describe('useAnswerFileUpload and the slow-save episode', () => {
	it('a slow write landing mid-transfer confirms nothing until the file is up', async () => {
		let finish!: (storageId: string) => void;
		xhrPutFile.mockReturnValue(new Promise<string>((resolve) => (finish = resolve)));
		const { uploader, scope } = setup();

		const slowWrite = trackPendingOperation(() => 'Archive');
		vi.advanceTimersByTime(SLOW_OPERATION_MS);
		const pending = uploader.upload(file);
		await vi.advanceTimersByTimeAsync(0);
		expect(xhrPutFile).toHaveBeenCalled();

		slowWrite(true);
		await vi.advanceTimersByTimeAsync(EPISODE_QUIET_MS * 3);
		expect(outcomes).toEqual([]);

		finish('st_1');
		expect(await pending).toMatchObject({ storageId: 'st_1', filename: 'contract.pdf' });
		await vi.advanceTimersByTimeAsync(EPISODE_QUIET_MS);
		expect(outcomes).toEqual(['saved']);
		scope.stop();
	});

	it('a failed transfer ends the episode as failed', async () => {
		xhrPutFile.mockRejectedValue(new Error('network'));
		const { uploader, scope } = setup();

		const slowWrite = trackPendingOperation(() => 'Archive');
		vi.advanceTimersByTime(SLOW_OPERATION_MS);
		const pending = uploader.upload(file);
		slowWrite(true);
		expect(await pending).toBeNull();
		await vi.advanceTimersByTimeAsync(EPISODE_QUIET_MS);

		expect(outcomes).toEqual(['failed']);
		scope.stop();
	});
});
