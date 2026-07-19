import { describe, it, expect } from 'vitest';
import { rollUpDeliveryHealth, type DeliveryHealthInputs } from '../health';

/** A fully-healthy baseline: provider configured, all domains verified, low risk. */
const HEALTHY: DeliveryHealthInputs = {
	reputationRisk: 'low',
	domainStatuses: ['verified', 'verified'],
	canSend: true,
	mtaInfrastructure: null,
};

describe('rollUpDeliveryHealth', () => {
	it('is ok when every dimension is healthy', () => {
		const r = rollUpDeliveryHealth(HEALTHY);
		expect(r.level).toBe('ok');
	});

	it('treats no-activity reputation (null) as ok', () => {
		expect(rollUpDeliveryHealth({ ...HEALTHY, reputationRisk: null }).level).toBe('ok');
	});

	// --- provider dimension ---
	it('errors when no provider is configured', () => {
		const r = rollUpDeliveryHealth({ ...HEALTHY, canSend: false });
		expect(r.level).toBe('error');
		expect(r.reason).toMatch(/provider/i);
	});

	// --- built-in MTA infrastructure dimension ---
	it('errors when the MTA infrastructure is degraded', () => {
		const r = rollUpDeliveryHealth({ ...HEALTHY, mtaInfrastructure: 'degraded' });
		expect(r.level).toBe('error');
		expect(r.reason).toMatch(/infrastructure/i);
	});

	it('warns when the MTA health snapshot is stale', () => {
		const r = rollUpDeliveryHealth({ ...HEALTHY, mtaInfrastructure: 'stale' });
		expect(r.level).toBe('warn');
		expect(r.reason).toMatch(/stale/i);
	});

	// --- domain dimension ---
	it('errors on a failed domain', () => {
		const r = rollUpDeliveryHealth({ ...HEALTHY, domainStatuses: ['verified', 'failed'] });
		expect(r.level).toBe('error');
		expect(r.reason).toMatch(/domain/i);
	});

	it('warns on a pending domain', () => {
		const r = rollUpDeliveryHealth({ ...HEALTHY, domainStatuses: ['verified', 'pending'] });
		expect(r.level).toBe('warn');
		expect(r.reason).toMatch(/verified yet/i);
	});

	it('warns on a registering domain', () => {
		expect(rollUpDeliveryHealth({ ...HEALTHY, domainStatuses: ['registering'] }).level).toBe(
			'warn'
		);
	});

	it('is ok with zero configured domains', () => {
		expect(rollUpDeliveryHealth({ ...HEALTHY, domainStatuses: [] }).level).toBe('ok');
	});

	// --- reputation dimension ---
	it('errors on critical reputation', () => {
		const r = rollUpDeliveryHealth({ ...HEALTHY, reputationRisk: 'critical' });
		expect(r.level).toBe('error');
		expect(r.reason).toMatch(/reputation/i);
	});

	it('warns on high reputation risk', () => {
		expect(rollUpDeliveryHealth({ ...HEALTHY, reputationRisk: 'high' }).level).toBe('warn');
	});

	it('warns on medium reputation risk', () => {
		expect(rollUpDeliveryHealth({ ...HEALTHY, reputationRisk: 'medium' }).level).toBe('warn');
	});

	// --- worst-of across dimensions ---
	it('takes the worst level across all three inputs', () => {
		// warn reputation + error domain -> error overall
		const r = rollUpDeliveryHealth({
			reputationRisk: 'high',
			domainStatuses: ['failed'],
			canSend: true,
			mtaInfrastructure: null,
		});
		expect(r.level).toBe('error');
	});

	it('surfaces a warn when the only issue is a pending domain', () => {
		const r = rollUpDeliveryHealth({
			reputationRisk: 'low',
			domainStatuses: ['pending'],
			canSend: true,
			mtaInfrastructure: null,
		});
		expect(r.level).toBe('warn');
	});

	it('resolves same-severity ties to the provider first (most actionable)', () => {
		// provider error AND reputation critical are both errors: provider wins the reason.
		const r = rollUpDeliveryHealth({
			reputationRisk: 'critical',
			domainStatuses: ['verified'],
			canSend: false,
			mtaInfrastructure: null,
		});
		expect(r.level).toBe('error');
		expect(r.reason).toMatch(/provider/i);
	});
});
