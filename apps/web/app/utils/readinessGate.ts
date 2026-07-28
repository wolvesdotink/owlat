/**
 * The readiness GATE vocabulary — one gate's shape, shared by every module that
 * produces one.
 *
 * It lives in its own module rather than in `deliveryReadiness.ts` because the
 * gate producers and the gate assembler would otherwise import each other:
 * `deliveryReadiness.ts` folds the gates into the panel's verdict, while
 * `dualArmAlignment.ts` produces one of them. That cycle is why the dual-arm gate
 * used to re-declare all seven fields structurally — two copies of one contract
 * that the compiler could not keep in step. There is now exactly one.
 *
 * Pure types: no Convex client, no DOM.
 */

import type { HealthTone } from '~/utils/healthTone';

/**
 * The readiness gates, in the order the panel renders them. `mta-sts` is a
 * conditional gate — it appears only when the deployment is publishing an
 * MTA-STS policy in `enforce` mode whose DNS/policy isn't verified yet, so that
 * an unfinished inbound-TLS hardening step is surfaced without adding noise to
 * deployments that don't publish a policy. `dual-arm-alignment` is conditional
 * for the mirror-image reason: a deployment with no reference transport has
 * nothing to align, so the gate is not rendered at all (D2).
 */
export type ReadinessGateKey =
	| 'transport'
	| 'domain'
	| 'authentication'
	| 'alignment'
	| 'dual-arm-alignment'
	| 'mta-sts';

/**
 * A gate's state:
 *  - `ready`     — satisfied.
 *  - `attention` — needs an action from the operator (a fix link is offered).
 *  - `pending`   — waiting on something external (DNS propagation) or not yet
 *                  applicable; no action the operator can take right now.
 */
export type ReadinessGateStatus = 'ready' | 'attention' | 'pending';

export interface ReadinessGate {
	key: ReadinessGateKey;
	/** Human title of the gate. */
	title: string;
	/** One plain-language line on where this gate stands. No jargon, no lecture. */
	detail: string;
	status: ReadinessGateStatus;
	/** Shared health tone → token classes (see `healthTone.ts`). */
	tone: HealthTone;
	/** In-app route that resolves this gate, or `null` when there's nothing to do. */
	actionHref: string | null;
	/** Label for the fix link, or `null` when `actionHref` is `null`. */
	actionLabel: string | null;
}
