<script setup lang="ts">
// Skip auth-dependent identity tracking on public pages (share, archive, etc.)
// to avoid unnecessary session/token requests for unauthenticated visitors.
if (!isPublicRoute()) {
	usePostHogIdentity();
}
</script>

<template>
	<div>
		<NuxtLayout>
			<NuxtPage />
		</NuxtLayout>

		<!-- Global toast notifications (client-only to avoid SSR hydration mismatch) -->
		<ClientOnly>
			<UiToast />
		</ClientOnly>
	</div>
</template>
