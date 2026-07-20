/**
 * Escalation Guard — the maintained TIER-1 reference plugin.
 *
 * Tier 1 is the bundled, in-process tier: the plugin ships inside the Owlat
 * build, its contributions are resolved by the generated composition at codegen
 * time, and it makes no outbound call and runs no sandboxed job. This reference
 * exercises the Tier-1 contribution points the other two references do not:
 *
 *   - `agentSteps` (`./agentStep`) — a restrict-only post-draft step that can
 *     only route a reply to a human (`drafting -> draft_ready`);
 *   - `draftStrategies` (`./draftStrategy`) — a conservative acknowledgement
 *     written through the attributed, budgeted host LLM dispatch;
 *   - `automationTriggers` / `automationConditions` / `automationSteps`
 *     (`./automationTrigger`, `./automationCondition`, `./automationStep`) —
 *     the three automation registries, each with a strict `parseConfig`;
 *   - `webhookEvents` (`./webhookEvent`) — a namespaced, content-free event;
 *   - `navItems` / `settingsPanels` — bundled UI entries behind the flag.
 *
 * Every module is runtime-neutral and individually testable; the only wire is
 * the manifest plus the `@owlat/plugin-kit` contribution contracts.
 */

export { ESCALATION_GUARD_PLUGIN_ID } from './constants';
export { escalationGuardPlugin, ESCALATION_GUARD_DAILY_LLM_BUDGET_USD } from './manifest';

export {
	detectEscalation,
	meetsLevel,
	summarizeVerdict,
	worstLevel,
	MAX_SCAN_LENGTH,
	MAX_SIGNALS,
	type EscalationCandidate,
	type EscalationLevel,
	type EscalationSignal,
	type EscalationVerdict,
} from './detector';

export {
	createEscalationAgentStep,
	escalationAgentStep,
	ESCALATION_REASON_MAX_LENGTH,
	ESCALATION_STEP_LOCAL_ID,
	type EscalationStepConfig,
} from './agentStep';

export {
	buildAcknowledgementPrompt,
	carefulAcknowledgementStrategy,
	EscalationDraftError,
	CAREFUL_ACKNOWLEDGEMENT_LOCAL_ID,
	CAREFUL_ACKNOWLEDGEMENT_TIMEOUT_MS,
	DRAFT_BODY_MAX_LENGTH,
	PROMPT_FIELD_MAX_LENGTH,
} from './draftStrategy';

export {
	escalationTrigger,
	EscalationConfigError,
	parseEscalationTriggerConfig,
	ESCALATION_TRIGGER_LOCAL_ID,
	type EscalationTriggerConfig,
} from './automationTrigger';

export {
	emailDomain,
	parsePriorityAccountConfig,
	priorityAccountCondition,
	MAX_PRIORITY_DOMAINS,
	PRIORITY_ACCOUNT_CONDITION_LOCAL_ID,
	type PriorityAccountConfig,
} from './automationCondition';

export {
	parseRequireOwnerConfig,
	requireOwnerStep,
	ASSIGN_OWNER_STEP_LOCAL_ID,
	MAX_PROPERTY_KEY_LENGTH,
	type RequireOwnerConfig,
} from './automationStep';

export {
	buildEscalationEventPayload,
	ESCALATION_EVENT_KIND,
	ESCALATION_EVENT_LOCAL_ID,
	MAX_EVENT_SIGNALS,
	type EscalationEventPayload,
} from './webhookEvent';

export { clampUntrustedText } from './untrustedText';
