import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	MOTION_DURATION,
	MOTION_EASE,
	MOTION_VARS,
	motionDuration,
	prefersReducedMotion,
	startReaderViewTransition,
} from '../postboxMotion';

function mockMatchMedia(reduced: boolean) {
	const impl = vi.fn().mockImplementation((query: string) => ({
		matches: reduced && query.includes('reduce'),
		media: query,
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
	}));
	vi.stubGlobal('matchMedia', impl);
	// window.matchMedia is what the helper reads.
	Object.defineProperty(window, 'matchMedia', { value: impl, configurable: true });
	return impl;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('motion tokens', () => {
	it('exposes the one vocabulary: 160ms fast / 220ms panel + the standard ease', () => {
		expect(MOTION_DURATION.fast).toBe(160);
		expect(MOTION_DURATION.panel).toBe(220);
		expect(MOTION_EASE).toBe('cubic-bezier(0.2, 0, 0, 1)');
	});

	it('names the CSS custom properties the stylesheet reads', () => {
		expect(MOTION_VARS).toEqual({
			fast: '--pbx-motion-fast',
			panel: '--pbx-motion-panel',
			ease: '--pbx-motion-ease',
		});
	});
});

describe('prefersReducedMotion', () => {
	it('returns true when the reduce query matches', () => {
		mockMatchMedia(true);
		expect(prefersReducedMotion()).toBe(true);
	});

	it('returns false when the reduce query does not match', () => {
		mockMatchMedia(false);
		expect(prefersReducedMotion()).toBe(false);
	});

	it('is SSR-safe: returns false when matchMedia is unavailable', () => {
		Object.defineProperty(window, 'matchMedia', { value: undefined, configurable: true });
		expect(prefersReducedMotion()).toBe(false);
	});

	it('fails soft to false when matchMedia throws', () => {
		const impl = vi.fn(() => {
			throw new Error('boom');
		});
		Object.defineProperty(window, 'matchMedia', { value: impl, configurable: true });
		expect(prefersReducedMotion()).toBe(false);
	});
});

describe('motionDuration', () => {
	it('returns the token duration when motion is allowed', () => {
		expect(motionDuration('fast', false)).toBe(160);
		expect(motionDuration('panel', false)).toBe(220);
	});

	it('collapses to 0 when reduced motion is preferred', () => {
		expect(motionDuration('fast', true)).toBe(0);
		expect(motionDuration('panel', true)).toBe(0);
	});

	it('reads the live media query when reduced is not passed', () => {
		mockMatchMedia(true);
		expect(motionDuration('fast')).toBe(0);
	});
});

describe('startReaderViewTransition', () => {
	it('uses the View Transitions API when supported and motion is allowed', () => {
		const apply = vi.fn();
		const start = vi.fn((cb: () => void) => {
			cb();
			return {};
		});
		(document as unknown as { startViewTransition: unknown }).startViewTransition = start;
		try {
			startReaderViewTransition(apply, false);
			expect(start).toHaveBeenCalledTimes(1);
			expect(apply).toHaveBeenCalledTimes(1);
		} finally {
			delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
		}
	});

	it('falls back to a direct apply under reduced motion (no view transition)', () => {
		const apply = vi.fn();
		const start = vi.fn();
		(document as unknown as { startViewTransition: unknown }).startViewTransition = start;
		try {
			startReaderViewTransition(apply, true);
			expect(start).not.toHaveBeenCalled();
			expect(apply).toHaveBeenCalledTimes(1);
		} finally {
			delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
		}
	});

	it('falls back to a direct apply when the API is absent', () => {
		const apply = vi.fn();
		expect(
			(document as unknown as { startViewTransition?: unknown }).startViewTransition,
		).toBeUndefined();
		startReaderViewTransition(apply, false);
		expect(apply).toHaveBeenCalledTimes(1);
	});

	it('still applies when startViewTransition throws', () => {
		const apply = vi.fn();
		(document as unknown as { startViewTransition: unknown }).startViewTransition = () => {
			throw new Error('boom');
		};
		try {
			startReaderViewTransition(apply, false);
			expect(apply).toHaveBeenCalledTimes(1);
		} finally {
			delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
		}
	});
});
