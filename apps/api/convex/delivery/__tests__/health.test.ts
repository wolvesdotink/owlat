import { describe, it, expect } from 'vitest';
import { rollUpDeliveryHealth, type DeliveryHealthInputs } from '../health';
import { DELIVERY_HEALTH_REASONS, type DeliveryHealthReason } from '../healthCopy';

/** A fully-healthy baseline: provider configured, all domains verified, low risk. */
const HEALTHY: DeliveryHealthInputs = {
	reputationRisk: 'low',
	domainStatuses: ['verified', 'verified'],
	canSend: true,
	mtaInfrastructure: null,
};

/**
 * One input per sentence the roll-up can say. The roll-up is printed on
 * translated surfaces, so every path names a catalog reason, never English.
 */
const REASON_PATHS: ReadonlyArray<{
	inputs: Partial<DeliveryHealthInputs>;
	level: 'ok' | 'warn' | 'error';
	reasonCode: DeliveryHealthReason;
	reasonParams?: Record<string, string>;
}> = [
	{ inputs: {}, level: 'ok', reasonCode: 'healthy' },
	{ inputs: { canSend: false }, level: 'error', reasonCode: 'no_provider' },
	{
		inputs: { streamsWithoutTransport: ['transactional'] },
		level: 'error',
		reasonCode: 'no_provider_transactional',
	},
	{
		inputs: { streamsWithoutTransport: ['campaign'] },
		level: 'error',
		reasonCode: 'no_provider_campaign',
	},
	{
		inputs: { streamsWithoutFeedback: ['campaign'] },
		level: 'error',
		reasonCode: 'feedback_missing_campaign',
	},
	{
		inputs: { streamsWithoutFeedback: ['transactional'] },
		level: 'warn',
		reasonCode: 'feedback_missing_transactional',
	},
	{
		inputs: {
			mtaInfrastructure: 'signing_held',
			heldSigningDomains: ['example.com', 'example.org'],
		},
		level: 'error',
		reasonCode: 'mta_signing_held',
		reasonParams: { domains: 'example.com, example.org' },
	},
	{
		inputs: { mtaInfrastructure: 'signing_held' },
		level: 'error',
		reasonCode: 'mta_signing_held_unnamed',
	},
	{ inputs: { mtaInfrastructure: 'degraded' }, level: 'error', reasonCode: 'mta_degraded' },
	{ inputs: { mtaInfrastructure: 'unreachable' }, level: 'error', reasonCode: 'mta_unreachable' },
	{ inputs: { mtaInfrastructure: 'stale' }, level: 'warn', reasonCode: 'mta_stale' },
	{ inputs: { mtaInfrastructure: 'unchecked' }, level: 'warn', reasonCode: 'mta_unchecked' },
	{ inputs: { sendingIps: 'all_held' }, level: 'error', reasonCode: 'ips_all_held' },
	{ inputs: { sendingIps: 'some_held' }, level: 'warn', reasonCode: 'ips_some_held' },
	{
		inputs: { domainStatuses: ['verified', 'failed'] },
		level: 'error',
		reasonCode: 'domain_failed',
	},
	{ inputs: { domainStatuses: [] }, level: 'error', reasonCode: 'no_domain' },
	{
		inputs: { domainStatuses: ['pending', 'registering'] },
		level: 'error',
		reasonCode: 'no_verified_domain',
	},
	{
		inputs: { domainStatuses: ['verified', 'pending'] },
		level: 'warn',
		reasonCode: 'domain_pending',
	},
	{ inputs: { transactionalSender: 'missing' }, level: 'error', reasonCode: 'sender_missing' },
	{
		inputs: { transactionalSender: 'unverified' },
		level: 'error',
		reasonCode: 'sender_unverified',
	},
	{ inputs: { isWarmupHalted: true }, level: 'warn', reasonCode: 'warmup_halted' },
	{ inputs: { reputationRisk: 'critical' }, level: 'error', reasonCode: 'reputation_critical' },
	{ inputs: { reputationRisk: 'high' }, level: 'warn', reasonCode: 'reputation_high' },
	{ inputs: { reputationRisk: 'medium' }, level: 'warn', reasonCode: 'reputation_medium' },
];

describe('rollUpDeliveryHealth', () => {
	it.each(REASON_PATHS)('names $reasonCode as a code ($level)', (path) => {
		expect(rollUpDeliveryHealth({ ...HEALTHY, ...path.inputs })).toEqual({
			level: path.level,
			reasonCode: path.reasonCode,
			...(path.reasonParams ? { reasonParams: path.reasonParams } : {}),
		});
	});

	it('reaches every reason in the catalog, and no other', () => {
		const reached = new Set(REASON_PATHS.map((path) => path.reasonCode));
		expect([...reached].sort()).toEqual([...DELIVERY_HEALTH_REASONS].sort());
	});

	it('returns no English sentence for a client to print', () => {
		for (const path of REASON_PATHS) {
			expect(rollUpDeliveryHealth({ ...HEALTHY, ...path.inputs })).not.toHaveProperty('reason');
		}
	});

	it('treats no-activity reputation (null) as ok', () => {
		expect(rollUpDeliveryHealth({ ...HEALTHY, reputationRisk: null }).level).toBe('ok');
	});

	it('warns on a registering domain next to a verified one', () => {
		expect(
			rollUpDeliveryHealth({ ...HEALTHY, domainStatuses: ['verified', 'registering'] }).level
		).toBe('warn');
	});

	it('treats ready sending IPs as ok', () => {
		expect(rollUpDeliveryHealth({ ...HEALTHY, sendingIps: 'ready' }).level).toBe('ok');
	});

	// --- worst-of across dimensions ---
	it('takes the worst level across all inputs', () => {
		const r = rollUpDeliveryHealth({
			reputationRisk: 'high',
			domainStatuses: ['failed'],
			canSend: true,
			mtaInfrastructure: null,
		});
		expect(r).toEqual({ level: 'error', reasonCode: 'domain_failed' });
	});

	it('resolves same-severity ties to the provider first (most actionable)', () => {
		// provider error AND reputation critical are both errors: provider wins the reason.
		const r = rollUpDeliveryHealth({
			reputationRisk: 'critical',
			domainStatuses: ['verified'],
			canSend: false,
			mtaInfrastructure: null,
		});
		expect(r).toEqual({ level: 'error', reasonCode: 'no_provider' });
	});
});
