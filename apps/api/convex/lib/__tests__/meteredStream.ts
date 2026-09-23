/**
 * A pull-based byte stream for bounded-reader tests. The zero high-water mark
 * means the producer is only asked for a chunk when the reader reads, so the
 * meter counts exactly what the reader consumed, and `cancelled` records
 * whether the reader let go of the producer instead of draining it.
 *
 * `next(i)` returns the i-th chunk, `undefined` to end the body, `'stall'` to
 * never answer, or an Error to fail the stream.
 */
export type MeteredStep = Uint8Array | 'stall' | Error | undefined;

export function meteredStream(next: (index: number) => MeteredStep) {
	const meter = { pulledBytes: 0, cancelled: false };
	let index = 0;
	const stream = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				const step = next(index++);
				if (step === undefined) return controller.close();
				if (step === 'stall') return new Promise<void>(() => undefined);
				if (step instanceof Error) return controller.error(step);
				meter.pulledBytes += step.byteLength;
				controller.enqueue(step);
			},
			cancel() {
				meter.cancelled = true;
			},
		},
		{ highWaterMark: 0 }
	);
	return { stream, meter };
}
