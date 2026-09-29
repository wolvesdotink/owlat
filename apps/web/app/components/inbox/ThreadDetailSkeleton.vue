<script setup lang="ts">
/**
 * The Team Inbox thread page while `getThread` is in flight: the page's own
 * shape (header, message cards, sidebar) instead of a centred spinner, so
 * nothing jumps when the thread lands.
 *
 * When the list already showed this thread, its row seeds the header with the
 * real subject, sender and message count; the same classes as the loaded
 * header keep those lines where they will stay. The subject is a styled
 * paragraph, not an h1: the loaded page header owns the heading.
 */
import type { TeamThreadPreview } from '~/utils/teamThreadPreviews';

defineProps<{
	/** The Team Inbox row this thread was opened from, when the list loaded it. */
	preview?: TeamThreadPreview | null;
}>();

const { t } = useI18n();
</script>

<template>
	<div data-testid="thread-detail-skeleton" aria-busy="true">
		<p role="status" class="sr-only">{{ t('dashboard.inbox.detail.loading') }}</p>

		<!-- Header -->
		<div class="flex items-start justify-between gap-4 mb-6">
			<div v-if="preview" class="min-w-0" data-testid="thread-detail-skeleton-preview">
				<!-- A placeholder, so not the page's h1: the loaded header owns that. -->
				<p
					class="text-2xl font-medium tracking-[-0.02em] text-text-primary break-words"
					data-testid="thread-detail-skeleton-subject"
				>
					{{ preview.subject || t('dashboard.inbox.detail.noSubject') }}
				</p>
				<p class="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text-tertiary">
					<span v-if="preview.contactIdentifier" class="text-text-secondary">
						{{ preview.contactIdentifier }}
					</span>
					<span
						v-if="preview.contactIdentifier && preview.messageCount !== undefined"
						aria-hidden="true"
						>·</span
					>
					<span v-if="preview.messageCount !== undefined">
						{{
							t(
								'dashboard.inbox.detail.messageCount',
								{ count: preview.messageCount },
								preview.messageCount
							)
						}}
					</span>
				</p>
			</div>
			<div v-else class="min-w-0 flex-1" aria-hidden="true">
				<UiSkeleton class="h-8 w-2/3 max-w-md" />
				<UiSkeleton class="mt-3 h-4 w-56 max-w-full" />
			</div>
			<div class="flex shrink-0 items-center gap-2" aria-hidden="true">
				<UiSkeleton class="h-9 w-20" />
				<UiSkeleton class="h-9 w-9" />
				<UiSkeleton class="h-9 w-24" />
			</div>
		</div>

		<div class="grid grid-cols-1 lg:grid-cols-3 gap-6" aria-hidden="true">
			<!-- Messages -->
			<div class="lg:col-span-2 space-y-4">
				<div v-for="i in 2" :key="i" class="card">
					<div class="flex items-center gap-3 mb-4">
						<UiSkeleton circle class="h-8 w-8 shrink-0" />
						<div class="min-w-0 flex-1">
							<UiSkeleton class="h-3.5 w-48 max-w-full" />
							<UiSkeleton class="mt-2 h-3 w-20" />
						</div>
					</div>
					<UiSkeletonText :lines="i === 1 ? 4 : 2" size="sm" />
				</div>
			</div>

			<!-- Sidebar -->
			<div class="space-y-6">
				<div class="card">
					<UiSkeleton class="h-5 w-24 mb-4" />
					<div class="space-y-3">
						<div v-for="i in 3" :key="i">
							<UiSkeleton class="h-3 w-16" />
							<UiSkeleton class="mt-1.5 h-4 w-28" />
						</div>
					</div>
				</div>
			</div>
		</div>
	</div>
</template>
