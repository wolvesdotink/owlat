/**
 * Calibration stamps and the block-only verdict rule (ADR-0060 §8, ADR-0073
 * §8, plan Phase 4). Pure and isolate-safe.
 *
 * A decision verdict may feed the auto-send path only with compatible adapter
 * provenance and a valid task/language calibration stamp. "Valid" means the
 * artifact names the calibration revision that is checked in for its task and
 * language today. No report has been run against a real provider yet (SPEC §2
 * keeps that out of this release), so the registry is empty and every verdict
 * is uncalibrated. The gate therefore refuses any verdict that reaches it, and
 * none reaches it: {@link AUTO_SEND_VERDICT_TASKS} is empty.
 */

import type { AiTaskName } from '@owlat/shared/aiRouting';

/**
 * Checked-in calibration revisions, task → language → revision. A revision
 * names the held-out report (`mail/interpret/__eval__/baseline/report.json`)
 * whose thresholds the task's verdicts may use. Empty until a real run exists.
 */
export const CALIBRATION_REVISIONS: Readonly<
	Partial<Record<AiTaskName, Readonly<Record<string, string>>>>
> = {};

/** The revision a verdict for `task` in `language` is calibrated against, if any. */
export function calibrationRevisionFor(
	task: AiTaskName,
	language: string | undefined,
	registry: typeof CALIBRATION_REVISIONS = CALIBRATION_REVISIONS
): string | undefined {
	return language === undefined ? undefined : registry[task]?.[language];
}

/**
 * The decision tasks whose verdicts feed the auto-send path. EMPTY: no
 * decision output feeds auto-send in this release (D9). The writer lane's
 * auto-send contract adds a task here when a verdict starts feeding
 * `resolveAutoApproveScore`, and the gate then checks every such verdict.
 */
export const AUTO_SEND_VERDICT_TASKS: readonly AiTaskName[] = [];

/** The fields of a stored artifact the rule reads. */
export interface StoredVerdict {
	readonly task: AiTaskName;
	readonly kind: 'advisory' | 'shadow';
	readonly status: string;
	readonly policyVersion: number;
	readonly contextVersion?: string;
	readonly invalidatedAt?: number;
	readonly expiresAt: number;
	readonly provenance?: { readonly provider: string };
	readonly calibration?: {
		readonly isAdapterCalibrated: boolean;
		readonly calibrationRevision?: string;
		readonly language?: string;
	};
}

/** What the verdict is compared with at send time. */
export interface VerdictContext {
	readonly now: number;
	readonly policyVersion: number;
	/** `lib/decision/configIdentity.ts` of the decision plane configured now. */
	readonly decisionConfigIdentity: string;
	/** The message's sanitized language, when the classifier gave one. */
	readonly language: string | undefined;
	readonly registry?: typeof CALIBRATION_REVISIONS;
}

/**
 * Why a verdict must not feed auto-send, or null when it may. Block-only: a
 * null here never makes anything eligible, it only fails to block.
 */
export function verdictBlockReason(verdict: StoredVerdict, context: VerdictContext): string | null {
	if (verdict.kind !== 'advisory') return 'a shadow observation never feeds auto-send';
	if (verdict.status !== 'complete') return 'the verdict is not complete';
	if (verdict.invalidatedAt !== undefined) return 'the verdict was invalidated';
	if (verdict.expiresAt <= context.now) return 'the verdict has expired';
	if (verdict.policyVersion !== context.policyVersion) {
		return 'the verdict predates the current routing policy';
	}
	// The identity the answer was stamped with, AND the adapter that actually
	// answered, must both be the plane configured now (`kind|model|origin`).
	const configuredKind = context.decisionConfigIdentity.split('|')[0];
	if (
		verdict.provenance === undefined ||
		verdict.contextVersion !== context.decisionConfigIdentity ||
		verdict.provenance.provider !== configuredKind
	) {
		return 'the verdict came from a different decision provider than the one configured now';
	}
	if (verdict.calibration?.isAdapterCalibrated !== true) {
		return 'the verdict came from an uncalibrated adapter';
	}
	const language = verdict.calibration.language;
	if (language === undefined || language !== context.language) {
		return 'the verdict has no calibration for this message’s language';
	}
	const revision = calibrationRevisionFor(verdict.task, language, context.registry);
	if (revision === undefined || verdict.calibration.calibrationRevision !== revision) {
		return 'the verdict has no valid calibration for its task and language';
	}
	return null;
}
