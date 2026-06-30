<template>
	<div
		v-if="surround?.length"
		class="max-w-3xl mx-auto mt-12 pt-8 border-t border-border-subtle"
	>
		<div class="grid grid-cols-2 gap-4">
			<!-- Previous -->
			<div>
				<NuxtLink
					v-if="prev"
					:to="prev.path"
					class="prev-next-card spotlight-card group flex flex-col gap-1.5 p-4 rounded-xl border border-border-default bg-bg-surface"
					@mousemove="onMouseMove"
				>
					<span
						class="text-xs font-semibold uppercase tracking-wider text-text-tertiary"
					>
						Previous
					</span>
					<span
						class="text-sm text-text-secondary group-hover:text-brand transition-colors duration-200 flex items-center gap-1.5"
					>
						<svg
							class="w-3.5 h-3.5 shrink-0 transition-transform duration-300 group-hover:-translate-x-1"
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
						>
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
					class="prev-next-card spotlight-card group flex flex-col items-end gap-1.5 p-4 rounded-xl border border-border-default bg-bg-surface"
					@mousemove="onMouseMove"
				>
					<span
						class="text-xs font-semibold uppercase tracking-wider text-text-tertiary"
					>
						Next
					</span>
					<span
						class="text-sm text-text-secondary group-hover:text-brand transition-colors duration-200 flex items-center gap-1.5"
					>
						{{ next.title }}
						<svg
							class="w-3.5 h-3.5 shrink-0 transition-transform duration-300 group-hover:translate-x-1"
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
						>
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
	path: string
	title: string
}

const route = useRoute()
const { onMouseMove } = useSpotlight()

const { data: surround } = await useAsyncData(
	`surround-${route.path}`,
	() =>
		queryCollectionItemSurroundings('content', route.path, {
			before: 1,
			after: 1,
		}),
	{ watch: [() => route.path] }
)

const prev = computed<SurroundItem | null>(() => {
	if (!surround.value || surround.value.length < 1) return null
	return surround.value[0] as unknown as SurroundItem
})

const next = computed<SurroundItem | null>(() => {
	if (!surround.value || surround.value.length < 2) return null
	return surround.value[1] as unknown as SurroundItem
})
</script>

<style scoped>
.prev-next-card {
	text-decoration: none;
	transition: all 0.3s var(--ease-out-expo);
}

.prev-next-card:hover {
	border-color: color-mix(in srgb, var(--color-brand) 30%, var(--color-border-default));
	background: var(--color-bg-surface-hover);
	box-shadow: 0 4px 20px rgba(196, 120, 90, 0.06);
	transform: translateY(-2px);
}
</style>
