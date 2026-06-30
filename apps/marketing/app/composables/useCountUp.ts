import { ref } from 'vue';

export function useCountUp(end: number, opts: { duration?: number; decimals?: number } = {}) {
	const { duration = 1800, decimals = 0 } = opts;
	const display = ref(decimals > 0 ? (0).toFixed(decimals) : '0');
	let started = false;

	function start() {
		if (started) return;
		started = true;
		const t0 = performance.now();

		(function step(now: number) {
			const p = Math.min((now - t0) / duration, 1);
			const e = 1 - Math.pow(1 - p, 3);
			display.value = (end * e).toFixed(decimals);
			if (p < 1) requestAnimationFrame(step);
		})(performance.now());
	}

	return { display, start };
}
