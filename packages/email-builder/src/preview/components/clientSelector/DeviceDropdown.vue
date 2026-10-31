<script setup lang="ts">
import { computed } from 'vue';
import { Monitor, Smartphone, Tablet, Check } from '@lucide/vue';
import type { DevicePreset } from '../../types';
import { devicePresets } from '../../data/clients';
import { useBuilderI18n } from '../../../i18n/useBuilderI18n';

const { t, label } = useBuilderI18n();

defineProps<{
	selectedDevice: DevicePreset;
}>();

const emit = defineEmits<{
	(e: 'select', device: DevicePreset): void;
}>();

const devicesByType = computed(() => ({
	desktop: devicePresets.filter((d) => d.type === 'desktop'),
	tablet: devicePresets.filter((d) => d.type === 'tablet'),
	mobile: devicePresets.filter((d) => d.type === 'mobile'),
}));

function selectDevice(device: DevicePreset) {
	emit('select', device);
}
</script>

<template>
	<div class="ep-dropdown ep-dropdown-devices">
		<div class="ep-dropdown-header">{{ t('builder.preview.devices.title') }}</div>

		<!-- Desktop -->
		<div class="ep-dropdown-section">
			<div class="ep-dropdown-section-title">
				<Monitor class="ep-section-icon" />
				{{ t('builder.preview.devices.desktop') }}
			</div>
			<div class="ep-device-list">
				<button
					v-for="device in devicesByType.desktop"
					:key="device.id"
					class="ep-device-item"
					:class="{ 'ep-device-selected': selectedDevice.id === device.id }"
					@click="selectDevice(device)"
				>
					<span class="ep-device-name">{{ label(device.name) }}</span>
					<span class="ep-device-size">{{ device.width }} × {{ device.height }}</span>
					<Check v-if="selectedDevice.id === device.id" class="ep-device-check" />
				</button>
			</div>
		</div>

		<!-- Tablet -->
		<div class="ep-dropdown-section">
			<div class="ep-dropdown-section-title">
				<Tablet class="ep-section-icon" />
				{{ t('builder.preview.devices.tablet') }}
			</div>
			<div class="ep-device-list">
				<button
					v-for="device in devicesByType.tablet"
					:key="device.id"
					class="ep-device-item"
					:class="{ 'ep-device-selected': selectedDevice.id === device.id }"
					@click="selectDevice(device)"
				>
					<span class="ep-device-name">{{ label(device.name) }}</span>
					<span class="ep-device-size">{{ device.width }} × {{ device.height }}</span>
					<Check v-if="selectedDevice.id === device.id" class="ep-device-check" />
				</button>
			</div>
		</div>

		<!-- Mobile -->
		<div class="ep-dropdown-section">
			<div class="ep-dropdown-section-title">
				<Smartphone class="ep-section-icon" />
				{{ t('builder.preview.devices.mobile') }}
			</div>
			<div class="ep-device-list">
				<button
					v-for="device in devicesByType.mobile"
					:key="device.id"
					class="ep-device-item"
					:class="{ 'ep-device-selected': selectedDevice.id === device.id }"
					@click="selectDevice(device)"
				>
					<span class="ep-device-name">{{ label(device.name) }}</span>
					<span class="ep-device-size">{{ device.width }} × {{ device.height }}</span>
					<Check v-if="selectedDevice.id === device.id" class="ep-device-check" />
				</button>
			</div>
		</div>
	</div>
</template>

<!-- The dropdown frame and list rows are shared with ClientDropdown. -->
<style scoped src="./dropdown.css"></style>

<style scoped>
.ep-section-icon {
	width: 14px;
	height: 14px;
}
</style>
