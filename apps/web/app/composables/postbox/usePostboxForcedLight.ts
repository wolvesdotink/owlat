/**
 * Per-message "force light rendering" escape hatch for the Postbox reader.
 *
 * When the app is in dark mode, simple mail renders dark inside the sandboxed
 * iframe. The sun/moon toggle in the reader header lets the user force a
 * single message back to light rendering. The choice is kept in memory only
 * (module-level, survives collapse/expand and thread navigation, gone on
 * reload) — deliberately not persisted.
 */

const forcedLightMessageIds = ref<Set<string>>(new Set());

export function usePostboxForcedLight() {
	const isForcedLight = (messageId: string): boolean =>
		forcedLightMessageIds.value.has(messageId);

	const toggleForcedLight = (messageId: string): void => {
		const next = new Set(forcedLightMessageIds.value);
		if (next.has(messageId)) next.delete(messageId);
		else next.add(messageId);
		forcedLightMessageIds.value = next;
	};

	return { isForcedLight, toggleForcedLight };
}
