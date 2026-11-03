<script setup lang="ts">
import { computed } from 'vue';
import { CheckIcon, CloseIcon } from '@coolicons/vue';
import type { EmailClient } from '../../types';
import { emailClientGroups, popularClients } from '../../data/clients';
import { useBuilderI18n } from '../../../i18n/useBuilderI18n';
import { getIcon } from './clientIcon';

const { t } = useBuilderI18n();

defineProps<{
	selectedClient: EmailClient | null;
}>();

const emit = defineEmits<{
	(e: 'select', client: EmailClient | null): void;
}>();

const popularClientsList = computed(() => {
	const clients: EmailClient[] = [];
	for (const id of popularClients) {
		for (const group of emailClientGroups) {
			const client = group.clients.find((c) => c.id === id);
			if (client) {
				clients.push(client);
				break;
			}
		}
	}
	return clients;
});

function selectClient(client: EmailClient | null) {
	emit('select', client);
}
</script>

<template>
	<div class="ep-dropdown ep-dropdown-clients">
		<div class="ep-dropdown-header">
			<span>{{ t('builder.preview.clients.title') }}</span>
			<button v-if="selectedClient" class="ep-clear-button" @click="selectClient(null)">
				<CloseIcon class="ep-clear-icon" />
				{{ t('builder.preview.clients.clear') }}
			</button>
		</div>

		<!-- Popular Clients -->
		<div class="ep-dropdown-section">
			<div class="ep-dropdown-section-title">{{ t('builder.preview.clients.popular') }}</div>
			<div class="ep-client-grid">
				<button
					v-for="client in popularClientsList"
					:key="client.id"
					class="ep-client-chip"
					:class="{ 'ep-client-selected': selectedClient?.id === client.id }"
					@click="selectClient(client)"
				>
					<component :is="getIcon(client.icon)" class="ep-client-chip-icon" />
					<span>{{ client.name.split(' ')[0] }}</span>
				</button>
			</div>
		</div>

		<!-- All Clients -->
		<div class="ep-dropdown-section">
			<div class="ep-dropdown-section-title">
				{{ t('builder.preview.clients.all') }}
			</div>
			<div v-for="group in emailClientGroups" :key="group.family" class="ep-client-group">
				<div class="ep-client-group-name">
					<component :is="getIcon(group.icon)" class="ep-client-group-icon" />
					{{ group.name }}
				</div>
				<div class="ep-client-list">
					<button
						v-for="client in group.clients"
						:key="client.id"
						class="ep-client-item"
						:class="{ 'ep-client-selected': selectedClient?.id === client.id }"
						@click="selectClient(client)"
					>
						<component :is="getIcon(client.icon)" class="ep-client-item-icon" />
						<span class="ep-client-item-name">{{ client.name }}</span>
						<span v-if="client.marketShare" class="ep-client-item-share">
							{{ client.marketShare }}%
						</span>
						<CheckIcon v-if="selectedClient?.id === client.id" class="ep-client-check" />
					</button>
				</div>
			</div>
		</div>
	</div>
</template>

<!-- The dropdown frame and list rows are shared with DeviceDropdown. -->
<style scoped src="./dropdown.css"></style>

<style scoped>
.ep-dropdown-clients {
	min-width: 320px;
}

.ep-clear-button {
	display: flex;
	align-items: center;
	gap: 4px;
	padding: 4px 8px;
	background: transparent;
	border: none;
	border-radius: 4px;
	color: var(--ep-text-tertiary);
	font-size: 11px;
	font-weight: 500;
	cursor: pointer;
	text-transform: none;
	letter-spacing: normal;
}

.ep-clear-button:hover {
	background: var(--ep-bg-surface);
	color: var(--ep-text-secondary);
}

.ep-clear-icon {
	width: 12px;
	height: 12px;
}

/* Client Grid (Popular) */
.ep-client-grid {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
}

.ep-client-chip {
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 6px 10px;
	background: var(--ep-bg-surface);
	border: 1px solid var(--ep-border-subtle);
	border-radius: 6px;
	color: var(--ep-text-secondary);
	font-size: 12px;
	cursor: pointer;
	transition-property: color, background-color, border-color;
	transition-duration: var(--motion-fast, 80ms);
	transition-timing-function: var(--ease-spring, cubic-bezier(0.25, 1, 0.5, 1));
}

.ep-client-chip:hover {
	background: var(--ep-bg-surface-hover);
	color: var(--ep-text-primary);
}

.ep-client-chip.ep-client-selected {
	background: var(--ep-brand-subtle);
	border-color: var(--ep-brand-dim);
	color: var(--ep-brand);
}

.ep-client-chip-icon {
	width: 14px;
	height: 14px;
}

/* Client Group */
.ep-client-group {
	margin-bottom: 12px;
}

.ep-client-group:last-child {
	margin-bottom: 0;
}

.ep-client-group-name {
	display: flex;
	align-items: center;
	gap: 6px;
	margin-bottom: 6px;
	padding: 4px 0;
	font-size: 12px;
	font-weight: 600;
	color: var(--ep-text-secondary);
}

.ep-client-group-icon {
	width: 14px;
	height: 14px;
	color: var(--ep-text-tertiary);
}

.ep-client-item-icon {
	width: 16px;
	height: 16px;
	color: var(--ep-text-tertiary);
}
</style>
