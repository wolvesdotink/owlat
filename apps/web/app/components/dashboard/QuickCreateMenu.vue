<script setup lang="ts">
/**
 * The shell header's "New" split button — a create action one click from every
 * dashboard page.
 *
 * Left half runs the top verb the registry allows (compose, on an instance with
 * mail); right half opens the rest. Both halves read `useQuickCreateMenu`, so
 * the menu shows exactly the verbs this member's flags and role permit and the
 * button can never offer something its destination would refuse.
 *
 * It also owns the app-wide `c` chord. Registering it HERE rather than in the
 * layout keeps the key and the menu entry that documents it in one file — and
 * the registration follows the same gate as the entry, so `c` is dead rather
 * than silently swallowed on an instance with no mailbox. A surface that claims
 * `c` in its own scope still wins the press (utils/shortcutScope.ts).
 */

const { t } = useI18n();
const { actions, defaultAction, composeAction } = useQuickCreateMenu();
const { registerShortcut, unregisterShortcut } = useKeyboardShortcuts();

const isOpen = ref(false);

onMounted(() => {
	watch(
		composeAction,
		(action) => {
			if (action) {
				registerShortcut({
					id: 'global.compose',
					handler: () => action.run(),
					ignoreInputs: true,
				});
			} else {
				unregisterShortcut('global.compose');
			}
		},
		{ immediate: true }
	);
});

onUnmounted(() => unregisterShortcut('global.compose'));
</script>

<template>
	<div v-if="defaultAction" class="flex items-center" data-testid="quick-create">
		<UiButton
			size="sm"
			class="rounded-r-none pr-3 relative focus-visible:z-10"
			data-testid="quick-create-default"
			@click="defaultAction.run()"
		>
			<template #iconLeft>
				<Icon name="lucide:plus" class="w-4 h-4" />
			</template>
			{{ defaultAction.label }}
		</UiButton>

		<UiDropdownMenu v-model:open="isOpen" position="right" class="flex">
			<template #trigger>
				<UiButton
					size="sm"
					class="rounded-l-none w-8 px-0 border-l border-text-inverse/20 relative focus-visible:z-10"
					aria-haspopup="menu"
					:aria-expanded="isOpen"
					:aria-label="t('components.dashboard.quickCreateMenu.more')"
					data-testid="quick-create-more"
				>
					<Icon
						name="lucide:chevron-down"
						class="w-4 h-4 transition-transform duration-(--motion-fast)"
						:class="{ 'rotate-180': isOpen }"
					/>
				</UiButton>
			</template>

			<UiDropdownMenuItem
				v-for="action in actions"
				:key="action.id"
				:icon="action.icon"
				@click="action.run()"
			>
				<span class="flex-1 text-left">{{ action.label }}</span>
				<UiShortcut
					v-if="action.shortcutId"
					:id="action.shortcutId"
					class="px-1.5 py-0.5 text-2xs font-medium text-text-tertiary bg-bg-surface border border-border-subtle rounded"
				/>
			</UiDropdownMenuItem>
		</UiDropdownMenu>
	</div>
</template>
