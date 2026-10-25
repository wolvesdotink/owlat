import { onReducedMotionChange, prefersReducedMotion } from '../composables/useReducedMotion';

/**
 * Run a looping decoration only while someone can see it.
 *
 * A skeleton shimmer, an indeterminate progress sweep or a presence halo loops
 * forever. Off-screen (a long list of placeholders below the fold), in a
 * background tab, or for someone who asked their OS for less motion, every one
 * of those frames is composited work nobody sees. One shared
 * IntersectionObserver watches every registered element and writes the answer
 * into a custom property the CSS reads:
 *
 *   animation-play-state: var(--ui-animation-state, paused);
 *
 * An element is `running` only while it intersects the viewport, the document
 * is visible and reduced motion is off (the OS preference or the app's own
 * override, read through the shared reduced-motion owner). The CSS fallback is `paused`, so an
 * element that is never registered (server render, before mount) holds its
 * first frame instead of animating unobserved.
 *
 * The observer, the visibility listener and the reduced-motion listener exist only
 * while at least one element is registered; the last unregister tears them down.
 */

export const ANIMATION_STATE_PROPERTY = '--ui-animation-state';

type AnimationState = 'running' | 'paused';

interface Registration {
	readonly element: Element & ElementCSSInlineStyle;
	intersecting: boolean;
}

const registrations = new Map<Element, Registration>();
let listening = false;
let observer: IntersectionObserver | null = null;
let stopReducedMotion: (() => void) | null = null;

function setState(element: ElementCSSInlineStyle, state: AnimationState): void {
	element.style.setProperty(ANIMATION_STATE_PROPERTY, state);
}

function documentVisible(): boolean {
	return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

function update(registration: Registration): void {
	const running = registration.intersecting && documentVisible() && !prefersReducedMotion();
	setState(registration.element, running ? 'running' : 'paused');
}

function updateAll(): void {
	for (const registration of registrations.values()) update(registration);
}

function start(): void {
	listening = true;
	stopReducedMotion = onReducedMotionChange(updateAll);
	document.addEventListener('visibilitychange', updateAll);
	if (typeof IntersectionObserver === 'undefined') return;
	const created: IntersectionObserver = new IntersectionObserver((entries) => {
		// A callback queued before the last unregister tore this observer down
		// must not write into elements a newer observer now owns.
		if (created !== observer) return;
		for (const entry of entries) {
			const registration = registrations.get(entry.target);
			if (!registration) continue;
			registration.intersecting = entry.isIntersecting;
			update(registration);
		}
	});
	observer = created;
}

function stop(): void {
	listening = false;
	observer?.disconnect();
	observer = null;
	stopReducedMotion?.();
	stopReducedMotion = null;
	document.removeEventListener('visibilitychange', updateAll);
}

/**
 * Register a looping animation's host element. The host must stay put while the
 * animation runs (a track, not the sweep moving across it): a moving element
 * leaves the viewport mid-cycle and would pause itself out of sight. Animated
 * descendants inherit the state through the custom property.
 *
 * Returns the unregister function;
 * calling it more than once, or after the element was registered again, is a
 * no-op for the stale registration.
 *
 * Without IntersectionObserver (an old webview) visibility is unknowable, so the
 * element counts as on-screen and keeps today's always-on loop; the document
 * visibility and reduced-motion checks still apply.
 */
export function observeVisibleAnimation(element: Element & ElementCSSInlineStyle): () => void {
	if (typeof document === 'undefined') return () => {};

	if (!listening) start();

	const registration: Registration = { element, intersecting: observer === null };
	if (registrations.has(element)) observer?.unobserve(element);
	registrations.set(element, registration);
	update(registration);
	observer?.observe(element);

	return () => {
		if (registrations.get(element) !== registration) return;
		registrations.delete(element);
		observer?.unobserve(element);
		setState(element, 'paused');
		if (registrations.size === 0) stop();
	};
}
