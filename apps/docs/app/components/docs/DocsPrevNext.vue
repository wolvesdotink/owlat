<template>
	<div v-if="surround?.length" class="max-w-3xl mx-auto mt-12 pt-8 border-t border-border-subtle">
		<div class="grid grid-cols-2 gap-4">
			<!-- Previous -->
			<div>
				<NuxtLink
					v-if="prev"
					:to="prev.path"
					class="prev-next-card group flex flex-col gap-1.5 p-4 rounded-(--radius-card)"
				>
					<span class="text-xs uppercase tracking-widest text-text-tertiary"> Previous </span>
					<span
						class="text-sm text-text-secondary group-hover:text-text-primary transition-colors duration-(--motion-fast) flex items-center gap-1.5"
					>
						<svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="2"
								d="M15 19l-7-7 7-7"
							/>
						</svg>
						{{ prev.title }}
					</span>
				</NuxtLink>
			</div>

			<!-- Next -->
			<div class="text-right">
				<NuxtLink
					v-if="next"
					:to="next.path"
					class="prev-next-card group flex flex-col items-end gap-1.5 p-4 rounded-(--radius-card)"
				>
					<span class="text-xs uppercase tracking-widest text-text-tertiary"> Next </span>
					<span
						class="text-sm text-text-secondary group-hover:text-text-primary transition-colors duration-(--motion-fast) flex items-center gap-1.5"
					>
						{{ next.title }}
						<svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="2"
								d="M9 5l7 7-7 7"
							/>
						</svg>
					</span>
				</NuxtLink>
			</div>
		</div>
	</div>
</template>

<script setup lang="ts">
interface SurroundItem {
	path: string;
	title: string;
}

const route = useRoute();

const { data: surround } = await useAsyncData(
	`surround-${route.path}`,
	() =>
		queryCollectionItemSurroundings('content', route.path, {
			before: 1,
			after: 1,
		}),
	{ watch: [() => route.path] }
);

const prev = computed<SurroundItem | null>(() => {
	if (!surround.value || surround.value.length < 1) return null;
	return surround.value[0] as unknown as SurroundItem;
});

const next = computed<SurroundItem | null>(() => {
	if (!surround.value || surround.value.length < 2) return null;
	return surround.value[1] as unknown as SurroundItem;
});
</script>

<style scoped>
.prev-next-card {
	text-decoration: none;
	background: var(--surface-3);
	border: 1px solid var(--color-border-subtle);
	box-shadow: var(--shadow-1);
	transition:
		border-color var(--motion-fast) var(--ease-spring),
		box-shadow var(--motion-fast) var(--ease-spring);
}

/* Hover: hairline darkens one step, shadow lifts one step. */
.prev-next-card:hover {
	border-color: var(--color-border-default);
	box-shadow: var(--shadow-2);
}
</style>
