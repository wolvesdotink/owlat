/**
 * Reading progress — tracks scroll position as a 0–1 ratio of the page content.
 */
export function useReadingProgress() {
	const progress = ref(0)

	function update() {
		const scrollHeight = document.documentElement.scrollHeight - window.innerHeight
		progress.value = scrollHeight > 0 ? Math.min(window.scrollY / scrollHeight, 1) : 0
	}

	onMounted(() => {
		window.addEventListener('scroll', update, { passive: true })
		update()
		onUnmounted(() => window.removeEventListener('scroll', update))
	})

	return { progress }
}
