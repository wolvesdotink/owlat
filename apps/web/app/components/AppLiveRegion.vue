<script setup lang="ts">
/**
 * The app's single pair of ARIA live regions, mounted once by the dashboard
 * layout and written to through `useAnnounce()`.
 *
 * Once, and here, on purpose. A live region only works if it is in the document
 * BEFORE the text lands in it — a region mounted together with its message is
 * usually silent — so these two are always present and always empty until
 * something is said. Per-surface regions were the alternative and they are
 * worse: several regions announcing at once is unintelligible, and a region
 * inside a component that unmounts (a dialog, a toast) takes its message with
 * it before it is read.
 *
 * Toast notifications keep their OWN regions (`packages/ui/components/ui/Toast`)
 * because their text is visible and their timing is theirs.
 */
const { politeMessage, assertiveMessage } = useAnnounce();
</script>

<template>
	<!-- `aria-atomic` so a message is read whole rather than as the diff against
	     the one before it; `sr-only` rather than `hidden`, because a region that
	     is `display:none` is not in the accessibility tree and is never read. -->
	<div class="sr-only">
		<div role="status" aria-live="polite" aria-atomic="true">{{ politeMessage }}</div>
		<div role="alert" aria-live="assertive" aria-atomic="true">{{ assertiveMessage }}</div>
	</div>
</template>
