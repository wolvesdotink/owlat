/**
 * Scroll-reveal composable — triggers visibility class when element enters viewport.
 * Mirrors the marketing app's pattern for consistent behavior across the monorepo.
 */
export function useScrollReveal(threshold = 0.15) {
	const target = ref<HTMLElement | null>(null)
	const isVisible = ref(false)

	onMounted(() => {
		if (!target.value) return

		const observer = new IntersectionObserver(
			(entries) => {
				if (entries[0]?.isIntersecting) {
					isVisible.value = true
					observer.disconnect()
				}
			},
			{ threshold },
		)

		observer.observe(target.value)

		onUnmounted(() => observer.disconnect())
	})

	return { target, isVisible }
}
