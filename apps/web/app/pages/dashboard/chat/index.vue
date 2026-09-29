<script setup lang="ts">
const { t } = useI18n();

useHead({ title: () => t('dashboard.chat.index.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresFeature: 'chat',
});

// The rail, its drawer and the shared dialogs live in the parent route
// (pages/dashboard/chat.vue); this page is only the empty main column.
const { railOpen, openRail, openBrowseChannels, openCreateChannel } = useChatShell();
</script>

<template>
	<div class="flex-1 flex flex-col min-w-0">
		<!-- Drawer handle — the only way to the room list below md. Named, like
		     the room view's sibling: a lone icon in an otherwise empty strip
		     reads as stray chrome and says nothing about what it opens. 44px
		     tall for the thumb; the negative inline margin keeps the icon
		     optically aligned with the content below. -->
		<div class="md:hidden px-3 border-b border-border-subtle">
			<button
				type="button"
				class="-mx-2 h-11 flex items-center gap-1.5 px-2 rounded text-text-secondary hover:text-text-primary hover:bg-bg-surface transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand/40"
				aria-controls="chat-rail"
				:aria-expanded="railOpen"
				@click="openRail"
			>
				<Icon name="lucide:panel-left" class="w-4 h-4" />
				<span class="text-sm">{{ t('dashboard.chat.index.openConversations') }}</span>
			</button>
		</div>

		<!-- Empty state -->
		<div class="flex-1 flex flex-col items-center justify-center text-center px-6">
			<div
				class="w-16 h-16 rounded-full bg-bg-surface border border-border-subtle flex items-center justify-center mb-4"
			>
				<Icon name="lucide:message-circle" class="w-8 h-8 text-text-tertiary" />
			</div>
			<h3 class="text-lg font-medium text-text-primary">
				{{ t('dashboard.chat.index.emptyTitle') }}
			</h3>
			<p class="text-sm text-text-secondary mt-1 max-w-sm">
				{{ t('dashboard.chat.index.emptyDescription') }}
			</p>
			<!-- Stacked below sm: side by side at 390px the two labels wrap
			     inside their own pills, and a button never wraps. -->
			<div class="mt-6 flex flex-col gap-3 sm:flex-row">
				<UiButton variant="secondary" class="gap-2" @click="openBrowseChannels">
					<Icon name="lucide:hash" class="w-4 h-4" />
					{{ t('dashboard.chat.index.browseChannels') }}
				</UiButton>
				<UiButton class="gap-2" @click="openCreateChannel">
					<Icon name="lucide:plus" class="w-4 h-4" />
					{{ t('dashboard.chat.index.newChannel') }}
				</UiButton>
			</div>
		</div>
	</div>
</template>
