import { describe, expect, it } from "vitest";
import { isRoutingLeaseBoundTo, type RoutingLeaseRecord } from "../routingDecision.js";

function lease(overrides: Partial<RoutingLeaseRecord> = {}): RoutingLeaseRecord {
	return {
		token: "lease-1",
		messageId: "message-1",
		organizationId: "org-1",
		recipient: "user@example.com",
		destinationProvider: "gmail",
		probe: false,
		expiresAt: 10_000,
		...overrides,
	};
}

describe("routing decision lease binding", () => {
	it("accepts only the exact tenant, message, and recipient before expiry", () => {
		expect(
			isRoutingLeaseBoundTo(
				lease(),
				{ messageId: "message-1", organizationId: "org-1", recipient: "USER@example.com" },
				9_000,
			),
		).toBe(true);
	});

	it.each([
		{ messageId: "other", organizationId: "org-1", recipient: "user@example.com" },
		{ messageId: "message-1", organizationId: "org-2", recipient: "user@example.com" },
		{ messageId: "message-1", organizationId: "org-1", recipient: "other@example.com" },
	])("rejects cross-message, cross-tenant, and cross-recipient replay", (request) => {
		expect(isRoutingLeaseBoundTo(lease(), request, 9_000)).toBe(false);
	});

	it("rejects an expired lease", () => {
		expect(
			isRoutingLeaseBoundTo(
				lease(),
				{ messageId: "message-1", organizationId: "org-1", recipient: "user@example.com" },
				10_001,
			),
		).toBe(false);
	});
});
