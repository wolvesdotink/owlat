/**
 * Provider-level metering for streams. `streamText` makes its own
 * provider requests: one per step, and the SDK re-sends a failed opening
 * request on its own. Neither is visible from the stream the caller reads, and
 * a caller's callback that throws mid-stream ends the read before the SDK's
 * `finish-step` arrives. So the model itself is wrapped: every `doStream` call
 * is one request on the meter, opened when the request is made, closed with
 * the usage the provider reported in its own `finish` part, and closed as
 * failed when it threw or never finished.
 *
 * The provider stream is teed and the meter's branch is read eagerly, so the
 * provider's `finish` is seen however far the SDK's reader (and the caller's
 * callbacks behind it) got. A reader that stops early waits a moment for the
 * branches to drain ({@link StreamMeter.settle}) before anything is aborted:
 * aborting first would discard a `finish` the provider already sent.
 *
 * Pure of 'use node' (the AI SDK's middleware is runtime-neutral).
 */

import { wrapLanguageModel, type LanguageModel } from 'ai';
import type { TokenUsage } from '../../agent/steps/types';
import { addTokenUsage } from './tokenUsage';
import { providerReportedUsage, type ProviderUsageV3 } from './providerUsage';
import { startRequest, type LlmCallMeter, type LlmRequestInput } from './requestMeter';

type LanguageModelV3 = Extract<LanguageModel, { specificationVersion: 'v3' }>;
type RequestBase = Pick<LlmRequestInput, 'modelUsed' | 'endpoint' | 'isLocalEngine'>;

export interface StreamMeter {
	/** The model to stream from: wrapped when it can be, otherwise as given. */
	readonly model: LanguageModel;
	/** True when every provider request is metered at the provider boundary. */
	readonly isProviderLevel: boolean;
	/** Usage the provider reported on finished requests, whatever the reader did. */
	spent(): TokenUsage | undefined;
	/** Wait, at most `maxWaitMs`, for every request's own branch to finish reading. */
	settle(maxWaitMs: number): Promise<void>;
	/** Close every request still open (the read ended early) as failed. */
	closeOpen(): void;
}

/** How long a reader that stopped early waits for the provider's own report. */
export const STREAM_SETTLE_MS = 2_000;

function isLanguageModelV3(model: LanguageModel): model is LanguageModelV3 {
	return typeof model === 'object' && model !== null && model.specificationVersion === 'v3';
}

/** Wrap `model` so each of its stream requests is one request on `meter`. */
export function meterStreamModel(
	model: LanguageModel,
	meter: LlmCallMeter | undefined,
	requestBase: RequestBase
): StreamMeter {
	let spent: TokenUsage | undefined;
	const open = new Set<() => void>();
	const drains = new Set<Promise<void>>();
	const base: StreamMeter = {
		model,
		isProviderLevel: false,
		spent: () => spent,
		settle: async (maxWaitMs) => {
			if (drains.size === 0) return;
			let timer: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([
				Promise.allSettled(drains),
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, maxWaitMs);
				}),
			]);
			if (timer) clearTimeout(timer);
		},
		closeOpen: () => {
			for (const close of open) close();
		},
	};
	if (!isLanguageModelV3(model)) return base;

	const openRequest = () => {
		const finish = startRequest(meter);
		let isClosed = false;
		const close = (input: Omit<LlmRequestInput, 'latencyMs'>) => {
			if (isClosed) return;
			isClosed = true;
			open.delete(failOpen);
			finish(input);
		};
		const failOpen = () => close({ ...requestBase, outcome: 'failed' });
		open.add(failOpen);
		return { close, failOpen };
	};

	return {
		...base,
		isProviderLevel: true,
		model: wrapLanguageModel({
			model,
			middleware: {
				specificationVersion: 'v3',
				wrapStream: async ({ doStream }) => {
					const request = openRequest();
					let result;
					try {
						result = await doStream();
					} catch (error) {
						request.failOpen();
						throw error;
					}
					const [forSdk, forMeter] = result.stream.tee();
					const drain = (async () => {
						const reader = forMeter.getReader();
						try {
							for (;;) {
								const { done, value: part } = await reader.read();
								if (done) return;
								if (part.type !== 'finish') continue;
								const reported = providerReportedUsage(part.usage as ProviderUsageV3);
								if (reported) spent = addTokenUsage(spent, reported.usage);
								request.close({
									...requestBase,
									outcome: 'ok',
									...(reported ? { usage: reported.usage, ...reported.details } : {}),
								});
							}
						} catch {
							// The provider stream failed or was aborted: the request stays open,
							// and closes as failed with the call.
						}
					})();
					drains.add(drain);
					void drain.finally(() => drains.delete(drain));
					const stream = forSdk;
					return { ...result, stream };
				},
			},
		}),
	};
}
