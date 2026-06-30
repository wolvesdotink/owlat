<script setup lang="ts">
const { isHelpModalOpen, closeHelpModal } = useKeyboardShortcuts();

const dialogRef = ref<HTMLElement | null>(null);
// Focus trap + opener restore + Escape, shared with UiModal and the chat dialogs.
useModalFocus(dialogRef, () => isHelpModalOpen.value, () => closeHelpModal());

// Shortcut categories
const shortcuts = {
	navigation: [
		{ keys: ['g', 'd'], description: 'Go to Dashboard' },
		{ keys: ['g', 'c'], description: 'Go to Contacts' },
		{ keys: ['g', 'e'], description: 'Go to Emails' },
		{ keys: ['g', 'm'], description: 'Go to Campaigns' },
		{ keys: ['g', 'a'], description: 'Go to Automations' },
		{ keys: ['g', 't'], description: 'Go to Transactional' },
		{ keys: ['g', 's'], description: 'Go to Settings' },
	],
	actions: [
		{ keys: ['n'], description: 'New item (context-aware)' },
		{ keys: ['s'], description: 'Save (when editing)' },
		{ keys: ['⌘', 'K'], description: 'Open search' },
	],
	general: [
		{ keys: ['?'], description: 'Show keyboard shortcuts' },
		{ keys: ['Esc'], description: 'Close modal / Cancel' },
	],
};

// Handle backdrop click
const handleBackdropClick = () => {
	closeHelpModal();
};
</script>

<template>
	<Teleport to="body">
		<!-- Backdrop -->
		<Transition
			enter-active-class="transition-opacity duration-150"
			enter-from-class="opacity-0"
			enter-to-class="opacity-100"
			leave-active-class="transition-opacity duration-150"
			leave-from-class="opacity-100"
			leave-to-class="opacity-0"
		>
			<div
				v-if="isHelpModalOpen"
				class="fixed inset-0 bg-black/60 backdrop-blur-sm z-50"
				@click="handleBackdropClick"
			/>
		</Transition>

		<!-- Modal -->
		<Transition
			enter-active-class="transition-all duration-200"
			enter-from-class="opacity-0 scale-95"
			enter-to-class="opacity-100 scale-100"
			leave-active-class="transition-all duration-150"
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
							<h2 id="keyboard-shortcuts-title" class="text-lg font-semibold text-text-primary">Keyboard Shortcuts</h2>
							<p class="text-sm text-text-tertiary">Navigate faster with your keyboard</p>
						</div>
					</div>
					<button
						class="p-2 text-text-tertiary hover:text-text-primary hover:bg-bg-surface rounded-lg transition-colors"
						@click="closeHelpModal"
					 aria-label="Close">
						<Icon name="lucide:x" class="w-5 h-5" />
					</button>
				</div>

				<!-- Content -->
				<div class="px-6 py-4 max-h-[60vh] overflow-y-auto space-y-6">
					<!-- Navigation shortcuts -->
					<div>
						<h3 class="text-xs font-medium text-text-tertiary uppercase tracking-wider mb-3">
							Navigation
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
									<span v-if="shortcut.keys.length > 1" class="text-text-tertiary text-xs mx-0.5"
										>then</span
									>
								</div>
							</div>
						</div>
					</div>

					<!-- Action shortcuts -->
					<div>
						<h3 class="text-xs font-medium text-text-tertiary uppercase tracking-wider mb-3">
							Actions
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
							General
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
						Press
						<kbd
							class="px-1.5 py-0.5 text-[10px] font-medium bg-bg-elevated border border-border-subtle rounded mx-1"
							>?</kbd
						>
						anytime to show this help
					</p>
				</div>
			</div>
		</Transition>
	</Teleport>
</template>
