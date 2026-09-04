<script setup lang="ts">
const { t } = useI18n();

useHead({ title: () => t('recipient.share.pageTitle') });

definePageMeta({
	layout: false,
});

const route = useRoute();
const config = useRuntimeConfig();

const isLoading = ref(true);
const error = ref<string | null>(null);
const isExpired = ref(false);
const shareData = ref<{
	html: string;
	subject: string;
	previewText?: string;
	organizationName: string;
	expiresAt: number;
} | null>(null);

const token = computed(() => route.query['token'] as string | undefined);

// Countdown: hours remaining
const hoursRemaining = computed(() => {
	if (!shareData.value?.expiresAt) return 0;
	const ms = shareData.value.expiresAt - Date.now();
	return Math.max(0, Math.ceil(ms / (1000 * 60 * 60)));
});

// SEO
useSeoMeta({
	title: () =>
		shareData.value
			? t('recipient.share.seoTitleLoaded', {
					subject: shareData.value.subject,
					organization: shareData.value.organizationName,
				})
			: t('recipient.share.seoTitle'),
	ogTitle: () => shareData.value?.subject ?? t('recipient.share.seoTitle'),
	ogDescription: () =>
		shareData.value
			? t('recipient.share.ogDescription', { organization: shareData.value.organizationName })
			: undefined,
});

onMounted(async () => {
	if (!token.value) {
		error.value = t('recipient.share.errors.missingToken');
		isLoading.value = false;
		return;
	}

	try {
		const shareUrl = `${config.public.convexSiteUrl}/share/${encodeURIComponent(token.value)}`;
		const response = await fetch(shareUrl);
		// The endpoint returns 404 (not 410) for an expired link with
		// `reason: 'expired'` in the error envelope — read the body to tell an
		// expired link apart from a genuinely invalid/revoked one.
		const body = await response.json().catch(() => null);
		const result = interpretShareResponse(response.ok, body);

		if (result.kind === 'expired') {
			isExpired.value = true;
		} else if (result.kind === 'ok') {
			shareData.value = result.data;
		} else {
			error.value = t('recipient.share.errors.revoked');
		}
	} catch (err) {
		console.error('[SharePage] Failed to fetch preview:', err);
		error.value = t('recipient.share.errors.loadFailed');
	} finally {
		isLoading.value = false;
	}
});
</script>

<template>
	<div class="min-h-dvh bg-bg-deep text-text-primary">
		<!-- Loading State -->
		<div v-if="isLoading" class="flex min-h-dvh items-center justify-center px-5">
			<div class="flex flex-col items-center gap-4">
				<UiSpinner size="lg" tone="brand" />
				<p class="text-sm text-text-secondary">{{ t('recipient.share.loading') }}</p>
			</div>
		</div>

		<!-- Expired State -->
		<div v-else-if="isExpired" class="flex min-h-dvh items-center justify-center px-5">
			<div class="w-full max-w-md text-center">
				<div
					class="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-bg-surface sm:h-16 sm:w-16"
				>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						class="h-7 w-7 text-text-tertiary sm:h-8 sm:w-8"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
						/>
					</svg>
				</div>
				<h2 class="mb-2 text-lg font-semibold text-text-primary">
					{{ t('recipient.share.expiredHeading') }}
				</h2>
				<p class="text-text-secondary">{{ t('recipient.share.expiredBody') }}</p>
			</div>
		</div>

		<!-- Error State -->
		<div v-else-if="error" class="flex min-h-dvh items-center justify-center px-5">
			<div class="w-full max-w-md text-center">
				<div
					class="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-error-subtle sm:h-16 sm:w-16"
				>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						class="h-7 w-7 text-error sm:h-8 sm:w-8"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
						/>
					</svg>
				</div>
				<h2 class="mb-2 text-lg font-semibold text-text-primary">
					{{ t('recipient.share.errorHeading') }}
				</h2>
				<p class="text-text-secondary">{{ error }}</p>
			</div>
		</div>

		<!-- Preview Content -->
		<div v-else-if="shareData">
			<!-- Header -->
			<header class="border-b border-border-subtle bg-bg-elevated pt-[env(safe-area-inset-top)]">
				<div class="mx-auto max-w-3xl px-5 py-4">
					<h1 class="text-lg font-medium tracking-[-0.02em] break-words text-text-primary">
						{{ shareData.subject }}
					</h1>
					<p class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text-secondary">
						<span class="break-words">{{ shareData.organizationName }}</span>
						<span
							v-if="hoursRemaining > 0"
							class="inline-flex items-center gap-1 text-xs text-text-tertiary"
						>
							<svg
								xmlns="http://www.w3.org/2000/svg"
								class="h-3 w-3 shrink-0"
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width="2"
									d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
								/>
							</svg>
							{{ t('recipient.share.expiresIn', { hours: hoursRemaining }) }}
						</span>
					</p>
				</div>
			</header>

			<!-- Email Content in sandboxed iframe -->
			<div class="mx-auto my-5 max-w-3xl px-5 sm:my-8">
				<div class="overflow-hidden rounded-(--radius-card) shadow-surface-2">
					<!--
						The email was authored for a light canvas, so the paper stays
						light in BOTH color schemes: `light` re-resolves the token layer
						for this subtree (see packages/ui/assets/css/light.css) and
						`scheme-only-light` keeps the framed document from picking up the
						recipient's dark preference. Inverting it would leave dark-on-dark
						email text unreadable.
					-->
					<div class="light bg-surface-3">
						<!--
							`allow-same-origin` is required so the @load handler can read
							contentDocument to size the frame to the email. NEVER add
							`allow-scripts`: same-origin + scripts lets the framed HTML
							escape the sandbox entirely. This frame renders untrusted
							email HTML, so it must stay script-free.
						-->
						<iframe
							:srcdoc="shareData.html"
							sandbox="allow-same-origin"
							:title="t('recipient.share.frameTitle')"
							class="w-full border-0 scheme-only-light"
							style="min-height: 600px"
							@load="
								($event.target as HTMLIFrameElement).style.height =
									(($event.target as HTMLIFrameElement).contentDocument?.documentElement
										?.scrollHeight ?? 600) + 'px'
							"
						/>
					</div>
				</div>
			</div>

			<!-- Footer -->
			<I18nT
				keypath="common.poweredBy"
				tag="p"
				scope="global"
				class="pt-2 pb-[max(1.5rem,env(safe-area-inset-bottom))] text-center text-sm text-text-tertiary"
			>
				<template #brand><span class="font-display">Owlat</span></template>
			</I18nT>
		</div>
	</div>
</template>
