<script setup lang="ts">
// Skip auth-dependent identity tracking on public pages (share, archive, etc.)
// to avoid unnecessary session/token requests for unauthenticated visitors.
if (!isPublicRoute()) {
	usePostHogIdentity();
}
</script>

<template>
	<div>
		<!-- Route-progress indicator: a slow, Convex-backed page keeps its old
		     content on screen (page transition mode: out-in) while this brand bar
		     signals the navigation is in flight — so a delayed route never reads
		     as a frozen or blank pane. Throttled so instant navigations don't
		     flash it. -->
		<NuxtLoadingIndicator color="var(--color-brand)" :height="2" />

		<NuxtLayout>
			<NuxtPage />
		</NuxtLayout>

		<!-- Global toast notifications (client-only to avoid SSR hydration mismatch) -->
		<ClientOnly>
			<UiToast />
		</ClientOnly>
	</div>
</template>
