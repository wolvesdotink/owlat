<script setup lang="ts">
import { ref, computed } from 'vue';
import { Monitor, Smartphone, Tablet, Globe, Shield, ChevronDown, Check, X } from '@lucide/vue';
import type { EmailClient, EmailClientGroup, DevicePreset } from '../types';
import { emailClientGroups, devicePresets, popularClients } from '../data/clients';

const props = defineProps<{
	selectedClient: EmailClient | null;
	selectedDevice: DevicePreset;
}>();

const emit = defineEmits<{
	(e: 'update:selectedClient', client: EmailClient | null): void;
	(e: 'update:selectedDevice', device: DevicePreset): void;
}>();

const showClientDropdown = ref(false);
const showDeviceDropdown = ref(false);

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

const devicesByType = computed(() => ({
	desktop: devicePresets.filter((d) => d.type === 'desktop'),
	tablet: devicePresets.filter((d) => d.type === 'tablet'),
	mobile: devicePresets.filter((d) => d.type === 'mobile'),
}));

function getIcon(iconName: string) {
	const icons: Record<string, unknown> = {
		monitor: Monitor,
		smartphone: Smartphone,
		tablet: Tablet,
		globe: Globe,
		shield: Shield,
		mail: Globe,
		'mail-open': Globe,
		apple: Monitor,
	};
	return icons[iconName] || Globe;
}

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
					:is="selectedClient ? getIcon(selectedClient.icon) : Globe"
					class="ep-selector-icon"
				/>
				<span class="ep-selector-label">
					{{ selectedClient?.name || 'All Clients' }}
				</span>
				<ChevronDown class="ep-selector-chevron" :class="{ 'ep-chevron-up': showClientDropdown }" />
			</button>

			<!-- Client Dropdown -->
			<Transition name="ep-dropdown">
				<div v-if="showClientDropdown" class="ep-dropdown ep-dropdown-clients">
					<div class="ep-dropdown-header">
						<span>Email Client</span>
						<button v-if="selectedClient" class="ep-clear-button" @click="selectClient(null)">
							<X class="ep-clear-icon" />
							Clear
						</button>
					</div>

					<!-- Popular Clients -->
					<div class="ep-dropdown-section">
						<div class="ep-dropdown-section-title">Popular</div>
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
						<div class="ep-dropdown-section-title">All Clients</div>
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
									<Check v-if="selectedClient?.id === client.id" class="ep-client-check" />
								</button>
							</div>
						</div>
					</div>
				</div>
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
				<span class="ep-selector-label">{{ selectedDevice.name }}</span>
				<ChevronDown class="ep-selector-chevron" :class="{ 'ep-chevron-up': showDeviceDropdown }" />
			</button>

			<!-- Device Dropdown -->
			<Transition name="ep-dropdown">
				<div v-if="showDeviceDropdown" class="ep-dropdown ep-dropdown-devices">
					<div class="ep-dropdown-header">Device Size</div>

					<!-- Desktop -->
					<div class="ep-dropdown-section">
						<div class="ep-dropdown-section-title">
							<Monitor class="ep-section-icon" />
							Desktop
						</div>
						<div class="ep-device-list">
							<button
								v-for="device in devicesByType.desktop"
								:key="device.id"
								class="ep-device-item"
								:class="{ 'ep-device-selected': selectedDevice.id === device.id }"
								@click="selectDevice(device)"
							>
								<span class="ep-device-name">{{ device.name }}</span>
								<span class="ep-device-size">{{ device.width }} × {{ device.height }}</span>
								<Check v-if="selectedDevice.id === device.id" class="ep-device-check" />
							</button>
						</div>
					</div>

					<!-- Tablet -->
					<div class="ep-dropdown-section">
						<div class="ep-dropdown-section-title">
							<Tablet class="ep-section-icon" />
							Tablet
						</div>
						<div class="ep-device-list">
							<button
								v-for="device in devicesByType.tablet"
								:key="device.id"
								class="ep-device-item"
								:class="{ 'ep-device-selected': selectedDevice.id === device.id }"
								@click="selectDevice(device)"
							>
								<span class="ep-device-name">{{ device.name }}</span>
								<span class="ep-device-size">{{ device.width }} × {{ device.height }}</span>
								<Check v-if="selectedDevice.id === device.id" class="ep-device-check" />
							</button>
						</div>
					</div>

					<!-- Mobile -->
					<div class="ep-dropdown-section">
						<div class="ep-dropdown-section-title">
							<Smartphone class="ep-section-icon" />
							Mobile
						</div>
						<div class="ep-device-list">
							<button
								v-for="device in devicesByType.mobile"
								:key="device.id"
								class="ep-device-item"
								:class="{ 'ep-device-selected': selectedDevice.id === device.id }"
								@click="selectDevice(device)"
							>
								<span class="ep-device-name">{{ device.name }}</span>
								<span class="ep-device-size">{{ device.width }} × {{ device.height }}</span>
								<Check v-if="selectedDevice.id === device.id" class="ep-device-check" />
							</button>
						</div>
					</div>
				</div>
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
	transition: all 0.15s ease;
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
	transition: transform 0.2s ease;
}

.ep-chevron-up {
	transform: rotate(180deg);
}

/* Dropdown */
.ep-dropdown {
	position: absolute;
	top: calc(100% + 8px);
	left: 0;
	min-width: 280px;
	max-height: 400px;
	overflow-y: auto;
	background: var(--ep-bg-elevated);
	border: 1px solid var(--ep-border-default);
	border-radius: 12px;
	box-shadow: var(--ep-shadow-lg);
	z-index: 100;
}

.ep-dropdown-clients {
	min-width: 320px;
}

.ep-dropdown-header {
	display: flex;
	justify-content: space-between;
	align-items: center;
	padding: 12px 16px;
	border-bottom: 1px solid var(--ep-border-subtle);
	font-size: 12px;
	font-weight: 600;
	color: var(--ep-text-secondary);
	text-transform: uppercase;
	letter-spacing: 0.05em;
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

.ep-dropdown-section {
	padding: 12px;
	border-bottom: 1px solid var(--ep-border-subtle);
}

.ep-dropdown-section:last-child {
	border-bottom: none;
}

.ep-dropdown-section-title {
	display: flex;
	align-items: center;
	gap: 6px;
	margin-bottom: 8px;
	font-size: 11px;
	font-weight: 600;
	color: var(--ep-text-tertiary);
	text-transform: uppercase;
	letter-spacing: 0.05em;
}

.ep-section-icon {
	width: 14px;
	height: 14px;
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
	transition: all 0.15s ease;
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

/* Client List */
.ep-client-list,
.ep-device-list {
	display: flex;
	flex-direction: column;
	gap: 2px;
}

.ep-client-item,
.ep-device-item {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 8px 10px;
	background: transparent;
	border: none;
	border-radius: 6px;
	color: var(--ep-text-primary);
	font-size: 13px;
	text-align: left;
	cursor: pointer;
	transition: background 0.15s ease;
}

.ep-client-item:hover,
.ep-device-item:hover {
	background: var(--ep-bg-surface);
}

.ep-client-item.ep-client-selected,
.ep-device-item.ep-device-selected {
	background: var(--ep-brand-subtle);
}

.ep-client-item-icon {
	width: 16px;
	height: 16px;
	color: var(--ep-text-tertiary);
}

.ep-client-item-name,
.ep-device-name {
	flex: 1;
}

.ep-client-item-share,
.ep-device-size {
	font-size: 11px;
	color: var(--ep-text-tertiary);
	font-variant-numeric: tabular-nums;
}

.ep-client-check,
.ep-device-check {
	width: 16px;
	height: 16px;
	color: var(--ep-brand);
}

/* Backdrop */
.ep-dropdown-backdrop {
	position: fixed;
	inset: 0;
	z-index: 99;
}

/* Transitions */
.ep-dropdown-enter-active,
.ep-dropdown-leave-active {
	transition: all 0.2s ease;
}

.ep-dropdown-enter-from,
.ep-dropdown-leave-to {
	opacity: 0;
	transform: translateY(-8px);
}
</style>
