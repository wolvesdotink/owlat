<script setup lang="ts">
useHead({ title: 'Campaign Archive — Owlat' });

definePageMeta({
	layout: false,
});

const route = useRoute();
const config = useRuntimeConfig();

const isLoading = ref(true);
const error = ref<string | null>(null);
const archiveData = ref<{
	html: string;
	subject: string;
	sentAt: number;
	organizationName: string;
} | null>(null);

const token = computed(() => route.query['token'] as string | undefined);

// Format sent date
const formattedDate = computed(() => {
	if (!archiveData.value?.sentAt) return '';
	return new Intl.DateTimeFormat('en-US', {
		month: 'long',
		day: 'numeric',
		year: 'numeric',
	}).format(new Date(archiveData.value.sentAt));
});

// SEO
useSeoMeta({
	title: () =>
		archiveData.value
			? `${archiveData.value.subject} — ${archiveData.value.organizationName}`
			: 'Campaign Archive',
	ogTitle: () => archiveData.value?.subject ?? 'Campaign Archive',
	ogDescription: () =>
		archiveData.value ? `Email from ${archiveData.value.organizationName}` : undefined,
});

onMounted(async () => {
	if (!token.value) {
		error.value = 'Missing archive token. Please use the link from your email.';
		isLoading.value = false;
		return;
	}

	try {
		const archiveUrl = `${config.public.convexSiteUrl}/archive/${encodeURIComponent(token.value)}`;
		const response = await fetch(archiveUrl);

		if (response.status === 404) {
			error.value = 'This archive link is invalid or the campaign is no longer available.';
			isLoading.value = false;
			return;
		}

		if (!response.ok) {
			throw new Error('Failed to load archive');
		}

		const body = await response.json();
		if (!body.ok) {
			throw new Error(body.error?.message || 'Failed to load archive');
		}
		archiveData.value = body.data;
	} catch (err) {
		error.value = 'Unable to load the campaign archive. Please try again later.';
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
				<UiSpinner size="lg" tone="brand" />
				<p class="text-gray-500 text-sm">Loading archive...</p>
			</div>
		</div>

		<!-- Error State -->
		<div v-else-if="error" class="flex items-center justify-center min-h-screen px-4">
			<div class="text-center max-w-md">
				<div class="w-16 h-16 mx-auto mb-4 rounded-full bg-red-50 flex items-center justify-center">
					<svg
						xmlns="http://www.w3.org/2000/svg"
						class="h-8 w-8 text-red-400"
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
				<h2 class="text-lg font-semibold text-gray-900 mb-2">Archive Not Available</h2>
				<p class="text-gray-500">{{ error }}</p>
			</div>
		</div>

		<!-- Archive Content -->
		<div v-else-if="archiveData">
			<!-- Header -->
			<div class="bg-white border-b border-gray-200">
				<div class="max-w-3xl mx-auto px-4 py-4">
					<h1 class="text-lg font-semibold text-gray-900">{{ archiveData.subject }}</h1>
					<p class="text-sm text-gray-500 mt-1">
						{{ archiveData.organizationName }}
						<span v-if="formattedDate"> &middot; {{ formattedDate }}</span>
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
						:srcdoc="archiveData.html"
						sandbox="allow-same-origin"
						class="w-full border-0"
						style="min-height: 600px"
						@load="
							($event.target as HTMLIFrameElement).style.height =
								(($event.target as HTMLIFrameElement).contentDocument?.documentElement
									?.scrollHeight ?? 600) + 'px'
						"
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
