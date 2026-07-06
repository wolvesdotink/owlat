/**
 * Logic behind UiNumberTicker: animate a displayed number toward a changing
 * target over one moderate-tier beat, or snap instantly when the user prefers
 * reduced motion. Pure and injectable (time source, rAF, reduced-motion flag)
 * so it is testable without a browser.
 */
import { getCurrentInstance, onBeforeUnmount, ref, watch, type Ref } from 'vue';

/** Default display format: whole numbers with locale grouping (1,234). */
export function defaultTickerFormat(value: number): string {
	return Math.round(value).toLocaleString('en-US');
}

/**
 * Parse a CSS duration custom-property value ("160ms", ".24s") to
 * milliseconds. Returns the fallback for anything unparsable so a missing
 * token never breaks the ticker.
 */
export function parseCssDurationMs(raw: string, fallback: number): number {
	const match = /^(-?\d*\.?\d+)(ms|s)?$/.exec(raw.trim());
	if (!match) return fallback;
	const amount = Number(match[1]);
	if (!Number.isFinite(amount)) return fallback;
	return match[2] === 's' ? amount * 1000 : amount;
}

/** Same shape as --ease-spring: fast start, critically damped settle. */
function easeOutCubic(t: number): number {
	return 1 - (1 - t) ** 3;
}

export interface NumberTickerOptions {
	/** Format the in-flight value for display. Default: rounded + grouped. */
	formatter?: (value: number) => string;
	/** Tween duration in ms; the component feeds --motion-moderate here. */
	durationMs?: () => number;
	/** When true, value changes render instantly (no tween). */
	reducedMotion?: () => boolean;
	/** Injectable clock + frame scheduler for tests. */
	now?: () => number;
	requestFrame?: (cb: (time: number) => void) => number;
	cancelFrame?: (id: number) => void;
}

export function useNumberTicker(
	target: () => number,
	options: NumberTickerOptions = {}
): { display: Ref<string> } {
	const formatter = options.formatter ?? defaultTickerFormat;
	const durationMs = options.durationMs ?? (() => 160);
	const reducedMotion = options.reducedMotion ?? (() => false);
	const now = options.now ?? (() => performance.now());
	const requestFrame =
		options.requestFrame ??
		((cb: (time: number) => void) =>
			typeof requestAnimationFrame === 'function'
				? requestAnimationFrame(cb)
				: // SSR fallback: no frames — the watcher snap keeps output correct.
					0);
	const cancelFrame =
		options.cancelFrame ??
		((id: number) => {
			if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id);
		});

	let current = target();
	const display = ref(formatter(current));
	let frameId: number | null = null;

	function stop(): void {
		if (frameId !== null) {
			cancelFrame(frameId);
			frameId = null;
		}
	}

	function snapTo(value: number): void {
		stop();
		current = value;
		display.value = formatter(value);
	}

	function animateTo(value: number): void {
		stop();
		const from = current;
		const delta = value - from;
		const duration = durationMs();
		if (delta === 0 || duration <= 0) {
			snapTo(value);
			return;
		}
		const startedAt = now();
		const step = () => {
			const progress = Math.min(1, (now() - startedAt) / duration);
			current = from + delta * easeOutCubic(progress);
			display.value = formatter(current);
			if (progress < 1) {
				frameId = requestFrame(step);
			} else {
				frameId = null;
				current = value;
			}
		};
		frameId = requestFrame(step);
	}

	watch(target, (value) => {
		if (reducedMotion()) snapTo(value);
		else animateTo(value);
	});

	// Guarded so the composable is also usable (and testable) outside a
	// component setup context.
	if (getCurrentInstance()) onBeforeUnmount(stop);

	return { display };
}
