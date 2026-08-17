<template>
	<div ref="rootEl" class="relative">
		<button
			class="flex items-center gap-1.5 h-9 px-2.5 rounded-full text-text-tertiary hover:text-text-secondary hover:bg-bg-surface transition-colors duration-(--motion-fast) text-caption"
			:aria-label="t('language.label')"
			aria-haspopup="menu"
			:aria-expanded="open"
			@click="open = !open"
		>
			<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
				<path
					stroke-linecap="round"
					stroke-linejoin="round"
					stroke-width="2"
					d="M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-9c2.5 2.5 3.75 5.5 3.75 9s-1.25 6.5-3.75 9c-2.5-2.5-3.75-5.5-3.75-9S9.5 5.5 12 3zM3.6 9h16.8M3.6 15h16.8"
				/>
			</svg>
			<span class="hidden sm:inline uppercase tracking-wide">{{ locale }}</span>
		</button>

		<Transition name="language-menu">
			<ul
				v-if="open"
				class="absolute right-0 top-11 z-50 min-w-40 py-1 rounded-xl border border-border-subtle bg-surface-3 shadow-(--shadow-4)"
				role="menu"
			>
				<li v-for="option in localeOptions" :key="option.code" role="none">
					<NuxtLink
						:to="switchLocalePath(option.code)"
						class="flex items-center justify-between gap-3 px-3 py-2 text-sm no-underline transition-colors duration-(--motion-fast)"
						:class="
							option.code === locale
								? 'text-text-primary font-medium'
								: 'text-text-secondary hover:text-text-primary hover:bg-bg-surface'
						"
						role="menuitem"
						:lang="option.language"
						:aria-current="option.code === locale ? 'true' : undefined"
						@click="open = false"
					>
						{{ option.name }}
						<svg
							v-if="option.code === locale"
							class="w-3.5 h-3.5 shrink-0"
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
						>
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
						</svg>
					</NuxtLink>
				</li>
			</ul>
		</Transition>
	</div>
</template>

<script setup lang="ts">
/**
 * Locale picker for the docs header.
 *
 * `switchLocalePath` keeps the reader ON THE PAGE they are reading — it
 * re-resolves the current route for the other locale instead of sending
 * everyone to the localized home page. A German page that has not been
 * translated yet still resolves (the route exists for every locale) and renders
 * its English source, so the switch never dead-ends in a 404.
 */
const { t, locale, locales } = useI18n();
const switchLocalePath = useSwitchLocalePath();

const open = ref(false);
const rootEl = ref<HTMLElement | null>(null);

const localeOptions = computed(() =>
	locales.value.map((entry) => ({
		code: entry.code,
		name: entry.name ?? entry.code,
		language: entry.language ?? entry.code,
	}))
);

function onDocumentPointerDown(event: MouseEvent) {
	if (!open.value) return;
	if (rootEl.value && !rootEl.value.contains(event.target as Node)) open.value = false;
}

function onKeydown(event: KeyboardEvent) {
	if (event.key === 'Escape') open.value = false;
}

onMounted(() => {
	document.addEventListener('pointerdown', onDocumentPointerDown);
	document.addEventListener('keydown', onKeydown);
});

onUnmounted(() => {
	document.removeEventListener('pointerdown', onDocumentPointerDown);
	document.removeEventListener('keydown', onKeydown);
});
</script>

<style scoped>
.language-menu-enter-active,
.language-menu-leave-active {
	transition:
		opacity var(--motion-fast) var(--ease-spring),
		transform var(--motion-fast) var(--ease-spring);
}

.language-menu-enter-from,
.language-menu-leave-to {
	opacity: 0;
	transform: translateY(-4px);
}
</style>
