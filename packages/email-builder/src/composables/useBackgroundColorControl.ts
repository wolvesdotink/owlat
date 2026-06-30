import { ref, shallowRef } from 'vue';
import type { Ref, ShallowRef } from 'vue';

export interface ColorPreset {
	color: string;
	name: string;
}

export interface UseBackgroundColorControlOptions {
	/** The reactive background color value (two-way bound) */
	emailBackgroundColor: Ref<string>;
}

export interface UseBackgroundColorControlReturn {
	/** Ref for the hidden native color input element */
	bgColorInputRef: ShallowRef<HTMLInputElement | null>;
	/** Whether the background color picker dropdown is shown */
	showBgColorPicker: Ref<boolean>;
	/** Whether the canvas area is being hovered */
	isCanvasHovered: Ref<boolean>;
	/** Whether the native color input is active */
	isColorInputActive: Ref<boolean>;
	/** Preset background color options */
	emailBackgroundPresets: ColorPreset[];
	/** Handler for when the mouse leaves the canvas area */
	handleCanvasMouseLeave: () => void;
	/** Handler for clicking the custom color input button */
	handleBgColorInputClick: () => void;
	/** Handler for when a color is selected from the native color input */
	handleBgColorInputChange: () => void;
}

/**
 * Composable that manages the email background color picker control.
 *
 * Handles:
 * - Background color picker open/close state
 * - Canvas hover detection for showing/hiding the picker trigger
 * - Native color input integration
 * - Preset color definitions
 */
export function useBackgroundColorControl(
	_options: UseBackgroundColorControlOptions
): UseBackgroundColorControlReturn {
	const bgColorInputRef = shallowRef<HTMLInputElement | null>(null);
	const showBgColorPicker = ref(false);
	const isCanvasHovered = ref(false);
	const isColorInputActive = ref(false);

	const emailBackgroundPresets: ColorPreset[] = [
		{ color: '#ffffff', name: 'White' },
		{ color: '#fafafa', name: 'Snow' },
		{ color: '#f5f0eb', name: 'Cream' },
		{ color: '#f0ebe5', name: 'Warm' },
		{ color: '#e8e4e0', name: 'Stone' },
		{ color: '#1a1a2e', name: 'Midnight' },
		{ color: '#2d2d2d', name: 'Charcoal' },
		{ color: '#0c0b09', name: 'Obsidian' },
	];

	const handleCanvasMouseLeave = () => {
		isCanvasHovered.value = false;
		// Don't close the picker if the native color input is active
		if (!isColorInputActive.value) {
			showBgColorPicker.value = false;
		}
	};

	const handleBgColorInputClick = () => {
		isColorInputActive.value = true;
		bgColorInputRef.value?.click();
	};

	const handleBgColorInputChange = () => {
		// Color was selected, close the picker
		isColorInputActive.value = false;
		showBgColorPicker.value = false;
	};

	return {
		bgColorInputRef,
		showBgColorPicker,
		isCanvasHovered,
		isColorInputActive,
		emailBackgroundPresets,
		handleCanvasMouseLeave,
		handleBgColorInputClick,
		handleBgColorInputChange,
	};
}
