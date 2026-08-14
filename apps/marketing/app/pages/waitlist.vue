<script setup lang="ts">
const { t } = useI18n();
const localePath = useLocalePath();

// Getters: `useSeoMeta` captures its options once, so a plain `t()` would pin
// the title to the locale that was active at setup.
useSeoMeta({
	title: () => t('seo.waitlist.title'),
	ogTitle: () => t('seo.waitlist.title'),
	description: () => t('seo.waitlist.description'),
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

// The submitted `value` is the machine-readable bucket and never changes with
// the locale; only its label is translated.
const volumeOptions = [
	{ value: '', labelKey: 'waitlist.volume.none' },
	{ value: '<10k', labelKey: 'waitlist.volume.under10k' },
	{ value: '10k-100k', labelKey: 'waitlist.volume.to100k' },
	{ value: '100k-1m', labelKey: 'waitlist.volume.to1m' },
	{ value: '>1m', labelKey: 'waitlist.volume.over1m' },
];

async function submit(e: Event) {
	e.preventDefault();
	if (state.value === 'submitting') return;

	// Minimal client-side validation
	const emailTrimmed = email.value.trim();
	if (!emailTrimmed || !emailTrimmed.includes('@')) {
		state.value = 'error';
		errorMessage.value = t('waitlist.errors.invalidEmail');
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
			throw new Error(t('waitlist.errors.requestFailed', { status: res.status }));
		}
		state.value = 'success';
	} catch (err) {
		state.value = 'error';
		errorMessage.value = err instanceof Error ? err.message : t('waitlist.errors.generic');
	}
}
</script>

<template>
	<section
		class="relative min-h-[100dvh] flex items-center overflow-hidden py-32 max-md:py-20 px-8 max-md:px-6"
	>
		<div class="relative w-full max-w-[560px] mx-auto">
			<!-- Eyebrow -->
			<span class="lp-eyebrow mb-4">{{ t('waitlist.eyebrow') }}</span>

			<I18nT
				keypath="waitlist.title"
				tag="h1"
				class="text-[clamp(2.2rem,4.5vw,3.25rem)] font-medium leading-[1.1] tracking-[-0.02em] text-text-primary mb-5"
				scope="global"
			>
				<template #accent>
					<span class="lp-title-accent">{{ t('waitlist.titleAccent') }}</span>
				</template>
			</I18nT>

			<I18nT
				keypath="waitlist.intro"
				tag="p"
				class="text-[1.0625rem] text-text-secondary leading-[1.65] mb-8"
				scope="global"
			>
				<template #link>
					<a href="https://docs.owlat.app/developer/self-hosting" class="text-brand hover:underline">
						{{ t('waitlist.introLink') }}
					</a>
				</template>
			</I18nT>

			<!-- Form / Success states -->
			<template v-if="state !== 'success'">
				<form class="lp-card p-8 max-sm:p-6 space-y-4" @submit="submit">
					<div>
						<label for="wl-email" class="block text-[0.8125rem] font-medium text-text-primary mb-1.5"
							>{{ t('waitlist.emailLabel') }} <span class="text-brand">*</span></label
						>
						<input
							id="wl-email"
							v-model="email"
							type="email"
							required
							autocomplete="email"
							:placeholder="t('waitlist.emailPlaceholder')"
							class="w-full rounded-xl border border-border-default bg-bg-elevated px-4 py-2.5 text-[0.9375rem] text-text-primary placeholder-text-disabled focus:outline-none focus:border-brand focus:ring-1 focus:ring-brand transition-colors"
						/>
					</div>

					<div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
						<div>
							<label
								for="wl-name"
								class="block text-[0.8125rem] font-medium text-text-primary mb-1.5"
								>{{ t('waitlist.nameLabel') }}</label
							>
							<input
								id="wl-name"
								v-model="name"
								type="text"
								autocomplete="name"
								class="w-full rounded-xl border border-border-default bg-bg-elevated px-4 py-2.5 text-[0.9375rem] text-text-primary placeholder-text-disabled focus:outline-none focus:border-brand focus:ring-1 focus:ring-brand transition-colors"
							/>
						</div>

						<div>
							<label
								for="wl-company"
								class="block text-[0.8125rem] font-medium text-text-primary mb-1.5"
								>{{ t('waitlist.companyLabel') }}</label
							>
							<input
								id="wl-company"
								v-model="company"
								type="text"
								autocomplete="organization"
								class="w-full rounded-xl border border-border-default bg-bg-elevated px-4 py-2.5 text-[0.9375rem] text-text-primary placeholder-text-disabled focus:outline-none focus:border-brand focus:ring-1 focus:ring-brand transition-colors"
							/>
						</div>
					</div>

					<div>
						<label
							for="wl-volume"
							class="block text-[0.8125rem] font-medium text-text-primary mb-1.5"
							>{{ t('waitlist.volumeLabel') }}</label
						>
						<select
							id="wl-volume"
							v-model="volume"
							class="w-full rounded-xl border border-border-default bg-bg-elevated px-4 py-2.5 text-[0.9375rem] text-text-primary focus:outline-none focus:border-brand focus:ring-1 focus:ring-brand transition-colors"
						>
							<option v-for="opt in volumeOptions" :key="opt.value" :value="opt.value">
								{{ t(opt.labelKey) }}
							</option>
						</select>
					</div>

					<div
						v-if="state === 'error'"
						class="rounded-lg border border-error/40 bg-error/5 px-4 py-3 text-[0.8125rem] text-error"
					>
						{{ errorMessage }}
					</div>

					<button
						type="submit"
						:disabled="state === 'submitting'"
						class="btn btn-primary group w-full px-7 text-md"
					>
						<span>{{
							state === 'submitting' ? t('waitlist.submitting') : t('waitlist.submit')
						}}</span>
						<svg
							v-if="state !== 'submitting'"
							class="transition-transform duration-(--motion-fast) group-hover:translate-x-[3px]"
							width="16"
							height="16"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2.5"
							stroke-linecap="round"
							stroke-linejoin="round"
						>
							<path d="M5 12h14" />
							<path d="m12 5 7 7-7 7" />
						</svg>
					</button>

					<p class="text-[0.75rem] text-text-tertiary text-center mt-2">
						{{ t('waitlist.disclaimer') }}
					</p>
				</form>
			</template>

			<!-- Success state -->
			<template v-else>
				<div class="lp-card p-8 text-center">
					<svg
						class="mx-auto w-10 h-10 text-success mb-4"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2.5"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
						<path d="m9 11 3 3L22 4" />
					</svg>
					<h2 class="font-display text-2xl text-text-primary mb-2">
						{{ t('waitlist.success.title') }}
					</h2>
					<I18nT
						keypath="waitlist.success.body"
						tag="p"
						class="text-[0.9375rem] text-text-secondary leading-relaxed mb-6"
						scope="global"
					>
						<template #link>
							<a
								href="https://docs.owlat.app/developer/self-hosting"
								class="text-brand hover:underline"
							>
								{{ t('waitlist.success.bodyLink') }}
							</a>
						</template>
					</I18nT>
					<a :href="localePath('/')" class="btn btn-hairline btn-sm no-underline">
						{{ t('waitlist.success.back') }}
					</a>
				</div>
			</template>
		</div>
	</section>
</template>
