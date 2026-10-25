import { describe, it, expect } from 'vitest';
import { ByteBudget } from '../budget.js';
import { SmtpCommandReader } from '../reader.js';

/**
 * An async-iterable source the test feeds one chunk at a time. `waiting()`
 * resolves once the reader has consumed everything it was given and asked for
 * the next chunk, so every chunk reaches the reader on its own: the split
 * points are exactly the ones the test chose, not whatever TCP coalesced.
 */
class ChunkFeed implements AsyncIterable<Buffer> {
	private pending: ((result: IteratorResult<Buffer>) => void) | undefined;
	private asked = Promise.withResolvers<void>();

	waiting(): Promise<void> {
		return this.asked.promise;
	}

	/** Hand the reader its next chunk, or end the stream with `null`. */
	send(chunk: string | null): void {
		const deliver = this.pending;
		if (!deliver) throw new Error('the reader has not asked for a chunk');
		this.pending = undefined;
		this.asked = Promise.withResolvers<void>();
		deliver(
			chunk === null ? { done: true, value: undefined } : { done: false, value: Buffer.from(chunk) }
		);
	}

	[Symbol.asyncIterator](): AsyncIterator<Buffer> {
		return {
			next: () =>
				new Promise<IteratorResult<Buffer>>((resolve) => {
					this.pending = resolve;
					this.asked.resolve();
				}),
		};
	}
}

async function feedAll(feed: ChunkFeed, chunks: Array<string | null>): Promise<void> {
	for (const chunk of chunks) {
		await feed.waiting();
		feed.send(chunk);
	}
}

describe('SmtpCommandReader DATA body across chunk boundaries', () => {
	it('assembles a body whose lines and terminator arrive as separate chunks', async () => {
		// No chunk but the last completes the terminator, which forces the
		// no-terminator flush/keep path (partial-terminator carry) on every step.
		const feed = new ChunkFeed();
		const reader = new SmtpCommandReader(feed);
		const budget = new ByteBudget(1024);
		const verdict = reader.readDataBody(budget);
		await feedAll(feed, ['first line of the body\r\n', 'second line of the body\r\n', '.', '\r\n']);
		await expect(verdict).resolves.toBe('ok');
		expect(budget.result().toString()).toBe(
			'first line of the body\r\nsecond line of the body\r\n'
		);
	});

	it('reports closed when the stream ends mid-DATA', async () => {
		const feed = new ChunkFeed();
		const reader = new SmtpCommandReader(feed);
		const verdict = reader.readDataBody(new ByteBudget(1024));
		await feedAll(feed, ['partial body with no terminator\r\n', null]);
		await expect(verdict).resolves.toBe('closed');
	});
});
