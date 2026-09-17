/**
 * IS THE DELAY SET HOLDING ENTRIES NOTHING CAN DRAIN?
 *
 * GroupMQ's `:delayed` ZSET is the one structure in this MTA with no owner
 * outside the promoter. A member is put there by an enqueue with a delay, and
 * removed by exactly one thing: the promoter, once the member is due. If a
 * member's job hash is gone — trimmed, deleted, or never written because the
 * job was completed out from under it — the member is still due, still counted
 * against Redis memory, and still carrying whatever payload survived. Nothing
 * in the delivery path will ever notice: it is not a job anyone is waiting on,
 * not a Send anyone will report, not a queue depth anything reads.
 *
 * That is how 6,036,169 payload-less members accumulated unremarked until the
 * kernel OOM killer took Redis out four times. The first in-product signal of
 * a mail system quietly filling its datastore should not be a dead container.
 *
 * THE INVARIANT, STATED SO IT COSTS ALMOST NOTHING TO ASK: a member that came
 * due more than `DELAYED_OVERDUE_GRACE_MS` ago and whose job hash does not
 * exist can never be delivered and can never be removed by anything other than
 * the promoter that has already declined to. One or more of those is a leak; a
 * backlog of overdue members that DO still have their payloads is a different
 * and much less alarming claim (the promoter is merely behind), so the two are
 * reported apart rather than collapsed into a depth threshold.
 *
 * The cost on a healthy queue is two O(log N) ZSET reads. The sample is only
 * taken when there is something overdue to sample, and is a fixed size, so the
 * check never scales with the backlog it is describing.
 */

import type Redis from 'ioredis';

/**
 * The full Redis key prefix GroupMQ derives from the queue namespace
 * (`Queue` prepends `groupmq:` to the configured name — see `createEmailQueue`).
 */
export const QUEUE_KEY_NAMESPACE = 'groupmq:owlat-mta';

/**
 * How far past its `runAt` a member must be before its presence is evidence of
 * anything. The scheduler promotes in bounded batches, so a member seconds past
 * due is simply next in line; ten minutes is far longer than any healthy queue
 * takes to reach one, and far shorter than the shortest retry rung.
 */
export const DELAYED_OVERDUE_GRACE_MS = 10 * 60_000;

/** Overdue members inspected per probe. Fixed, so the probe cost is flat. */
export const DELAYED_ORPHAN_SAMPLE_SIZE = 20;

export interface DelayedQueueProbe {
	/**
	 * `ok` — nothing overdue.
	 * `behind` — overdue members, all of which still have their payloads: the
	 *   promoter is lagging, which time alone can fix.
	 * `orphaned` — at least one overdue member has no payload. Nothing can
	 *   deliver it and nothing will reclaim it; this only grows.
	 * `unknown` — the probe itself could not read Redis.
	 */
	status: 'ok' | 'behind' | 'orphaned' | 'unknown';
	/** Total members of the delay set. */
	delayed: number;
	/** Members due more than the grace window ago. */
	overdue: number;
	/** How many overdue members were inspected. */
	sampled: number;
	/** How many of those had no job hash. */
	orphaned: number;
}

/**
 * The verdict in isolation, so the rule can be read and tested without Redis.
 * `orphaned` is reported on a SINGLE sighting on purpose: a due member with no
 * payload is never a legitimate transient state, and the sample is small.
 */
export function classifyDelayedQueue(counts: {
	overdue: number;
	sampled: number;
	orphaned: number;
}): DelayedQueueProbe['status'] {
	if (counts.orphaned > 0) return 'orphaned';
	if (counts.overdue > 0) return 'behind';
	return 'ok';
}

/**
 * Read the delay set's health. Never throws — a probe that cannot run must not
 * be able to fail a health endpoint that is otherwise answerable.
 */
export async function probeDelayedQueue(
	redis: Redis,
	now: number = Date.now()
): Promise<DelayedQueueProbe> {
	const delayedKey = `${QUEUE_KEY_NAMESPACE}:delayed`;
	const dueBefore = now - DELAYED_OVERDUE_GRACE_MS;
	try {
		const delayed = await redis.zcard(delayedKey);
		if (delayed === 0) {
			return { status: 'ok', delayed: 0, overdue: 0, sampled: 0, orphaned: 0 };
		}
		const overdue = await redis.zcount(delayedKey, '-inf', dueBefore);
		if (overdue === 0) {
			return { status: 'ok', delayed, overdue: 0, sampled: 0, orphaned: 0 };
		}
		// Lowest scores first: the members the promoter should have released
		// longest ago, which is where a stranded one accumulates.
		const sample = await redis.zrangebyscore(
			delayedKey,
			'-inf',
			dueBefore,
			'LIMIT',
			0,
			DELAYED_ORPHAN_SAMPLE_SIZE
		);
		let orphaned = 0;
		for (const jobId of sample) {
			if ((await redis.exists(`${QUEUE_KEY_NAMESPACE}:job:${jobId}`)) === 0) orphaned += 1;
		}
		return {
			status: classifyDelayedQueue({ overdue, sampled: sample.length, orphaned }),
			delayed,
			overdue,
			sampled: sample.length,
			orphaned,
		};
	} catch {
		return { status: 'unknown', delayed: 0, overdue: 0, sampled: 0, orphaned: 0 };
	}
}
