<script setup lang="ts">
definePageMeta({ layout: false });
useHead({ title: 'Owlat — First-run setup' });

const router = useRouter();

const steps = [
	{ icon: 'lucide:sliders-horizontal', title: 'Operating mode', desc: 'Pick a starting point — IMAP-only, marketing, full suite…' },
	{ icon: 'lucide:toggle-right', title: 'Features', desc: 'Fine-tune which surfaces are active.' },
	{ icon: 'lucide:send', title: 'Email provider', desc: 'Owlat MTA, Resend, Amazon SES, or none.' },
	{ icon: 'lucide:user-round', title: 'Admin & review', desc: 'Create your account, then launch.' },
];

function start() {
	router.push('/setup/mode');
}
</script>

<template>
	<div class="min-h-screen bg-bg-base text-text-primary grid place-items-center px-6 py-12">
		<div class="w-full max-w-xl">
			<UiCard padding="lg">
				<div class="flex items-center gap-3 mb-6">
					<UiIconBox icon="lucide:feather" size="lg" variant="brand" rounded="2xl" />
					<span class="text-sm font-medium text-text-secondary tracking-wide uppercase">Owlat setup</span>
				</div>

				<h1 class="font-display text-4xl leading-tight mb-3">Welcome to Owlat.</h1>
				<p class="text-text-secondary leading-relaxed mb-6">
					A few choices and we'll boot the rest of your install. You can change everything later
					from <span class="font-mono text-sm text-text-primary">Settings → Features</span>.
				</p>

				<ol class="space-y-3 mb-8">
					<li v-for="(step, i) in steps" :key="step.title" class="flex items-start gap-3">
						<span
							class="flex items-center justify-center size-6 shrink-0 rounded-full bg-brand/15 text-brand text-xs font-semibold mt-0.5"
						>
							{{ i + 1 }}
						</span>
						<div>
							<div class="font-medium text-text-primary">{{ step.title }}</div>
							<div class="text-sm text-text-secondary">{{ step.desc }}</div>
						</div>
					</li>
				</ol>

				<UiButton size="lg" @click="start">
					Let's go
					<template #iconRight><Icon name="lucide:arrow-right" class="w-4 h-4 ml-2" /></template>
				</UiButton>

				<p class="mt-6 text-sm text-text-tertiary">
					AI providers, integrations, and your sending domain + DKIM are configured afterwards from
					<span class="font-mono text-text-secondary">Settings</span>.
				</p>
				<p class="mt-2 text-sm text-text-tertiary">
					Prefer the terminal?
					<code class="font-mono text-text-secondary bg-bg-surface rounded px-1.5 py-0.5">owlat setup --terminal</code>
				</p>
			</UiCard>
		</div>
	</div>
</template>
