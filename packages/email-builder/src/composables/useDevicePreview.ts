import { ref, computed, type Ref, type ComputedRef } from 'vue';

export type DeviceType = 'desktop' | 'tablet' | 'mobile';
export type ViewMode = 'visual' | 'code';

export interface DeviceConfig {
	width: number;
	height: number;
	label: string;
	frameClass: string;
}

export interface UseDevicePreviewOptions {
	html: Ref<string> | ComputedRef<string>;
}

export interface UseDevicePreviewReturn {
	selectedDevice: Ref<DeviceType>;
	darkMode: Ref<boolean>;
	viewMode: Ref<ViewMode>;
	deviceConfig: ComputedRef<DeviceConfig>;
	deviceDimensions: ComputedRef<{ width: number; height: number }>;
	formattedHtml: ComputedRef<string>;
}

/**
 * Composable for managing device preview state including device selection,
 * viewport dimensions, dark mode, view mode, and HTML formatting.
 */
export function useDevicePreview(options: UseDevicePreviewOptions): UseDevicePreviewReturn {
	const { html } = options;

	const selectedDevice = ref<DeviceType>('desktop');
	const darkMode = ref(false);
	const viewMode = ref<ViewMode>('visual');

	// Device dimensions
	const deviceConfig = computed<DeviceConfig>(() => {
		const configs: Record<DeviceType, DeviceConfig> = {
			desktop: { width: 680, height: 800, label: 'Desktop', frameClass: 'eb-frame-desktop' },
			tablet: { width: 768, height: 1024, label: 'Tablet', frameClass: 'eb-frame-tablet' },
			mobile: { width: 375, height: 667, label: 'Mobile', frameClass: 'eb-frame-mobile' },
		};
		return configs[selectedDevice.value];
	});

	const deviceDimensions = computed(() => ({
		width: deviceConfig.value.width,
		height: deviceConfig.value.height,
	}));

	// Format HTML for code view
	const formattedHtml = computed(() => {
		try {
			let htmlStr = html.value;
			let indent = 0;
			const tab = '  ';
			htmlStr = htmlStr.replace(/>\s*</g, '>\n<');
			const lines = htmlStr.split('\n');
			return lines
				.map((line) => {
					line = line.trim();
					if (!line) return '';
					if (line.match(/^<\/\w/)) indent = Math.max(0, indent - 1);
					const indented = tab.repeat(indent) + line;
					if (
						line.match(/^<\w/) &&
						!line.match(/\/>$/) &&
						!line.match(/^<(br|hr|img|input|meta|link)/i)
					) {
						indent++;
					}
					return indented;
				})
				.filter(Boolean)
				.join('\n');
		} catch {
			return html.value;
		}
	});

	return {
		selectedDevice,
		darkMode,
		viewMode,
		deviceConfig,
		deviceDimensions,
		formattedHtml,
	};
}
