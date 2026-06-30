<script setup lang="ts">
useHead({ title: 'Shared Preview — Owlat' });

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
			? `${shareData.value.subject} — ${shareData.value.organizationName}`
			: 'Shared Preview',
	ogTitle: () => shareData.value?.subject ?? 'Shared Preview',
	ogDescription: () =>
		shareData.value ? `Email preview from ${shareData.value.organizationName}` : undefined,
});

onMounted(async () => {
	if (!token.value) {
		error.value = 'Missing share token. Please use the link you were given.';
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
			error.value = 'This share link is invalid or has been revoked.';
		}
	} catch (err) {
		// eslint-disable-next-line no-console
		console.error('[SharePage] Failed to fetch preview:', err);
		error.value = 'Unable to load the preview. Please try again later.';
	} finally {
		isLoading.value = false;
	}
});
</script>

<template>
	<div class="min-h-screen bg-gray-50">
		<!-- Loading State -->
		<div v-if="isLoading" class="flex items-center justify-center min-h-screen">
			<div class="flex flex-col items-center gap-4">
				<div class="w-8 h-8 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
				<p class="text-gray-500 text-sm">Loading preview...</p>
			</div>
		</div>

		<!-- Expired State -->
		<div v-else-if="isExpired" class="flex items-center justify-center min-h-screen px-4">
			<div class="text-center max-w-md">
				<div class="w-16 h-16 mx-auto mb-4 rounded-full bg-gray-100 flex items-center justify-center">
					<svg xmlns="http://www.w3.org/2000/svg" class="h-8 w-8 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
					</svg>
				</div>
				<h2 class="text-lg font-semibold text-gray-900 mb-2">Preview Link Expired</h2>
				<p class="text-gray-500">This preview link has expired. Please ask the sender for a new link.</p>
			</div>
		</div>

		<!-- Error State -->
		<div v-else-if="error" class="flex items-center justify-center min-h-screen px-4">
			<div class="text-center max-w-md">
				<div class="w-16 h-16 mx-auto mb-4 rounded-full bg-red-50 flex items-center justify-center">
					<svg xmlns="http://www.w3.org/2000/svg" class="h-8 w-8 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
					</svg>
				</div>
				<h2 class="text-lg font-semibold text-gray-900 mb-2">Preview Not Available</h2>
				<p class="text-gray-500">{{ error }}</p>
			</div>
		</div>

		<!-- Preview Content -->
		<div v-else-if="shareData">
			<!-- Header -->
			<div class="bg-white border-b border-gray-200">
				<div class="max-w-3xl mx-auto px-4 py-4">
					<h1 class="text-lg font-semibold text-gray-900">{{ shareData.subject }}</h1>
					<p class="text-sm text-gray-500 mt-1">
						{{ shareData.organizationName }}
						<span v-if="hoursRemaining > 0" class="ml-2 inline-flex items-center gap-1 text-xs text-gray-400">
							<svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
							</svg>
							Expires in {{ hoursRemaining }}h
						</span>
					</p>
				</div>
			</div>

			<!-- Email Content in sandboxed iframe -->
			<div class="max-w-3xl mx-auto my-6 px-4">
				<div class="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
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
						class="w-full border-0"
						style="min-height: 600px"
						@load="($event.target as HTMLIFrameElement).style.height = (($event.target as HTMLIFrameElement).contentDocument?.documentElement?.scrollHeight ?? 600) + 'px'"
					/>
				</div>
			</div>

			<!-- Footer -->
			<div class="text-center py-6 text-gray-400 text-sm">
				Powered by <span class="font-semibold">Owlat</span>
			</div>
		</div>
	</div>
</template>
