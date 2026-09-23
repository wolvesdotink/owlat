/**
 * The setup wizard's first question, asked in the team's words (#770).
 *
 * The mode step used to open with eight operator presets ("CRM only",
 * "IMAP-only", "Team inbox + AI agent", …) that overlapped and assumed the
 * reader already knew the product. It now asks what the team wants to do and
 * derives the flags from the answer. The eight presets still exist, behind an
 * "Advanced" disclosure, for operators who want a specific shape.
 *
 * Every outcome resolves through the same `operatingModeFlags` presets the
 * advanced list uses, so an answer here and the matching preset there land on
 * the same flag set. "Both" is the union of the two single answers.
 *
 * Copy is message KEYS (module scope, no `t()`); the page resolves them.
 */

import { resolveFlags, type FeatureFlagState } from '@owlat/shared/featureFlags';
import { operatingModeFlags, type OperatingModeKey } from '@owlat/shared/operatingModes';

export type SetupOutcome = 'conversations' | 'sending' | 'both';

export interface SetupOutcomeOption {
	key: SetupOutcome;
	/** i18n key for the card title. */
	label: string;
	/** i18n key for the one-line explanation under it. */
	description: string;
	icon: string;
	/** Whether the answer includes answering email, so AI drafting can be offered. */
	answersEmail: boolean;
}

export const SETUP_OUTCOMES: readonly SetupOutcomeOption[] = [
	{
		key: 'conversations',
		label: 'setup.mode.outcomes.conversations.label',
		description: 'setup.mode.outcomes.conversations.description',
		icon: 'lucide:inbox',
		answersEmail: true,
	},
	{
		key: 'sending',
		label: 'setup.mode.outcomes.sending.label',
		description: 'setup.mode.outcomes.sending.description',
		icon: 'lucide:send',
		answersEmail: false,
	},
	{
		key: 'both',
		label: 'setup.mode.outcomes.both.label',
		description: 'setup.mode.outcomes.both.description',
		icon: 'lucide:layers',
		answersEmail: true,
	},
];

/** The answer a fresh wizard starts on: the recommended one. */
export const DEFAULT_SETUP_OUTCOME: SetupOutcome = 'both';

export function outcomeAnswersEmail(outcome: SetupOutcome): boolean {
	return SETUP_OUTCOMES.find((option) => option.key === outcome)?.answersEmail ?? false;
}

/** The presets an outcome is made of. */
function outcomePresets(outcome: SetupOutcome, aiDrafts: boolean): OperatingModeKey[] {
	const teamPreset: OperatingModeKey = aiDrafts ? 'team_inbox_ai' : 'team_inbox';
	switch (outcome) {
		case 'conversations':
			return [teamPreset];
		case 'sending':
			return ['marketing'];
		case 'both':
			return [teamPreset, 'marketing'];
	}
}

/**
 * The feature flags an answer turns on.
 *
 * Presets switch the features they do not cover OFF (the team inbox preset
 * turns campaigns off, the marketing preset leaves the inbox at its default),
 * so a union has to be taken flag by flag: a feature is on when any of the
 * answer's presets turns it on. The result goes through `resolveFlags` so it is
 * dependency-consistent, exactly like a preset picked by hand.
 *
 * `aiDrafts` only applies to answers that include answering email; the
 * newsletters-only answer ignores it.
 */
export function outcomeFlags(
	outcome: SetupOutcome,
	aiDrafts: boolean,
	opts: { hosted?: boolean } = {}
): FeatureFlagState {
	const merged: Record<string, boolean> = {};
	for (const preset of outcomePresets(outcome, aiDrafts)) {
		for (const [key, on] of Object.entries(operatingModeFlags(preset, opts))) {
			merged[key] = merged[key] === true || on === true;
		}
	}
	return resolveFlags(merged as FeatureFlagState, opts);
}
