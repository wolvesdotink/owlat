/**
 * The MTA's wire-version report: a signed POST of this replica's process to
 * `/webhooks/mta-worker-report`, the backend's answer parsed, a non-2xx or an
 * unexpected body thrown so the reporter logs it and tries again.
 */
import { describe, expect, it, vi } from 'vitest';
import { MTA_SIGNATURE_HEADER, MTA_TIMESTAMP_HEADER } from '@owlat/mta-protocol/signature';
import { signMtaRequest } from '@owlat/mta-protocol/signer';
import { sendMtaWireReport } from '../wireReport.js';

const config = { convexSiteUrl: 'https://convex.owlat.example', webhookSecret: 'mta-test-secret' };
const report = {
	instanceId: 'proc-1',
	hostLabel: 'mta-1',
	owlatVersion: '0.6.17',
	wireVersion: 1,
	startedAt: 1,
};

function answer(status: number, body: unknown) {
	return vi.fn(
		async () => new Response(JSON.stringify(body), { status })
	) as unknown as typeof fetch;
}

describe('sendMtaWireReport', () => {
	it('posts the signed report and returns the backend contract', async () => {
		const fetchImpl = answer(200, {
			backendWireVersion: 1,
			minSupportedWireVersion: 0,
			compatible: true,
		});
		expect(await sendMtaWireReport(config, report, fetchImpl)).toEqual({
			backendWireVersion: 1,
			minSupportedWireVersion: 0,
			compatible: true,
		});

		const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
		expect(url).toBe('https://convex.owlat.example/webhooks/mta-worker-report');
		expect(JSON.parse(init.body)).toEqual(report);
		const headers = init.headers as Record<string, string>;
		// Signed over the exact body it sent, at the timestamp it sent.
		const timestamp = Number(headers[MTA_TIMESTAMP_HEADER]) * 1000;
		expect(headers[MTA_SIGNATURE_HEADER]).toBe(
			signMtaRequest(config.webhookSecret, init.body, timestamp)[MTA_SIGNATURE_HEADER]
		);
	});

	it('throws on a refusal or an unexpected body', async () => {
		await expect(sendMtaWireReport(config, report, answer(404, {}))).rejects.toThrow('HTTP 404');
		await expect(
			sendMtaWireReport(config, report, answer(200, { compatible: 'yes' }))
		).rejects.toThrow('unexpected body');
	});
});
