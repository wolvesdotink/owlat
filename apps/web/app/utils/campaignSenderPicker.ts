/**
 * Pure helpers for the campaign wizard's sender picker (2026-07-10 experience
 * plan, decision 8 / piece d3). The Setup step replaces the free-text
 * from-name / from-email fields with a SELECT over the ENABLED curated senders;
 * a "Custom address…" option is revealed ONLY when the instance allows custom
 * campaign senders (when off it is invisible, never a disabled row).
 *
 * Framework-free so the option-mapping, default-selection and submit-guard logic
 * are unit-tested directly. The server-side gate (`campaigns/senders.ts`) stays
 * the floor — this mirrors it in the UI so an unsubmittable address is never
 * offered in the first place.
 */
import { isValidEmail } from './validation';

/** Sentinel select value for the "Custom address…" option. */
export const CUSTOM_SENDER_VALUE = '__custom__';

/** The subset of a curated sender the picker reads. */
export interface PickerSender {
	_id: string;
	email: string;
	displayName?: string;
	isDefault?: boolean;
}

export interface SenderOption {
	value: string;
	label: string;
}

/** "Display Name <address>" — or just the address when there is no display name. */
export function formatSenderLabel(sender: PickerSender): string {
	const name = sender.displayName?.trim();
	return name ? `${name} <${sender.email}>` : sender.email;
}

/**
 * Build the select options: one per enabled curated sender, plus the
 * "Custom address…" escape hatch appended ONLY when custom senders are allowed.
 */
export function buildSenderOptions(
	senders: PickerSender[],
	isCustomAllowed: boolean
): SenderOption[] {
	const options: SenderOption[] = senders.map((sender) => ({
		value: sender._id,
		label: formatSenderLabel(sender),
	}));
	if (isCustomAllowed) {
		options.push({ value: CUSTOM_SENDER_VALUE, label: 'Custom address…' });
	}
	return options;
}

/** Whether the picker currently sits on the custom-address option. */
export function isCustomSender(value: string): boolean {
	return value === CUSTOM_SENDER_VALUE;
}

/**
 * The value the picker should preselect: the marked default sender, else the
 * first enabled sender, else the custom option when that is the only path, else
 * empty string (the caller renders an empty-state instead of a picker).
 */
export function defaultSenderValue(senders: PickerSender[], isCustomAllowed: boolean): string {
	const preferred = senders.find((sender) => sender.isDefault) ?? senders[0];
	if (preferred) return preferred._id;
	return isCustomAllowed ? CUSTOM_SENDER_VALUE : '';
}

/**
 * Why a sender selection cannot be submitted, or `null` when it is complete.
 * The single source of truth for both the submit guard (`isSenderReady`) and the
 * validation messages the Setup step renders, so the two never drift.
 */
type SenderSelectionProblem = 'none-selected' | 'missing-name' | 'invalid-email';

/**
 * Diagnose the sender selection. A curated selection is always complete; the
 * custom branch additionally needs a from name and a syntactically valid from
 * address — mirroring the server-side gate.
 */
export function senderSelectionProblem(
	value: string,
	custom: { fromName: string; fromEmail: string }
): SenderSelectionProblem | null {
	if (!value) return 'none-selected';
	if (value === CUSTOM_SENDER_VALUE) {
		if (custom.fromName.trim().length === 0) return 'missing-name';
		if (!isValidEmail(custom.fromEmail.trim())) return 'invalid-email';
	}
	return null;
}
