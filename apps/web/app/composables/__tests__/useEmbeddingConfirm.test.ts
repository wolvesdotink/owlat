/**
 * One held confirmation at a time: free work runs at once, paid or
 * irreversible work waits, runs on confirm, and the dialog closes only once
 * the work landed.
 */
import { describe, expect, it, vi } from 'vitest';
import { useEmbeddingConfirm } from '../useEmbeddingConfirm';

const held = (run: () => Promise<boolean>) => ({ title: 'T', body: 'B', confirmText: 'Go', run });

describe('useEmbeddingConfirm', () => {
	it('runs free work at once and holds nothing', async () => {
		const run = vi.fn(async () => true);
		const confirm = useEmbeddingConfirm();
		await confirm.ask(false, held(run));
		expect(run).toHaveBeenCalledTimes(1);
		expect(confirm.pending.value).toBeNull();
	});

	it('holds paid work until confirmed, and closes once it landed', async () => {
		const run = vi.fn(async () => true);
		const confirm = useEmbeddingConfirm();
		await confirm.ask(true, held(run));
		expect(run).not.toHaveBeenCalled();
		await confirm.confirm();
		expect(run).toHaveBeenCalledTimes(1);
		expect(confirm.pending.value).toBeNull();
	});

	it('stays open when the work was refused, and drops it when dismissed', async () => {
		const run = vi.fn(async () => false);
		const confirm = useEmbeddingConfirm();
		await confirm.ask(true, held(run));
		await confirm.confirm();
		expect(confirm.pending.value).not.toBeNull();
		confirm.dismiss(false);
		expect(confirm.pending.value).toBeNull();
		await confirm.confirm();
		expect(run).toHaveBeenCalledTimes(1);
	});
});
