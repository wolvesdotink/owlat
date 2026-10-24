/**
 * Waits for the browser's own signals instead of the clock: a test resumes
 * when the event it depends on has fired, never after a guessed delay.
 */

/** Resolves with the next `type` event on `target`. */
export function nextEvent(target: EventTarget, type: string): Promise<Event> {
	return new Promise((resolve) => target.addEventListener(type, resolve, { once: true }));
}

/**
 * Resolves once ResizeObserver has delivered the current size of `el`.
 *
 * Observers are notified in the order they were created, so by the time this
 * fresh observer sees `el`, every observer the code under test created earlier
 * has already been told about the same layout.
 */
export function nextResize(el: Element): Promise<void> {
	return new Promise((resolve) => {
		const observer = new ResizeObserver(() => {
			observer.disconnect();
			resolve();
		});
		observer.observe(el);
	});
}

/** Sets `el.scrollTop` and resolves after the browser has fired the resulting scroll event. */
export async function scrollTo(el: HTMLElement, top: number): Promise<void> {
	const scrolled = nextEvent(el, 'scroll');
	el.scrollTop = top;
	await scrolled;
}
