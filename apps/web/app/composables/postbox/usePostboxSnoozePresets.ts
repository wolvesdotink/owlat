import { computeSnoozePresets, detectSnoozeHint } from '@owlat/shared/snoozePresets';
import type { PaletteArgumentOption } from '~/lib/commandPalette';
import { useLocalized } from '~/composables/useLocalized';
import { CalendarIcon, ReplyIcon } from '@coolicons/vue';

/** Fallback cap for "until they reply": resurface after a week if no reply. */
export const SNOOZE_UNTIL_REPLY_CAP_MS = 7 * 24 * 60 * 60 * 1000;

/** One snooze preset, in words, with the wake time it stands for. */
interface SnoozePresetEntry {
	label: string;
	sub: string;
	at: number;
	suggested: boolean;
}

/** What a snooze submenu does with the choice. */
interface SnoozeOptionHandlers {
	/** Thread text the deterministic wake-time suggestion reads. */
	hintText: string;
	onSnooze: (until: number) => void;
	/** "Until they reply" (carries the fallback cap); omitted where it does not apply. */
	onUntilReply?: (capUntil: number) => void;
	/** "Pick a date & time…": the full picker, for a time the presets do not offer. */
	onPickTime: () => void;
}

/**
 * The snooze presets, resolved now, in the active locale — shared by the snooze
 * dialog and the palette's "Snooze ›" submenus, so the two can never offer
 * different times for the same words.
 *
 * `@owlat/shared/snoozePresets` is module scope and shared with the backend, so
 * it never speaks: it hands back the catalog KEY for each label (and the key
 * plus parameters for each sublabel), and this is the render boundary that turns
 * those into words — in the active locale, which the wake times and weekdays it
 * formats follow too.
 */
export function usePostboxSnoozePresets() {
	const { t, locale } = useI18n();
	const localized = useLocalized();

	function presets(hintText: string): SnoozePresetEntry[] {
		const now = Date.now();
		const tzOffsetMinutes = -new Date().getTimezoneOffset();
		const suggested = detectSnoozeHint(hintText);
		return computeSnoozePresets({ now, tzOffsetMinutes, suggested, locale: locale.value }).map(
			(preset) => ({
				label: t(preset.label),
				sub: localized(preset.sub),
				at: preset.at,
				suggested: preset.suggested === true,
			})
		);
	}

	/** The presets as a palette submenu, plus "until they reply" and the full picker. */
	function snoozeOptions(handlers: SnoozeOptionHandlers): PaletteArgumentOption[] {
		const options: PaletteArgumentOption[] = presets(handlers.hintText).map((preset, index) => ({
			id: `snooze-${index}`,
			label: preset.label,
			subtitle: preset.suggested
				? `${preset.sub} · ${t('components.postbox.postboxPresetTimeDialog.suggested')}`
				: preset.sub,
			run: () => handlers.onSnooze(preset.at),
		}));
		const untilReply = handlers.onUntilReply;
		if (untilReply) {
			options.push({
				id: 'snooze-until-reply',
				label: t('components.postbox.postboxSnoozeDialog.untilReply'),
				subtitle: t('components.postbox.postboxSnoozeDialog.untilReplySub'),
				icon: ReplyIcon,
				run: () => untilReply(Date.now() + SNOOZE_UNTIL_REPLY_CAP_MS),
			});
		}
		options.push({
			id: 'snooze-pick',
			label: t('components.postbox.postboxSnoozeDialog.pickTime'),
			icon: CalendarIcon,
			run: handlers.onPickTime,
		});
		return options;
	}

	return { presets, snoozeOptions };
}
