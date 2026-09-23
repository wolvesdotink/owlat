/**
 * The AI replies page's one top control — Draft only / Send automatically when
 * confident / Off — mapped onto the settings that actually decide it.
 *
 * Three stored settings gate an unattended reply, and they used to live on
 * separate pages:
 *   - the `ai.agent` feature flag: does the AI draft at all (Off when false);
 *   - `agentConfig.isShadowMode` (unset = on): while on, the route step logs a
 *     would-have-sent observation and routes EVERY reply to review, whatever
 *     the tiers below decide;
 *   - the send tiers: per-category rules when `ai.autonomy` is on, otherwise
 *     the global `isAutoReplyEnabled` + confidence threshold + daily limit.
 *
 * So a reply can leave unattended only when the agent is on, shadow is
 * explicitly off, and one of the tiers is armed. Anything else is Draft only —
 * which is how existing deployments read (none of them could leave shadow mode
 * from the UI), with no data migration.
 */

export type AiReplyMode = 'off' | 'draft' | 'auto';

export const AI_REPLY_MODES: readonly AiReplyMode[] = ['draft', 'auto', 'off'];

export interface AiReplySettings {
	/** `ai.agent` resolved. */
	agentEnabled: boolean;
	/** `ai.autonomy` resolved — per-category rules. */
	rulesEnabled: boolean;
	/** The agentConfig row, or null before one exists. */
	config: { isAutoReplyEnabled?: boolean; isShadowMode?: boolean } | null | undefined;
}

export function deriveAiReplyMode(settings: AiReplySettings): AiReplyMode {
	if (!settings.agentEnabled) return 'off';
	const shadowOff = settings.config?.isShadowMode === false;
	const tierArmed = settings.config?.isAutoReplyEnabled === true || settings.rulesEnabled;
	return shadowOff && tierArmed ? 'auto' : 'draft';
}

/** One write the page performs to move to a mode, in order. */
export type AiReplyModeStep =
	| { kind: 'agentFlag'; value: boolean }
	| { kind: 'replyMode'; mode: 'draft' | 'auto' };

/**
 * The writes that move from the current settings to `target`, in order.
 *
 * Turning off stops sending first (`draft` pulls back replies waiting out their
 * undo window) and only then turns the agent off, so coming back from Off
 * always lands on Draft only. Turning on enables the agent before arming the
 * send mode, so the mode is never set on a pipeline that isn't running.
 */
export function planAiReplyModeChange(
	settings: AiReplySettings,
	target: AiReplyMode
): AiReplyModeStep[] {
	const current = deriveAiReplyMode(settings);
	if (current === target) return [];

	if (target === 'off') {
		return [
			{ kind: 'replyMode', mode: 'draft' },
			{ kind: 'agentFlag', value: false },
		];
	}

	const steps: AiReplyModeStep[] = [];
	if (!settings.agentEnabled) steps.push({ kind: 'agentFlag', value: true });
	steps.push({ kind: 'replyMode', mode: target });
	return steps;
}
