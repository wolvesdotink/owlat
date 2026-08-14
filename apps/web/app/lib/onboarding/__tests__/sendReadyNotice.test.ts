import { describe, it, expect } from "vitest";
import {
	planSendReadyToast,
	sendReadyToastMessage,
	SEND_READY_DEEP_LINK,
	SEND_READY_STEP_ID,
	type SendReadyNotice,
} from "../sendReadyNotice";

function notice(id: string, createdAt: number): SendReadyNotice {
	return { id, createdAt };
}

describe("planSendReadyToast", () => {
	it("surfaces nothing when there is no pending notice", () => {
		expect(planSendReadyToast(undefined, new Set())).toBeNull();
		expect(planSendReadyToast([], new Set())).toBeNull();
	});

	it("surfaces a pending notice once", () => {
		const notices = [notice("n1", 1_000)];
		const plan = planSendReadyToast(notices, new Set());
		expect(plan?.id).toBe("n1");
		// The acknowledge write is in flight while the query still reports it.
		expect(planSendReadyToast(notices, new Set(["n1"]))).toBeNull();
	});

	it("collapses several pending notices into the newest one", () => {
		const plan = planSendReadyToast(
			[notice("old", 1_000), notice("new", 5_000), notice("mid", 3_000)],
			new Set(),
		);
		expect(plan?.id).toBe("new");
	});

	it("still surfaces a genuinely new notice after an earlier one was shown", () => {
		const plan = planSendReadyToast([notice("n1", 1_000), notice("n2", 9_000)], new Set(["n1"]));
		expect(plan?.id).toBe("n2");
	});
});

describe("notice copy and deep link", () => {
	it("hands back the message key the toast resolves", () => {
		expect(sendReadyToastMessage()).toBe("shared.onboarding.sendReadyNotice.toast");
	});

	it("deep-links to the blocked step, not just the dashboard", () => {
		expect(SEND_READY_STEP_ID).toBe("firstSendDone");
		expect(SEND_READY_DEEP_LINK).toBe("/dashboard?step=firstSendDone");
	});
});
