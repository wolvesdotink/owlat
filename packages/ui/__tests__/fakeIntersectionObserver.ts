import { vi } from 'vitest';

/**
 * A controllable IntersectionObserver for the looping-animation tests: records
 * what it observes and delivers entries only when a test calls `report`, so
 * "on screen" and "off screen" are driven by hand instead of by a layout that
 * happy-dom does not have.
 */
export class FakeIntersectionObserver {
	static instances: FakeIntersectionObserver[] = [];
	readonly observed = new Set<Element>();
	disconnected = false;

	constructor(private readonly callback: IntersectionObserverCallback) {
		FakeIntersectionObserver.instances.push(this);
	}

	observe(element: Element): void {
		this.observed.add(element);
	}

	unobserve(element: Element): void {
		this.observed.delete(element);
	}

	disconnect(): void {
		this.disconnected = true;
		this.observed.clear();
	}

	/** Deliver an entry the way the browser would, for any element. */
	report(element: Element, isIntersecting: boolean): void {
		const entry = { target: element, isIntersecting } as IntersectionObserverEntry;
		this.callback([entry], this as unknown as IntersectionObserver);
	}

	/** The live observer (the shared controller keeps at most one). */
	static current(): FakeIntersectionObserver {
		const live = FakeIntersectionObserver.instances.filter((o) => !o.disconnected);
		if (live.length !== 1) throw new Error(`expected one live observer, found ${live.length}`);
		return live[0]!;
	}
}

export function installFakeIntersectionObserver(): void {
	FakeIntersectionObserver.instances = [];
	vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
}
