<script setup lang="ts">
useSeoMeta({
	title: 'Hosted Cloud Waitlist — Owlat',
	ogTitle: 'Hosted Cloud Waitlist — Owlat',
	description: 'Be first in line when Owlat Cloud launches. Until then, self-hosting is free and fully supported.',
	robots: 'noindex',
});

const config = useRuntimeConfig();
const waitlistEndpoint = (config.public.waitlistEndpoint as string) || '';

type FormState = 'idle' | 'submitting' | 'success' | 'error';

const state = ref<FormState>('idle');
const email = ref('');
const name = ref('');
const company = ref('');
const volume = ref('');
const errorMessage = ref('');

const volumeOptions = [
	{ value: '', label: 'Rough monthly send volume' },
	{ value: '<10k', label: 'Under 10,000 / month' },
	{ value: '10k-100k', label: '10,000 – 100,000 / month' },
	{ value: '100k-1m', label: '100,000 – 1,000,000 / month' },
	{ value: '>1m', label: 'Over 1,000,000 / month' },
];

async function submit(e: Event) {
	e.preventDefault();
	if (state.value === 'submitting') return;

	// Minimal client-side validation
	const emailTrimmed = email.value.trim();
	if (!emailTrimmed || !emailTrimmed.includes('@')) {
		state.value = 'error';
		errorMessage.value = 'Please enter a valid email address.';
		return;
	}

	state.value = 'submitting';
	errorMessage.value = '';

	const payload = {
		email: emailTrimmed,
		name: name.value.trim(),
		company: company.value.trim(),
		volume: volume.value,
		source: 'marketing/waitlist',
		submittedAt: new Date().toISOString(),
	};

	// If no endpoint configured (e.g. during static generation), show optimistic success.
	// Real deployment sets NUXT_PUBLIC_WAITLIST_ENDPOINT to the nest-api HTTP route.
	if (!waitlistEndpoint) {
		// eslint-disable-next-line no-console
		console.info('[waitlist] No endpoint configured; would submit:', payload);
		state.value = 'success';
		return;
	}

	try {
		const res = await fetch(waitlistEndpoint, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
		});
		if (!res.ok) {
			throw new Error(`Waitlist signup failed (HTTP ${res.status})`);
		}
		state.value = 'success';
	} catch (err) {
		state.value = 'error';
		errorMessage.value = err instanceof Error ? err.message : 'Something went wrong.';
	}
}
</script>

<template>
	<section class="relative min-h-[100dvh] flex items-center overflow-hidden py-32 max-md:py-20 px-8 max-md:px-6">
		<div class="relative w-full max-w-[560px] mx-auto">
			<!-- Eyebrow -->
			<span class="font-mono text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-brand mb-4 block">
				Hosted Cloud · Coming soon
			</span>

			<h1 class="font-display text-[clamp(2.2rem,4.5vw,3.25rem)] leading-[1.1] tracking-[-0.02em] text-text-primary mb-5">
				Be first when Owlat Cloud opens.
			</h1>

			<p class="text-[1.0625rem] text-text-secondary leading-[1.65] mb-8">
				We're polishing the managed version. Leave your email and we'll let you know when it's ready. In the meantime —
				<a href="https://docs.owlat.app/developer/self-hosting" class="text-brand hover:underline">self-hosting is free and fully supported</a>.
			</p>

			<!-- Form / Success states -->
			<template v-if="state !== 'success'">
				<form class="space-y-4" @submit="submit">
					<div>
						<label for="wl-email" class="block text-[0.8125rem] font-medium text-text-primary mb-1.5">Email <span class="text-brand">*</span></label>
						<input
							id="wl-email"
							v-model="email"
							type="email"
							required
							autocomplete="email"
							placeholder="you@company.com"
							class="w-full rounded-xl border border-border-default bg-bg-elevated px-4 py-2.5 text-[0.9375rem] text-text-primary placeholder-text-disabled focus:outline-none focus:border-brand focus:ring-1 focus:ring-brand transition-colors"
						>
					</div>

					<div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
						<div>
							<label for="wl-name" class="block text-[0.8125rem] font-medium text-text-primary mb-1.5">Name</label>
							<input
								id="wl-name"
								v-model="name"
								type="text"
								autocomplete="name"
								class="w-full rounded-xl border border-border-default bg-bg-elevated px-4 py-2.5 text-[0.9375rem] text-text-primary placeholder-text-disabled focus:outline-none focus:border-brand focus:ring-1 focus:ring-brand transition-colors"
							>
						</div>

						<div>
							<label for="wl-company" class="block text-[0.8125rem] font-medium text-text-primary mb-1.5">Company</label>
							<input
								id="wl-company"
								v-model="company"
								type="text"
								autocomplete="organization"
								class="w-full rounded-xl border border-border-default bg-bg-elevated px-4 py-2.5 text-[0.9375rem] text-text-primary placeholder-text-disabled focus:outline-none focus:border-brand focus:ring-1 focus:ring-brand transition-colors"
							>
						</div>
					</div>

					<div>
						<label for="wl-volume" class="block text-[0.8125rem] font-medium text-text-primary mb-1.5">Expected volume</label>
						<select
							id="wl-volume"
							v-model="volume"
							class="w-full rounded-xl border border-border-default bg-bg-elevated px-4 py-2.5 text-[0.9375rem] text-text-primary focus:outline-none focus:border-brand focus:ring-1 focus:ring-brand transition-colors"
						>
							<option v-for="opt in volumeOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
						</select>
					</div>

					<div v-if="state === 'error'" class="rounded-lg border border-error/40 bg-error/5 px-4 py-3 text-[0.8125rem] text-error">
						{{ errorMessage }}
					</div>

					<button
						type="submit"
						:disabled="state === 'submitting'"
						class="group w-full inline-flex items-center justify-center gap-2.5 px-7 py-3 text-[0.9375rem] font-semibold text-text-inverse bg-brand border border-brand rounded-xl transition-all duration-(--motion-moderate) hover:bg-brand-hover hover:border-brand-hover hover:shadow-brand-hover disabled:opacity-60 disabled:cursor-not-allowed btn-press"
					>
						<span>{{ state === 'submitting' ? 'Submitting…' : 'Join waitlist' }}</span>
						<svg
							v-if="state !== 'submitting'"
							class="transition-transform duration-(--motion-moderate) group-hover:translate-x-[3px]"
							width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"
						>
							<path d="M5 12h14" /><path d="m12 5 7 7-7 7" />
						</svg>
					</button>

					<p class="text-[0.75rem] text-text-tertiary text-center mt-2">
						We'll email you only when there's news about Owlat Cloud. No spam.
					</p>
				</form>
			</template>

			<!-- Success state -->
			<template v-else>
				<div class="rounded-2xl border border-success/30 bg-success/5 p-7 text-center">
					<svg class="mx-auto w-10 h-10 text-success mb-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
						<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
						<path d="m9 11 3 3L22 4" />
					</svg>
					<h2 class="font-display text-2xl text-text-primary mb-2">You're on the list.</h2>
					<p class="text-[0.9375rem] text-text-secondary leading-relaxed mb-6">
						We'll reach out as soon as Owlat Cloud is ready.
						Until then, <a href="https://docs.owlat.app/developer/self-hosting" class="text-brand hover:underline">self-hosting takes about 10 minutes</a>.
					</p>
					<a
						href="/"
						class="inline-flex items-center gap-2 px-5 py-2.5 text-[0.8125rem] font-medium text-text-primary bg-transparent border border-border-default rounded-xl no-underline transition-all duration-(--motion-moderate) hover:border-text-tertiary hover:text-brand btn-press"
					>
						← Back to owlat.app
					</a>
				</div>
			</template>
		</div>
	</section>
</template>
