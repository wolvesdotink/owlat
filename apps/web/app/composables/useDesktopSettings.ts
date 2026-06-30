/**
 * Desktop-only settings (launch-at-login). No-op / inert on web.
 */
export function useDesktopSettings() {
	const { isDesktop } = useDesktopContext();
	const autostartEnabled = ref(false);
	const isReady = ref(false);

	onMounted(async () => {
		if (!isDesktop.value) return;
		try {
			const { getAutostartEnabled } = await import('@owlat/desktop/src/autostart');
			autostartEnabled.value = await getAutostartEnabled();
		} catch {
			// Tauri not available
		} finally {
			isReady.value = true;
		}
	});

	async function setAutostart(on: boolean) {
		if (!isDesktop.value) return;
		try {
			const { setAutostartEnabled } = await import('@owlat/desktop/src/autostart');
			await setAutostartEnabled(on);
			autostartEnabled.value = on;
		} catch {
			// ignore
		}
	}

	return { isDesktop, autostartEnabled, isReady, setAutostart };
}
