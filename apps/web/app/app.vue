<script setup lang="ts">
// Skip auth-dependent identity tracking on public pages (share, archive, etc.)
// to avoid unnecessary session/token requests for unauthenticated visitors.
if (!isPublicRoute()) {
	usePostHogIdentity();
}

/**
 * `<html lang>` follows the active locale.
 *
 * `nuxt.config`'s `app.head.htmlAttrs.lang` is deliberately unset — a value
 * there is baked into every page and would leave a German reader on a document
 * that still claims `lang="en"`, which is what a screen reader picks its voice
 * and its pronunciation rules from (WCAG 3.1.1). `useLocaleHead()` writes the
 * locale's BCP 47 tag (`de-DE`, not `de`) instead, and it is bound through a
 * `useHead` getter rather than spread once so the attribute is re-evaluated
 * when the language picker switches locales instead of freezing at first
 * render.
 *
 * Only `htmlAttrs` is taken: with `strategy: 'no_prefix'` every locale shares
 * one URL, so the `hreflang` alternates `useLocaleHead()` can also emit would
 * all point at the same page.
 */
const localeHead = useLocaleHead();

useHead(() => ({ htmlAttrs: localeHead.value.htmlAttrs }));
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
