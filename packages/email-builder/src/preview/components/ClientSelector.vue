<script setup lang="ts">
import { ref } from 'vue';
import { ChevronDownIcon, GlobeIcon } from '@coolicons/vue';
import type { EmailClient, DevicePreset } from '../types';
import { useBuilderI18n } from '../../i18n/useBuilderI18n';
import ClientDropdown from './clientSelector/ClientDropdown.vue';
import DeviceDropdown from './clientSelector/DeviceDropdown.vue';
import { getIcon } from './clientSelector/clientIcon';

const { t, label } = useBuilderI18n();

defineProps<{
	selectedClient: EmailClient | null;
	selectedDevice: DevicePreset;
}>();

const emit = defineEmits<{
	(e: 'update:selectedClient', client: EmailClient | null): void;
	(e: 'update:selectedDevice', device: DevicePreset): void;
}>();

const showClientDropdown = ref(false);
const showDeviceDropdown = ref(false);

function selectClient(client: EmailClient | null) {
	emit('update:selectedClient', client);
	showClientDropdown.value = false;
}

function selectDevice(device: DevicePreset) {
	emit('update:selectedDevice', device);
	showDeviceDropdown.value = false;
}

function closeDropdowns() {
	showClientDropdown.value = false;
	showDeviceDropdown.value = false;
}
</script>

<template>
	<div class="ep-selectors" @click.stop>
		<!-- Client Selector -->
		<div class="ep-selector">
			<button
				class="ep-selector-button"
				:class="{ 'ep-selector-active': showClientDropdown }"
				@click="
					showClientDropdown = !showClientDropdown;
					showDeviceDropdown = false;
				"
			>
				<component
					:is="selectedClient ? getIcon(selectedClient.icon) : GlobeIcon"
					class="ep-selector-icon"
				/>
				<span class="ep-selector-label">
					{{ selectedClient?.name || t('builder.preview.clients.all') }}
				</span>
				<ChevronDownIcon
					class="ep-selector-chevron"
					:class="{ 'ep-chevron-up': showClientDropdown }"
				/>
			</button>

			<!-- Client Dropdown -->
			<Transition name="ep-dropdown">
				<ClientDropdown
					v-if="showClientDropdown"
					:selected-client="selectedClient"
					@select="selectClient"
				/>
			</Transition>
		</div>

		<!-- Device Selector -->
		<div class="ep-selector">
			<button
				class="ep-selector-button"
				:class="{ 'ep-selector-active': showDeviceDropdown }"
				@click="
					showDeviceDropdown = !showDeviceDropdown;
					showClientDropdown = false;
				"
			>
				<component :is="getIcon(selectedDevice.icon)" class="ep-selector-icon" />
				<span class="ep-selector-label">{{ label(selectedDevice.name) }}</span>
				<ChevronDownIcon
					class="ep-selector-chevron"
					:class="{ 'ep-chevron-up': showDeviceDropdown }"
				/>
			</button>

			<!-- Device Dropdown -->
			<Transition name="ep-dropdown">
				<DeviceDropdown
					v-if="showDeviceDropdown"
					:selected-device="selectedDevice"
					@select="selectDevice"
				/>
			</Transition>
		</div>

		<!-- Backdrop -->
		<div
			v-if="showClientDropdown || showDeviceDropdown"
			class="ep-dropdown-backdrop"
			@click="closeDropdowns"
		></div>
	</div>
</template>

<style scoped>
.ep-selectors {
	display: flex;
	gap: 8px;
	position: relative;
}

.ep-selector {
	position: relative;
}

.ep-selector-button {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 8px 12px;
	background: var(--ep-bg-surface);
	border: 1px solid var(--ep-border-default);
	border-radius: 8px;
	color: var(--ep-text-primary);
	font-size: 13px;
	font-weight: 500;
	cursor: pointer;
	transition-property: background-color, border-color;
	transition-duration: var(--motion-fast, 80ms);
	transition-timing-function: var(--ease-spring, cubic-bezier(0.25, 1, 0.5, 1));
}

.ep-selector-button:hover {
	background: var(--ep-bg-surface-hover);
	border-color: var(--ep-border-strong);
}

.ep-selector-active {
	background: var(--ep-bg-surface-hover);
	border-color: var(--ep-brand);
}

.ep-selector-icon {
	width: 16px;
	height: 16px;
	color: var(--ep-text-secondary);
}

.ep-selector-label {
	max-width: 140px;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.ep-selector-chevron {
	width: 14px;
	height: 14px;
	color: var(--ep-text-tertiary);
	transition: transform var(--motion-moderate, 160ms)
		var(--ease-spring, cubic-bezier(0.25, 1, 0.5, 1));
}

.ep-chevron-up {
	transform: rotate(180deg);
}

/* Backdrop */
.ep-dropdown-backdrop {
	position: fixed;
	inset: 0;
	z-index: 99;
}

/* Transitions: applied to the dropdown components' root elements */
.ep-dropdown-enter-active,
.ep-dropdown-leave-active {
	transition-property: opacity, transform;
	transition-duration: var(--motion-moderate, 160ms);
	transition-timing-function: var(--ease-spring, cubic-bezier(0.25, 1, 0.5, 1));
}

.ep-dropdown-enter-from,
.ep-dropdown-leave-to {
	opacity: 0;
	transform: translateY(-8px);
}
</style>
