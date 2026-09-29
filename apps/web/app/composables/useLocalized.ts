/**
 * `resolveLocalized` bound to the component's i18n instance: the render
 * boundary for copy that a pure module carries as a catalog key. See
 * `utils/localizedText.ts` for what each shape resolves to.
 *
 *   const localized = useLocalized();
 *   localized(row.label); // 'Paused', or the verbatim string when it is not a key
 */
import { resolveLocalized, type LocalizedText } from '~/utils/localizedText';

export function useLocalized(): (value: LocalizedText | null | undefined) => string {
	const { t, te } = useI18n();
	return (value) => resolveLocalized({ t, te }, value);
}
