import { watch } from 'vue';
import { applyReadingComfort, useReadingComfort } from '~/composables/useReadingComfort';

/**
 * Put the device's reading-comfort settings (contrast, motion, list density)
 * on `<html>` before the app mounts, and keep them there as they change, so
 * the first painted page already honours them and a change in Preferences, or
 * in another tab, applies everywhere at once.
 */
export default defineNuxtPlugin(() => {
	const { comfort } = useReadingComfort();
	watch(comfort, (value) => applyReadingComfort(document.documentElement, value), {
		immediate: true,
	});
});
