<script setup lang="ts">
import { logError } from '~/lib/runtimeLog';
import { useZenMode } from '~/composables/useZenMode';
import { useGettingStartedControls } from '~/composables/useGettingStartedControls';
import { useShortcutLabels } from '~/composables/useShortcutLabels';
import ShellConnectionIndicator from './ConnectionIndicator.vue';
import {
	ExpandIcon,
	KeyboardIcon,
	ListChecklistIcon,
	LogOutIcon,
	PanelLeftCloseIcon,
	PanelLeftIcon,
	SettingsIcon,
	SparklesIcon,
} from '@coolicons/vue';

/**
 * The sidebar footer, one row: the account menu (Assistant, Zen mode, keyboard
 * shortcuts, the setup checklist, theme, sign out), then Settings as a quiet gear (settings are
 * visited rarely, so they get one door rather than two top-level sections),
 * then the collapse toggle. Collapsed to the icon rail, the three stack. While
 * the backend connection is down, its indicator gets a line above the row (a
 * dot between the gear and the avatar on the rail).
 */
const props = defineProps<{
	collapsed: boolean;
	/** The collapse toggle's label; absent where the rail cannot collapse. */
	collapseLabel?: string | null;
}>();
const emit = defineEmits<{ toggleCollapse: [] }>();

const { t } = useI18n();
const route = useRoute();
const { user, signOut, isPending } = useAuth();
const { isEnabled } = useFeatureFlag();
const { openHelpModal } = useKeyboardShortcuts();
const { enterZen } = useZenMode();
const { showChecklist } = useGettingStartedControls();
// The Assistant and Settings hints read the person's live binding, so a remap
// on the shortcuts page shows up here too.
const { ariaFor } = useShortcutLabels();

const settingsActive = computed(
	() => route.path.startsWith('/dashboard/preferences') || route.path.startsWith('/dashboard/admin')
);
// Every member gets the Assistant while the feature is on — the route itself is
// member-level, and onboarding promises it to everyone.
const showAssistant = computed(() => isEnabled('ai.assistant'));

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
	// oxlint-disable-next-line owlat/no-raw-keydown-listener -- Escape closes the account menu
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

const collapsedName = computed(() =>
	props.collapsed ? user.value?.name || t('shell.dashboard.userFallback') : undefined
);

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
function startZen() {
	menuOpen.value = false;
	enterZen();
}
function openSetupChecklist() {
	menuOpen.value = false;
	void showChecklist();
}
</script>

<template>
	<div
		class="flex border-t border-border-subtle px-2 py-2"
		:class="
			props.collapsed ? 'flex-col-reverse items-center gap-1' : 'flex-wrap items-center gap-0.5'
		"
	>
		<div ref="menuRef" class="relative min-w-0" :class="props.collapsed ? '' : 'flex-1'">
			<!-- Collapsed, the row shows only initials: the name is the tooltip and the label. -->
			<UiTooltip :text="collapsedName">
				<button
					type="button"
					class="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-bg-surface"
					:class="props.collapsed ? 'justify-center' : ''"
					:aria-expanded="menuOpen"
					aria-haspopup="menu"
					:aria-busy="isPending ? 'true' : undefined"
					:aria-label="collapsedName"
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
						</template>
						<template v-else>
							<span class="block truncate text-sm font-medium text-text-primary">{{
								user?.name || t('shell.dashboard.userFallback')
							}}</span>
						</template>
					</span>
				</button>
			</UiTooltip>

			<Transition
				enter-active-class="transition-[opacity,translate] duration-(--motion-moderate)"
				enter-from-class="opacity-0 translate-y-1"
				leave-active-class="transition-[opacity,translate] duration-(--motion-moderate-exit)"
				leave-to-class="opacity-0 translate-y-1"
			>
				<div
					v-if="menuOpen"
					role="menu"
					class="absolute bottom-full left-0 z-(--z-dropdown,50) mb-2 w-60 overflow-hidden rounded-lg border border-border-default bg-bg-elevated py-1 shadow-lg"
				>
					<p v-if="user?.email" class="truncate px-3 pb-1.5 pt-1 text-xs text-text-tertiary">
						{{ user.email }}
					</p>
					<NuxtLink
						v-if="showAssistant"
						to="/dashboard/assistant"
						role="menuitem"
						:aria-keyshortcuts="ariaFor('global.assistant')"
						class="flex items-center gap-3 px-3 py-2 text-sm text-text-primary hover:bg-bg-surface"
					>
						<SparklesIcon class="size-4 text-text-tertiary" />
						<span class="flex-1">{{ t('components.shell.footer.assistant') }}</span>
						<UiShortcut id="global.assistant" class="font-mono text-2xs text-text-tertiary" />
					</NuxtLink>
					<button
						type="button"
						role="menuitem"
						class="flex w-full items-center gap-3 px-3 py-2 text-sm text-text-primary hover:bg-bg-surface"
						:aria-keyshortcuts="ariaFor('global.zen')"
						@click="startZen"
					>
						<ExpandIcon class="size-4 text-text-tertiary" />
						<span class="flex-1 text-left">{{ t('components.shell.zen.enter') }}</span>
						<UiShortcut id="global.zen" class="font-mono text-2xs text-text-tertiary" />
					</button>
					<button
						type="button"
						role="menuitem"
						class="flex w-full items-center gap-3 px-3 py-2 text-sm text-text-primary hover:bg-bg-surface"
						:aria-keyshortcuts="ariaFor('global.help')"
						@click="openShortcuts"
					>
						<KeyboardIcon class="size-4 text-text-tertiary" />
						<span class="flex-1 text-left">{{ t('components.shell.footer.shortcuts') }}</span>
						<UiShortcut id="global.help" class="font-mono text-2xs text-text-tertiary" />
					</button>
					<button
						type="button"
						role="menuitem"
						class="flex w-full items-center gap-3 px-3 py-2 text-sm text-text-primary hover:bg-bg-surface"
						@click="openSetupChecklist"
					>
						<ListChecklistIcon class="size-4 text-text-tertiary" />
						<span class="flex-1 text-left">{{
							t('components.dashboard.gettingStarted.show')
						}}</span>
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
						<LogOutIcon class="size-4" />
						{{ t('shell.dashboard.signOut') }}
					</button>
				</div>
			</Transition>
		</div>

		<!-- Expanded, its own line above the row, so the name keeps its width. -->
		<ShellConnectionIndicator
			:compact="props.collapsed"
			:class="props.collapsed ? 'px-1' : 'order-first basis-full px-2 pb-1'"
		/>
		<UiTooltip :text="t('components.shell.footer.settings')">
			<template #shortcut><UiShortcut id="global.settings" /></template>
			<NuxtLink
				to="/dashboard/preferences"
				:aria-current="settingsActive ? 'page' : undefined"
				:aria-label="t('components.shell.footer.settings')"
				:aria-keyshortcuts="ariaFor('global.settings')"
				class="flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors"
				:class="
					settingsActive
						? 'bg-(--surface-2-selected) text-text-primary'
						: 'text-text-tertiary hover:bg-(--surface-2-hover) hover:text-text-primary'
				"
			>
				<SettingsIcon class="size-4.5" />
			</NuxtLink>
		</UiTooltip>
		<UiTooltip v-if="props.collapseLabel" :text="props.collapseLabel">
			<button
				type="button"
				class="hidden size-8 shrink-0 items-center justify-center rounded-lg text-text-tertiary transition-colors hover:bg-(--surface-2-hover) hover:text-text-primary lg:flex"
				:aria-label="props.collapseLabel"
				@click="emit('toggleCollapse')"
			>
				<component :is="props.collapsed ? PanelLeftIcon : PanelLeftCloseIcon" class="size-4.5" />
			</button>
		</UiTooltip>
	</div>
</template>
