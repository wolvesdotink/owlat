import { describe, expect, it } from "vitest";
import {
	MAX_PASSWORD_LENGTH,
	MIN_PASSWORD_LENGTH,
	meetsMinPasswordLength,
} from "../passwordPolicy";

describe("password policy", () => {
	it("keeps the minimum below the maximum", () => {
		expect(MIN_PASSWORD_LENGTH).toBeGreaterThan(0);
		expect(MIN_PASSWORD_LENGTH).toBeLessThan(MAX_PASSWORD_LENGTH);
	});

	it("accepts a password exactly at the minimum and rejects one character less", () => {
		expect(meetsMinPasswordLength("a".repeat(MIN_PASSWORD_LENGTH))).toBe(true);
		expect(meetsMinPasswordLength("a".repeat(MIN_PASSWORD_LENGTH - 1))).toBe(false);
	});
});
