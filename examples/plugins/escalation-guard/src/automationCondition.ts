/**
 * Tier-1 automation condition contribution (`automationConditions`).
 *
 * Conditions are synchronous, side-effect-free predicates over a bounded contact
 * snapshot. This one answers "is this contact a priority account?" by matching
 * the contact's email domain against an operator-configured list, so an
 * escalation automation can branch between the priority path and the standard
 * path without the plugin ever seeing a tenant id or a Convex document.
 */

import type {
	PluginAutomationConditionInput,
	PluginAutomationConditionModule,
} from '@owlat/plugin-kit';
import { EscalationConfigError } from './automationTrigger';

export const PRIORITY_ACCOUNT_CONDITION_LOCAL_ID = 'priority-account';

/** Upper bound on the configured domain list; keeps evaluation O(1)-ish and bounded. */
export const MAX_PRIORITY_DOMAINS = 200;

export interface PriorityAccountConfig {
	/** Lowercased, de-duplicated bare domains, for example `acme.example`. */
	readonly domains: readonly string[];
}

const DOMAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

function readOwnValue(raw: object, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(raw, key);
	return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

/**
 * Strictly parse the persisted condition config. Every domain must be a
 * syntactically valid, already-lowercase bare domain; the list is bounded and
 * de-duplicated. Anything else throws, and the host treats a throwing condition
 * as "not matched" rather than silently taking the priority branch.
 */
export function parsePriorityAccountConfig(raw: unknown): PriorityAccountConfig {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new EscalationConfigError('Priority-account config must be a plain object');
	}
	const prototype = Object.getPrototypeOf(raw);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new EscalationConfigError('Priority-account config must be a plain object');
	}
	const domains = readOwnValue(raw, 'domains');
	if (!Array.isArray(domains) || domains.length === 0 || domains.length > MAX_PRIORITY_DOMAINS) {
		throw new EscalationConfigError(
			`Priority-account config requires 1 to ${MAX_PRIORITY_DOMAINS} domains`
		);
	}
	const unique = new Set<string>();
	for (const domain of domains) {
		if (typeof domain !== 'string' || domain.length > 253 || !DOMAIN.test(domain)) {
			throw new EscalationConfigError(
				'Priority-account domains must be lowercase bare domain names'
			);
		}
		unique.add(domain);
	}
	return { domains: Object.freeze([...unique]) };
}

/** The domain of an email address, lowercased; empty when the address is malformed. */
export function emailDomain(email: string): string {
	const separator = email.lastIndexOf('@');
	if (separator < 1 || separator === email.length - 1) return '';
	return email.slice(separator + 1).toLowerCase();
}

export const priorityAccountCondition: PluginAutomationConditionModule<PriorityAccountConfig> = {
	parseConfig: parsePriorityAccountConfig,

	evaluate(input: PluginAutomationConditionInput, config: PriorityAccountConfig): boolean {
		const domain = emailDomain(input.contactEmail);
		return domain.length > 0 && config.domains.includes(domain);
	},
};
