<script setup lang="ts">
// Reads build-time version metadata injected into runtimeConfig.public.
// Populated by CI via Dockerfile ARGs → ENV; local dev builds show "dev".
const config = useRuntimeConfig();

const version = computed(() => (config.public.owlatVersion as string) || 'dev');
const gitSha = computed(() => (config.public.owlatGitSha as string) || 'unknown');
const buildDate = computed(() => (config.public.owlatBuildDate as string) || 'unknown');

const formattedBuildDate = computed(() => {
	const raw = buildDate.value;
	if (!raw || raw === 'unknown') return raw;
	try {
		const d = new Date(raw);
		if (isNaN(d.getTime())) return raw;
		return d.toLocaleString(undefined, {
			year: 'numeric',
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
		});
	} catch {
		return raw;
	}
});

const shortSha = computed(() => {
	const s = gitSha.value;
	if (!s || s === 'unknown') return s;
	return s.slice(0, 7);
});

const isDevBuild = computed(() => version.value === 'dev' || version.value === 'unknown');
</script>

<template>
	<div class="rounded-xl border border-border-default bg-bg-elevated p-6">
		<div class="flex items-start justify-between gap-6 flex-wrap">
			<div class="min-w-0">
				<h3 class="text-sm font-medium text-text-tertiary uppercase tracking-wider mb-2">Current version</h3>
				<div class="flex items-baseline gap-3 flex-wrap">
					<span class="font-display text-3xl font-semibold text-text-primary tracking-tight">
						{{ version }}
					</span>
					<span
						v-if="isDevBuild"
						class="text-[0.6875rem] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-warning/10 text-warning"
					>
						Dev build
					</span>
				</div>
			</div>

			<dl class="grid grid-cols-2 gap-x-6 gap-y-2 text-[0.8125rem] min-w-[260px]">
				<dt class="text-text-tertiary">Git SHA</dt>
				<dd class="text-text-primary font-mono">{{ shortSha }}</dd>

				<dt class="text-text-tertiary">Built</dt>
				<dd class="text-text-primary">{{ formattedBuildDate }}</dd>
			</dl>
		</div>
	</div>
</template>
