/**
 * Where an inbound channel webhook's verification secret comes from.
 *
 * The three channel adapters (`./adapters/{twilio,meta,generic}.ts`) run in v8
 * http actions and cannot decrypt the stored credential envelope themselves
 * (`node:crypto`), so this module is the seam: it calls the Node-side vault
 * action and falls back to the deployment environment variable.
 *
 * PRECEDENCE — stored credential first, env var second. The credentials an
 * operator types into Settings → Channels are the ones the product tells them
 * are in force, so they must win; the env vars stay as the fallback for
 * deployments configured before per-channel credentials existed, and so that
 * rotating a secret in the provider console can be answered from either place.
 * When NEITHER has a value the adapter fails closed with a 503 — an inbound
 * channel is never accepted unsigned.
 */

import { internal } from '../_generated/api';
import type { ActionCtx } from '../_generated/server';
import { getOptional } from '../lib/env';
import type { EnvKey } from '../lib/env';
import type { OutboundChannel } from '../lib/convexValidators';
import { logError } from '../lib/runtimeLog';
import { missingSecretResult } from './security';

/** Which stored secret to resolve — see `channels/credentials.ts`. */
export type ChannelSecretField = 'signature' | 'verifyToken';

/**
 * Resolve a channel's inbound secret, preferring the credential stored on its
 * `channelConfigs` row over `envVar`.
 *
 * `ctx` is optional because the adapters are also called directly as pure
 * functions in their unit suites; without it, resolution is env-only.
 * `runInboundPipeline` always supplies it.
 */
export async function resolveChannelInboundSecret(
	channel: OutboundChannel,
	field: ChannelSecretField,
	envVar: EnvKey,
	ctx?: ActionCtx
): Promise<string | null> {
	if (ctx) {
		try {
			const stored = await ctx.runAction(internal.channels.credentials.getInboundSecret, {
				channel,
				field,
			});
			if (stored) return stored;
		} catch (error) {
			// A vault read that fails (action error, rotated INSTANCE_SECRET) must
			// not take the endpoint down while an env var is still configured.
			logError(`[channels] could not read the stored ${channel} inbound secret:`, error);
		}
	}
	return getOptional(envVar) ?? null;
}

/**
 * The fail-closed 503 for a channel with no secret in either place. Names both
 * sources so an operator reading the provider console's error knows the form
 * field is an option, not just the deployment variable.
 */
export function missingChannelSecretResult(envVar: EnvKey, formField: string) {
	return missingSecretResult(`${envVar}, or the ${formField} in Settings → Channels`);
}
