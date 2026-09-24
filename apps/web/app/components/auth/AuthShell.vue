<script setup lang="ts">
import WorkspaceLogo from '~/components/workspace/WorkspaceLogo.vue';

/**
 * Shared hero shell for the auth screens: the marketing site's background
 * field (hairline grid + grain + aurora) behind a hairline card, with the
 * serif display accent available in the heading via the #title slot. Keeps
 * login / register / forgot / reset visually in lockstep with the landing
 * pages while each page keeps its own form logic.
 */
defineProps<{
	/** Optional line under the heading. */
	subtitle?: string;
}>();

// The workspace's own logo takes the Owlat mark's place when an admin has
// uploaded one (#810): these pages are the workspace's door, not Owlat's.
const { logo } = useRecipientSender();
</script>

<template>
	<div
		class="relative isolate flex min-h-screen flex-col items-center justify-center overflow-hidden bg-bg-base px-4 py-16"
	>
		<!-- Decorative field — behind the content, ignores the pointer, hidden from AT. -->
		<UiHeroField />

		<div class="relative w-full max-w-md">
			<div class="lp-hero-in mb-8 text-center" style="--i: 0">
				<WorkspaceLogo v-if="logo" :url="logo.url" :dark-url="logo.darkUrl" class="mb-5" />
				<img v-else src="/owlat.svg" alt="" class="mx-auto mb-5 size-12 dark:invert" />
				<h1 class="text-3xl font-medium tracking-[-0.02em] text-text-primary">
					<slot name="title" />
				</h1>
				<p v-if="subtitle" class="mt-2 text-md leading-[1.65] text-text-secondary">
					{{ subtitle }}
				</p>
			</div>

			<div class="lp-card lp-hero-in p-8 max-sm:p-6" style="--i: 1">
				<slot />
			</div>

			<div
				v-if="$slots['footer']"
				class="lp-hero-in mt-6 text-center text-sm text-text-secondary"
				style="--i: 2"
			>
				<slot name="footer" />
			</div>
		</div>
	</div>
</template>
