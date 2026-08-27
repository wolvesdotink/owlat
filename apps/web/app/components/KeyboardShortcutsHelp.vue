<script setup lang="ts">
const { t } = useI18n();
const { isHelpModalOpen, closeHelpModal } = useKeyboardShortcuts();

const dialogRef = ref<HTMLElement | null>(null);
// Focus trap + opener restore + Escape, shared with UiModal and the chat dialogs.
useModalFocus(
	dialogRef,
	() => isHelpModalOpen.value,
	() => closeHelpModal()
);

// Shortcut categories. Computed, not a frozen object literal: the descriptions
// are messages, so they have to be re-read when the locale changes.
const shortcuts = computed(() => ({
	navigation: [
		{
			keys: ['g', 'd'],
			description: t('components.keyboardShortcutsHelp.shortcuts.goToDashboard'),
		},
		{ keys: ['g', 'c'], description: t('components.keyboardShortcutsHelp.shortcuts.goToContacts') },
		{ keys: ['g', 'e'], description: t('components.keyboardShortcutsHelp.shortcuts.goToEmails') },
		{
			keys: ['g', 'm'],
			description: t('components.keyboardShortcutsHelp.shortcuts.goToCampaigns'),
		},
		{
			keys: ['g', 'a'],
			description: t('components.keyboardShortcutsHelp.shortcuts.goToAutomations'),
		},
		{
			keys: ['g', 't'],
			description: t('components.keyboardShortcutsHelp.shortcuts.goToTransactional'),
		},
		// g+s routes to /dashboard/admin — this sheet used to advertise it as
		// "Settings", which is the (separate) preferences area.
		{ keys: ['g', 's'], description: t('components.keyboardShortcutsHelp.shortcuts.goToAdmin') },
	],
	actions: [
		{ keys: ['n'], description: t('components.keyboardShortcutsHelp.shortcuts.newItem') },
		{ keys: ['s'], description: t('components.keyboardShortcutsHelp.shortcuts.save') },
		{ keys: ['⌘', 'K'], description: t('components.keyboardShortcutsHelp.shortcuts.openSearch') },
		{
			keys: ['⌘', '\\'],
			description: t('components.keyboardShortcutsHelp.shortcuts.toggleSidebar'),
		},
	],
	general: [
		{ keys: ['?'], description: t('components.keyboardShortcutsHelp.shortcuts.showShortcuts') },
		{ keys: ['Esc'], description: t('components.keyboardShortcutsHelp.shortcuts.closeModal') },
	],
}));

// Handle backdrop click
const handleBackdropClick = () => {
	closeHelpModal();
};
</script>

<template>
	<Teleport to="body">
		<!-- Backdrop -->
		<Transition
			enter-active-class="transition-opacity duration-(--motion-fast)"
			enter-from-class="opacity-0"
			enter-to-class="opacity-100"
			leave-active-class="transition-opacity duration-(--motion-fast-exit)"
			leave-from-class="opacity-100"
			leave-to-class="opacity-0"
		>
			<div
				v-if="isHelpModalOpen"
				class="fixed inset-0 bg-scrim/60 backdrop-blur-sm z-50"
				@click="handleBackdropClick"
			/>
		</Transition>

		<!-- Modal -->
		<Transition
			enter-active-class="transition-all duration-(--motion-moderate)"
			enter-from-class="opacity-0 scale-95"
			enter-to-class="opacity-100 scale-100"
			leave-active-class="transition-all duration-(--motion-moderate-exit)"
			leave-from-class="opacity-100 scale-100"
			leave-to-class="opacity-0 scale-95"
		>
			<div
				v-if="isHelpModalOpen"
				ref="dialogRef"
				role="dialog"
				aria-modal="true"
				aria-labelledby="keyboard-shortcuts-title"
				tabindex="-1"
				class="fixed inset-x-4 top-[10%] mx-auto max-w-lg bg-bg-elevated border border-border-default rounded-xl shadow-2xl z-50 overflow-hidden"
				@click.stop
			>
				<!-- Header -->
				<div class="flex items-center justify-between px-6 py-4 border-b border-border-subtle">
					<div class="flex items-center gap-3">
						<UiIconBox icon="lucide:keyboard" size="sm" rounded="lg" />
						<div>
							<h2 id="keyboard-shortcuts-title" class="text-lg font-semibold text-text-primary">
								{{ t('components.keyboardShortcutsHelp.title') }}
							</h2>
							<p class="text-sm text-text-tertiary">
								{{ t('components.keyboardShortcutsHelp.subtitle') }}
							</p>
						</div>
					</div>
					<button
						class="p-2 text-text-tertiary hover:text-text-primary hover:bg-bg-surface rounded-lg transition-colors"
						@click="closeHelpModal"
						:aria-label="t('common.close')"
					>
						<Icon name="lucide:x" class="w-5 h-5" />
					</button>
				</div>

				<!-- Content -->
				<div class="px-6 py-4 max-h-[60vh] overflow-y-auto space-y-6">
					<!-- Navigation shortcuts -->
					<div>
						<h3 class="text-xs font-medium text-text-tertiary uppercase tracking-wider mb-3">
							{{ t('components.keyboardShortcutsHelp.sections.navigation') }}
						</h3>
						<div class="space-y-2">
							<div
								v-for="shortcut in shortcuts.navigation"
								:key="shortcut.description"
								class="flex items-center justify-between py-1.5"
							>
								<span class="text-sm text-text-secondary">{{ shortcut.description }}</span>
								<div class="flex items-center gap-1">
									<kbd
										v-for="(key, index) in shortcut.keys"
										:key="index"
										class="px-2 py-1 text-xs font-medium text-text-tertiary bg-bg-surface border border-border-subtle rounded"
									>
										{{ key }}
									</kbd>
									<span v-if="shortcut.keys.length > 1" class="text-text-tertiary text-xs mx-0.5">{{
										t('components.keyboardShortcutsHelp.then')
									}}</span>
								</div>
							</div>
						</div>
					</div>

					<!-- Action shortcuts -->
					<div>
						<h3 class="text-xs font-medium text-text-tertiary uppercase tracking-wider mb-3">
							{{ t('components.keyboardShortcutsHelp.sections.actions') }}
						</h3>
						<div class="space-y-2">
							<div
								v-for="shortcut in shortcuts.actions"
								:key="shortcut.description"
								class="flex items-center justify-between py-1.5"
							>
								<span class="text-sm text-text-secondary">{{ shortcut.description }}</span>
								<div class="flex items-center gap-1">
									<kbd
										v-for="(key, index) in shortcut.keys"
										:key="index"
										class="px-2 py-1 text-xs font-medium text-text-tertiary bg-bg-surface border border-border-subtle rounded"
									>
										{{ key }}
									</kbd>
								</div>
							</div>
						</div>
					</div>

					<!-- General shortcuts -->
					<div>
						<h3 class="text-xs font-medium text-text-tertiary uppercase tracking-wider mb-3">
							{{ t('components.keyboardShortcutsHelp.sections.general') }}
						</h3>
						<div class="space-y-2">
							<div
								v-for="shortcut in shortcuts.general"
								:key="shortcut.description"
								class="flex items-center justify-between py-1.5"
							>
								<span class="text-sm text-text-secondary">{{ shortcut.description }}</span>
								<div class="flex items-center gap-1">
									<kbd
										v-for="(key, index) in shortcut.keys"
										:key="index"
										class="px-2 py-1 text-xs font-medium text-text-tertiary bg-bg-surface border border-border-subtle rounded"
									>
										{{ key }}
									</kbd>
								</div>
							</div>
						</div>
					</div>
				</div>

				<!-- Footer -->
				<div class="px-6 py-3 border-t border-border-subtle bg-bg-surface">
					<p class="text-xs text-text-tertiary text-center">
						<I18nT keypath="components.keyboardShortcutsHelp.footer" tag="span" scope="global">
							<template #key>
								<kbd
									class="px-1.5 py-0.5 text-[10px] font-medium bg-bg-elevated border border-border-subtle rounded mx-1"
									>?</kbd
								>
							</template>
						</I18nT>
					</p>
				</div>
			</div>
		</Transition>
	</Teleport>
</template>
