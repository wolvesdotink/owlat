<script setup lang="ts">
/**
 * One webhook endpoint in the list: the collapsed header (name, URL, state) and
 * the disclosure that carries its events, timestamps and the six things an
 * operator can do to it.
 *
 * Extracted from `pages/dashboard/admin/delivery/webhooks.vue`, which crossed
 * the 500-LOC split guideline. The row owns no state — the page still holds the
 * modals, the mutations and which row is expanded — so everything it does is an
 * event, and the page's handlers are unchanged.
 */
import type { Id } from '@owlat/api/dataModel';
import { getWebhookEventLabel, type WebhookEvent } from '~/composables/useWebhookForm';
import {
	ChevronDownIcon,
	GlobeIcon,
	PaperPlaneIcon,
	PauseIcon,
	PlayIcon,
	ReloadIcon,
	ScrollTextIcon,
	SettingsIcon,
	TrashIcon,
} from '@coolicons/vue';
import { SpinnerIcon } from '@owlat/ui/icons/SpinnerIcon';

interface WebhookRowEndpoint {
	_id: Id<'webhooks'>;
	name: string;
	url: string;
	events: readonly WebhookEvent[];
	isActive: boolean;
	createdAt: number;
	updatedAt: number;
}

defineProps<{
	webhook: WebhookRowEndpoint;
	expanded: boolean;
	/** This row's enable/disable write is in flight. */
	toggling: boolean;
	/** A test delivery is in flight (page-wide, as the page models it). */
	sendingTest: boolean;
}>();

const emit = defineEmits<{
	toggleExpanded: [];
	toggleActive: [];
	edit: [];
	sendTest: [];
	viewLogs: [];
	regenerate: [];
	remove: [];
}>();

const { t } = useI18n();

/** Event labels are message keys; an id with no definition reads as itself. */
const eventLabel = (event: string): string => t(getWebhookEventLabel(event));
</script>

<template>
	<div :class="['card p-0 overflow-hidden', webhook.isActive ? '' : 'opacity-60']">
		<!-- Webhook Header -->
		<div
			class="flex items-center justify-between px-6 py-4 cursor-pointer hover:bg-bg-surface/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset"
			role="button"
			tabindex="0"
			:aria-expanded="expanded"
			:aria-controls="`webhook-details-${webhook._id}`"
			:aria-label="t('dashboard.admin.delivery.webhooks.detailsFor', { name: webhook.name })"
			@click="emit('toggleExpanded')"
			@keydown.enter.self="emit('toggleExpanded')"
			@keydown.space.self.prevent="emit('toggleExpanded')"
		>
			<div class="flex items-center gap-4 min-w-0">
				<UiIconBox
					:icon="GlobeIcon"
					size="sm"
					:variant="webhook.isActive ? 'success' : 'surface'"
					rounded="lg"
					class="shrink-0"
				/>
				<div class="min-w-0">
					<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
						<span class="text-text-primary font-medium break-words">{{ webhook.name }}</span>
						<span
							:class="[
								'inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium',
								webhook.isActive
									? 'bg-success/10 text-success'
									: 'bg-bg-surface text-text-tertiary',
							]"
						>
							{{
								webhook.isActive
									? t('common.active')
									: t('dashboard.admin.delivery.webhooks.disabled')
							}}
						</span>
					</div>
					<p class="text-sm text-text-tertiary truncate mt-0.5">
						{{ webhook.url }}
					</p>
				</div>
			</div>
			<div class="flex items-center gap-2">
				<ChevronDownIcon
					:class="['w-5 h-5 text-text-tertiary transition-transform', expanded ? 'rotate-180' : '']"
					size="1em"
				/>
			</div>
		</div>

		<!-- Expanded Details -->
		<Transition name="expand">
			<div
				v-if="expanded"
				:id="`webhook-details-${webhook._id}`"
				class="expand-panel border-t border-border-subtle"
			>
				<div class="expand-panel-inner">
					<!-- Events -->
					<div class="px-6 py-4 border-b border-border-subtle">
						<p class="text-sm font-medium text-text-secondary mb-2">
							{{ t('dashboard.admin.delivery.webhooks.subscribedEvents') }}
						</p>
						<div class="flex flex-wrap gap-2">
							<span
								v-for="event in webhook.events"
								:key="event"
								class="inline-flex items-center px-2.5 py-1 rounded text-xs font-medium bg-bg-surface text-text-primary"
							>
								{{ eventLabel(event) }}
							</span>
						</div>
					</div>

					<!-- Info -->
					<div class="px-6 py-4 border-b border-border-subtle grid grid-cols-2 gap-4">
						<div>
							<p class="text-xs text-text-tertiary">
								{{ t('dashboard.admin.delivery.webhooks.created') }}
							</p>
							<p class="text-sm text-text-secondary">{{ formatDate(webhook.createdAt) }}</p>
						</div>
						<div>
							<p class="text-xs text-text-tertiary">
								{{ t('dashboard.admin.delivery.webhooks.lastUpdated') }}
							</p>
							<p class="text-sm text-text-secondary">{{ formatDate(webhook.updatedAt) }}</p>
						</div>
					</div>

					<!-- Actions. Wrap rather than overflow: the card clips, and on a
				     narrow screen the row is wider than the card. -->
					<div class="px-6 py-4 flex flex-wrap items-center justify-between gap-2">
						<div class="flex flex-wrap items-center gap-2">
							<UiButton
								variant="secondary"
								class="gap-2"
								:disabled="toggling"
								@click.stop="emit('toggleActive')"
							>
								<SpinnerIcon v-if="toggling" class="w-4 h-4" />
								<PlayIcon v-else-if="!webhook.isActive" class="w-4 h-4" />
								<PauseIcon v-else class="w-4 h-4" />
								{{
									webhook.isActive
										? t('dashboard.admin.delivery.webhooks.disable')
										: t('dashboard.admin.delivery.webhooks.enable')
								}}
							</UiButton>
							<UiButton variant="secondary" class="gap-2" @click.stop="emit('edit')">
								<SettingsIcon class="w-4 h-4" />
								{{ t('common.edit') }}
							</UiButton>
							<UiButton
								variant="secondary"
								class="gap-2"
								:disabled="!webhook.isActive || sendingTest"
								@click.stop="emit('sendTest')"
							>
								<SpinnerIcon v-if="sendingTest" class="w-4 h-4" />
								<PaperPlaneIcon v-else class="w-4 h-4" />
								{{ t('dashboard.admin.delivery.webhooks.sendTest') }}
							</UiButton>
							<UiButton variant="secondary" class="gap-2" @click.stop="emit('viewLogs')">
								<ScrollTextIcon class="w-4 h-4" />
								{{ t('dashboard.admin.delivery.webhooks.deliveryLogs') }}
							</UiButton>
							<UiButton variant="secondary" class="gap-2" @click.stop="emit('regenerate')">
								<ReloadIcon class="w-4 h-4" />
								{{ t('dashboard.admin.delivery.webhooks.regenerateSecret') }}
							</UiButton>
						</div>
						<UiButton variant="danger-ghost" class="gap-2" @click.stop="emit('remove')">
							<TrashIcon class="w-4 h-4" />
							{{ t('common.delete') }}
						</UiButton>
					</div>
				</div>
			</div>
		</Transition>
	</div>
</template>

<style scoped>
/* Expand transition. It animates the grid row from 0fr to 1fr instead of a
   fixed max-height, so a panel of any height (many events, wrapped actions)
   opens without clipping. The content sits in an unpadded inner wrapper
   because a padded grid item cannot shrink below its padding. */
.expand-panel {
	display: grid;
	grid-template-rows: 1fr;
}

.expand-panel-inner {
	min-height: 0;
}

.expand-enter-active,
.expand-leave-active {
	transition-property: opacity, grid-template-rows;
	transition-duration: var(--motion-moderate);
	transition-timing-function: var(--ease-spring);
}

.expand-enter-active .expand-panel-inner,
.expand-leave-active .expand-panel-inner {
	overflow: hidden;
}

.expand-enter-from,
.expand-leave-to {
	opacity: 0;
	grid-template-rows: 0fr;
}
</style>
