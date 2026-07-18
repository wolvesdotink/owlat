import type { PluginCronServices, PluginLlmGenerateResult } from '@owlat/plugin-kit';
import { describe, expect, it, vi } from 'vitest';
import { createDeliverabilityTipCron, TIP_LOG_MAX_LENGTH } from '../cron';
import {
	buildDeliverabilityTipRequest,
	deliverabilityTipTopic,
	DELIVERABILITY_TIP_TOPICS,
} from '../insights';

function fakeServices(
	overrides: {
		readonly text?: string;
		readonly aborted?: boolean;
		readonly onGenerate?: () => void;
	} = {}
): { services: PluginCronServices; logs: Array<{ message: string; fields?: unknown }> } {
	const controller = new AbortController();
	if (overrides.aborted) controller.abort();
	const logs: Array<{ message: string; fields?: unknown }> = [];
	const services: PluginCronServices = {
		signal: controller.signal,
		logger: {
			debug: () => undefined,
			info: (message, fields) => logs.push({ message, fields }),
			warn: () => undefined,
			error: () => undefined,
		},
		llm: {
			generate: async (): Promise<PluginLlmGenerateResult> => {
				overrides.onGenerate?.();
				return { text: overrides.text ?? 'Authenticate your mail with SPF and DKIM.' };
			},
		},
	};
	return { services, logs };
}

describe('deliverabilityTipTopic', () => {
	it('is deterministic and wraps the rotation index over the topic set', () => {
		expect(deliverabilityTipTopic(0)).toBe(DELIVERABILITY_TIP_TOPICS[0]);
		expect(deliverabilityTipTopic(DELIVERABILITY_TIP_TOPICS.length)).toBe(
			DELIVERABILITY_TIP_TOPICS[0]
		);
		expect(deliverabilityTipTopic(-1)).toBe(
			DELIVERABILITY_TIP_TOPICS[DELIVERABILITY_TIP_TOPICS.length - 1]
		);
	});

	it('builds a budgeted fast-tier request naming the rotation topic', () => {
		const request = buildDeliverabilityTipRequest(0);
		expect(request.tier).toBe('fast');
		expect(request.prompt).toContain(DELIVERABILITY_TIP_TOPICS[0]);
	});
});

describe('refresh-seed-scores cron', () => {
	it('generates a tip through the attributed dispatch and logs the clamped text', async () => {
		const { services, logs } = fakeServices({ text: 'Use a plain-text alternative.' });
		await createDeliverabilityTipCron({ rotation: 2 }).run(services);
		expect(logs).toHaveLength(1);
		expect(logs[0]?.message).toContain('Deliverability tip');
	});

	it('clamps untrusted model output before logging it', async () => {
		const { services, logs } = fakeServices({ text: 'x'.repeat(TIP_LOG_MAX_LENGTH + 200) });
		await createDeliverabilityTipCron().run(services);
		const fields = logs[0]?.fields as { tip: string } | undefined;
		expect(fields).toBeDefined();
		expect((fields?.tip ?? '').length).toBeLessThanOrEqual(TIP_LOG_MAX_LENGTH);
	});

	it('does no work and calls no model when the run is already cancelled', async () => {
		const generate = vi.fn();
		const { services, logs } = fakeServices({ aborted: true, onGenerate: generate });
		await createDeliverabilityTipCron().run(services);
		expect(generate).not.toHaveBeenCalled();
		expect(logs).toHaveLength(0);
	});
});
