/**
 * Mouse-tracking spotlight — sets --mouse-x / --mouse-y CSS custom properties
 * on the target element for radial-gradient spotlight effects.
 */
export function useSpotlight() {
	function onMouseMove(e: MouseEvent) {
		const el = e.currentTarget as HTMLElement
		const rect = el.getBoundingClientRect()
		el.style.setProperty('--mouse-x', `${e.clientX - rect.left}px`)
		el.style.setProperty('--mouse-y', `${e.clientY - rect.top}px`)
	}

	return { onMouseMove }
}
