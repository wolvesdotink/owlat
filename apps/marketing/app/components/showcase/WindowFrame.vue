<script setup lang="ts">
/* Browser-window chrome shared by the showcase frames. Each frame is
 * self-contained: to swap a mock for a real product capture later, replace the
 * frame's slot content with an <img> — the section layout stays untouched. */
defineProps<{
	url: string;
}>();
</script>

<template>
	<div
		class="rounded-2xl border border-border-subtle bg-surface-3 shadow-(--shadow-5) overflow-hidden"
	>
		<!-- Chrome bar -->
		<div
			class="relative flex items-center px-3.5 py-2.5 border-b border-border-subtle bg-surface-1"
		>
			<span class="flex items-center gap-1.5">
				<span v-for="i in 3" :key="i" class="w-2 h-2 rounded-full bg-border-strong" />
			</span>
			<span
				class="absolute left-1/2 -translate-x-1/2 inline-flex items-center gap-1.5 rounded-full border border-border-subtle bg-surface-3 px-3 py-0.5 font-mono text-[9px] text-text-tertiary"
			>
				<svg
					width="8"
					height="8"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2.5"
					stroke-linecap="round"
					stroke-linejoin="round"
				>
					<rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
					<path d="M7 11V7a5 5 0 0 1 10 0v4" />
				</svg>
				{{ url }}
			</span>
		</div>
		<slot />
	</div>
</template>
