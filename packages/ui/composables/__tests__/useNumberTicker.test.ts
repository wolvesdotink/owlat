import { describe, expect, it } from 'vitest';
import { nextTick, ref } from 'vue';
import { defaultTickerFormat, parseCssDurationMs, useNumberTicker } from '../useNumberTicker';

describe('defaultTickerFormat', () => {
	it('rounds and groups whole numbers', () => {
		expect(defaultTickerFormat(1234)).toBe('1,234');
		expect(defaultTickerFormat(1234.6)).toBe('1,235');
		expect(defaultTickerFormat(0)).toBe('0');
		expect(defaultTickerFormat(-9876.4)).toBe('-9,876');
	});
});

describe('parseCssDurationMs', () => {
	it('parses ms and s token values', () => {
		expect(parseCssDurationMs('160ms', 0)).toBe(160);
		expect(parseCssDurationMs(' 240ms ', 0)).toBe(240);
		expect(parseCssDurationMs('.2s', 0)).toBe(200);
		expect(parseCssDurationMs('80', 0)).toBe(80);
	});

	it('falls back for unparsable values', () => {
		expect(parseCssDurationMs('', 160)).toBe(160);
		expect(parseCssDurationMs('spring', 160)).toBe(160);
		expect(parseCssDurationMs('NaNms', 160)).toBe(160);
	});
});

/** Deterministic frame scheduler: manual clock, frames run when told. */
function makeFrameHarness() {
	let time = 0;
	let nextId = 1;
	const pending = new Map<number, (time: number) => void>();
	return {
		now: () => time,
		requestFrame(cb: (time: number) => void): number {
			const id = nextId++;
			pending.set(id, cb);
			return id;
		},
		cancelFrame(id: number): void {
			pending.delete(id);
		},
		tick(ms: number): void {
			time += ms;
			const callbacks = [...pending.values()];
			pending.clear();
			for (const cb of callbacks) cb(time);
		},
		pendingCount: () => pending.size,
	};
}

describe('useNumberTicker', () => {
	it('renders the initial value immediately, formatted', () => {
		const harness = makeFrameHarness();
		const target = ref(1500);
		const { display } = useNumberTicker(() => target.value, {
			now: harness.now,
			requestFrame: harness.requestFrame,
			cancelFrame: harness.cancelFrame,
		});
		expect(display.value).toBe('1,500');
	});

	it('tweens toward a new value and settles exactly on it', async () => {
		const harness = makeFrameHarness();
		const target = ref(0);
		const { display } = useNumberTicker(() => target.value, {
			durationMs: () => 160,
			now: harness.now,
			requestFrame: harness.requestFrame,
			cancelFrame: harness.cancelFrame,
		});

		target.value = 1000;
		await nextTick();
		harness.tick(80); // halfway: eased past linear midpoint, not settled
		const midway = Number(display.value.replace(/,/g, ''));
		expect(midway).toBeGreaterThan(500);
		expect(midway).toBeLessThan(1000);

		harness.tick(80); // duration elapsed
		expect(display.value).toBe('1,000');
		expect(harness.pendingCount()).toBe(0);
	});

	it('snaps instantly under reduced motion — plain formatted text, no frames', async () => {
		const harness = makeFrameHarness();
		const target = ref(10);
		const { display } = useNumberTicker(() => target.value, {
			reducedMotion: () => true,
			now: harness.now,
			requestFrame: harness.requestFrame,
			cancelFrame: harness.cancelFrame,
		});

		target.value = 2400;
		await nextTick();
		expect(display.value).toBe('2,400');
		expect(harness.pendingCount()).toBe(0);
	});

	it('applies a custom formatter', async () => {
		const harness = makeFrameHarness();
		const target = ref(0.42);
		const { display } = useNumberTicker(() => target.value, {
			formatter: (n) => `${(n * 100).toFixed(0)}%`,
			reducedMotion: () => true,
			now: harness.now,
			requestFrame: harness.requestFrame,
			cancelFrame: harness.cancelFrame,
		});
		expect(display.value).toBe('42%');
		target.value = 0.9;
		await nextTick();
		expect(display.value).toBe('90%');
	});

	it('retargets mid-flight without leaving stray frames', async () => {
		const harness = makeFrameHarness();
		const target = ref(0);
		const { display } = useNumberTicker(() => target.value, {
			durationMs: () => 160,
			now: harness.now,
			requestFrame: harness.requestFrame,
			cancelFrame: harness.cancelFrame,
		});

		target.value = 1000;
		await nextTick();
		harness.tick(40);
		target.value = 200; // change course mid-animation
		await nextTick();
		harness.tick(160);
		harness.tick(160); // drain any settling frame
		expect(display.value).toBe('200');
		expect(harness.pendingCount()).toBe(0);
	});
});
