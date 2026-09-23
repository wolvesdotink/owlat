<script setup lang="ts">
import { logError } from '~/lib/runtimeLog';

/**
 * The sidebar footer: exactly one Settings entry (settings are visited rarely,
 * so they get one quiet door rather than two top-level sections) and the
 * account menu — Assistant, keyboard shortcuts, theme, sign out.
 */
const props = defineProps<{ collapsed: boolean }>();

const { t } = useI18n();
const route = useRoute();
const { user, signOut, isPending } = useAuth();
const { isEnabled } = useFeatureFlag();
const { isAdmin } = usePermissions();
const { openHelpModal } = useKeyboardShortcuts();

const settingsActive = computed(
	() => route.path.startsWith('/dashboard/preferences') || route.path.startsWith('/dashboard/admin')
);
const showAssistant = computed(() => isAdmin.value && isEnabled('ai.assistant'));

const menuOpen = ref(false);
const menuRef = ref<HTMLElement | null>(null);
function onClickOutside(event: MouseEvent) {
	if (menuRef.value && !menuRef.value.contains(event.target as Node)) menuOpen.value = false;
}
function onKeydown(event: KeyboardEvent) {
	if (event.key === 'Escape' && menuOpen.value) {
		event.stopPropagation();
		menuOpen.value = false;
	}
}
onMounted(() => {
	document.addEventListener('click', onClickOutside);
	document.addEventListener('keydown', onKeydown);
});
onUnmounted(() => {
	document.removeEventListener('click', onClickOutside);
	document.removeEventListener('keydown', onKeydown);
});
watch(
	() => route.path,
	() => (menuOpen.value = false)
);

const initials = computed(() => {
	const name = user.value?.name;
	if (!name) return '?';
	return name
		.split(' ')
		.map((n) => n[0])
		.join('')
		.toUpperCase()
		.slice(0, 2);
});

async function handleSignOut() {
	try {
		await signOut();
	} catch (e) {
		logError('Sign out failed:', e);
	}
}
function openShortcuts() {
	menuOpen.value = false;
	openHelpModal();
}
</script>

<template>
	<div class="border-t border-border-subtle px-2 py-2">
		<NuxtLink
			to="/dashboard/preferences"
			:aria-current="settingsActive ? 'page' : undefined"
			:title="props.collapsed ? t('components.shell.footer.settings') : undefined"
			class="flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-sm transition-colors"
			:class="[
				settingsActive
					? 'bg-(--surface-2-selected) font-medium text-text-primary'
					: 'text-text-secondary hover:bg-(--surface-2-hover) hover:text-text-primary',
				props.collapsed ? 'justify-center' : '',
			]"
		>
			<Icon name="lucide:settings" class="size-4.5 shrink-0 text-text-tertiary" />
			<span v-if="!props.collapsed" class="flex-1">{{
				t('components.shell.footer.settings')
			}}</span>
			<kbd v-if="!props.collapsed" class="font-mono text-2xs text-text-tertiary">⌘,</kbd>
		</NuxtLink>

		<div ref="menuRef" class="relative mt-1">
			<button
				type="button"
				class="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-bg-surface"
				:class="props.collapsed ? 'justify-center' : ''"
				:aria-expanded="menuOpen"
				aria-haspopup="menu"
				:aria-busy="isPending ? 'true' : undefined"
				:title="props.collapsed ? user?.name || t('shell.dashboard.userFallback') : undefined"
				@click.stop="menuOpen = !menuOpen"
			>
				<UiSkeleton v-if="isPending" circle class="size-7 shrink-0" />
				<span
					v-else
					class="flex size-7 shrink-0 items-center justify-center rounded-full bg-bg-surface text-xs font-medium text-text-secondary"
					>{{ initials }}</span
				>
				<span v-if="isPending" class="sr-only">{{ t('common.loading') }}</span>
				<span v-if="!props.collapsed" class="min-w-0 flex-1 text-left">
					<template v-if="isPending">
						<UiSkeleton class="h-3.5 w-24" />
						<UiSkeleton class="mt-2 h-3 w-32" />
					</template>
					<template v-else>
						<span class="block truncate text-sm font-medium text-text-primary">{{
							user?.name || t('shell.dashboard.userFallback')
						}}</span>
						<span class="block truncate text-xs text-text-tertiary">{{ user?.email || '' }}</span>
					</template>
				</span>
				<Icon
					v-if="!props.collapsed"
					name="lucide:chevrons-up-down"
					class="size-4 text-text-tertiary"
				/>
			</button>

			<Transition
				enter-active-class="transition-all duration-(--motion-moderate)"
				enter-from-class="opacity-0 translate-y-1"
				leave-active-class="transition-all duration-(--motion-moderate-exit)"
				leave-to-class="opacity-0 translate-y-1"
			>
				<div
					v-if="menuOpen"
					role="menu"
					class="absolute bottom-full left-0 z-(--z-dropdown,50) mb-2 w-60 overflow-hidden rounded-lg border border-border-default bg-bg-elevated py-1 shadow-lg"
				>
					<NuxtLink
						v-if="showAssistant"
						to="/dashboard/assistant"
						role="menuitem"
						class="flex items-center gap-3 px-3 py-2 text-sm text-text-primary hover:bg-bg-surface"
					>
						<Icon name="lucide:sparkles" class="size-4 text-text-tertiary" />
						<span class="flex-1">{{ t('components.shell.footer.assistant') }}</span>
					</NuxtLink>
					<button
						type="button"
						role="menuitem"
						class="flex w-full items-center gap-3 px-3 py-2 text-sm text-text-primary hover:bg-bg-surface"
						@click="openShortcuts"
					>
						<Icon name="lucide:keyboard" class="size-4 text-text-tertiary" />
						<span class="flex-1 text-left">{{ t('components.shell.footer.shortcuts') }}</span>
						<kbd class="font-mono text-2xs text-text-tertiary">?</kbd>
					</button>
					<div class="flex items-center gap-3 px-3 py-2 text-sm text-text-primary">
						<UiThemeToggle
							class="flex items-center gap-3 text-text-tertiary hover:text-text-primary"
						>
							<span class="text-sm text-text-primary">{{ t('shell.dashboard.theme') }}</span>
						</UiThemeToggle>
					</div>
					<div class="my-1 border-t border-border-subtle" />
					<button
						type="button"
						role="menuitem"
						class="flex w-full items-center gap-3 px-3 py-2 text-sm text-error hover:bg-error-subtle"
						@click="handleSignOut"
					>
						<Icon name="lucide:log-out" class="size-4" />
						{{ t('shell.dashboard.signOut') }}
					</button>
				</div>
			</Transition>
		</div>
	</div>
</template>
