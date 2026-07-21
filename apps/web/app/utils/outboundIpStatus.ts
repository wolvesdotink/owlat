import {
	fcrdnsReasonMessage,
	reverseDnsGuidance,
	type FcrdnsFailureReason,
	type FcrdnsVerdict,
} from '@owlat/shared/fcrdns';
import type { HealthTone } from './healthTone';

export interface OutboundIpIdentityInput {
	active: boolean;
	fcrdns?: {
		verdict: string;
		isGenericPtr: boolean;
		isOverridden: boolean;
		ptrNames: string[];
		reason?: string;
	} | null;
}

export interface OutboundIpPresentation {
	tone: HealthTone;
	label: string;
	detail: string;
	remediation: string | null;
}

export function outboundIpPresentation(ip: OutboundIpIdentityInput): OutboundIpPresentation {
	const identity = ip.fcrdns;
	let tone: HealthTone;
	let label: string;
	if (identity?.isOverridden) {
		tone = 'warning';
		label = 'Lab override';
	} else if (!ip.active) {
		tone = 'error';
		label = 'Quarantined';
	} else if (!identity || identity.verdict === 'error') {
		tone = 'error';
		label = 'Not verified';
	} else if (identity.verdict === 'warn') {
		tone = 'warning';
		label = 'Needs attention';
	} else {
		tone = 'success';
		label = 'Ready';
	}

	const detail = !identity
		? 'Waiting for the first live reverse-DNS check.'
		: identity.isGenericPtr
			? 'Forward DNS is valid, but this provider-default PTR can hurt sending reputation.'
			: fcrdnsReasonMessage(identity.reason as FcrdnsFailureReason | undefined);
	const remediation =
		identity && identity.verdict !== 'pass' && identity.verdict !== 'warn'
			? reverseDnsGuidance(identity.ptrNames).instruction
			: null;

	return { tone, label, detail, remediation };
}

/** Narrow untrusted/string-backed Convex data without lying to the presenter. */
export function isFcrdnsVerdict(value: string): value is FcrdnsVerdict {
	return value === 'pass' || value === 'warn' || value === 'fail' || value === 'error';
}
