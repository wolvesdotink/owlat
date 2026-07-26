import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMtaStsTxtValue, mtaStsPolicyId } from "@owlat/shared/mtaStsPolicy";
import type { Doc } from "../../_generated/dataModel";
import { deploymentRecordsForItem, domainRecordsForItem } from "../checklistRecords";

describe("Deliverability Center copyable records", () => {
	afterEach(() => vi.unstubAllEnvs());

	it("represents TLS-RPT and TLSA independently when both are configured", () => {
		const domain = {
			domain: "example.test",
			dnsRecords: {
				tlsRpt: {
					type: "TXT",
					host: "_smtp._tls",
					value: "v=TLSRPTv1; rua=mailto:tls@example.test",
				},
				tlsa: {
					type: "TLSA",
					host: "_25._tcp.mail",
					value: "3 1 1 abcdef",
				},
			},
		} as unknown as Doc<"domains">;
		expect(domainRecordsForItem("domain.tls_rpt", domain, [], null)).toMatchObject([
			{ type: "TXT", name: "_smtp._tls.example.test" },
		]);
		expect(domainRecordsForItem("domain.tlsa", domain, [], null)).toMatchObject([
			{ type: "TLSA", name: "_25._tcp.mail.example.test" },
		]);
	});

	it("emits one additive SPF fragment for every IPv6 policy host", () => {
		const warming = {
			ips: [
				{ ip: "2001:db8::2", ipv6Spf: { domain: "bounce.example.test" } },
				{ ip: "2001:db8::1", ipv6Spf: { domain: "bounce.example.test" } },
			],
		} as unknown as Doc<"warmingState">;
		const records = deploymentRecordsForItem("deployment.ipv6_spf", warming);
		expect(records).toEqual([
			expect.objectContaining({
				name: "bounce.example.test",
				type: "TXT fragment",
				value: "ip6:2001:db8::1 ip6:2001:db8::2",
			}),
		]);
		expect(records.filter((record) => record.name === "bounce.example.test")).toHaveLength(1);
		expect(records[0]?.value).not.toContain("v=spf1");
	});

	it.each(["~all", "all"])(
		"renders the strict replacement for a staged domain SPF record ending in %s",
		(qualifier) => {
			const domain = {
				domain: "example.test",
				dnsRecords: {
					spf: {
						type: "TXT",
						host: "@",
						value: `v=spf1 include:sender.example ${qualifier}`,
					},
				},
			} as unknown as Doc<"domains">;

			expect(domainRecordsForItem("domain.spf", domain, [], null)).toMatchObject([
				{
					name: "example.test",
					type: "TXT",
					value: "v=spf1 include:sender.example -all",
				},
			]);
		},
	);

	it("derives MTA-STS guidance from the deployment EHLO policy source", () => {
		vi.stubEnv("EHLO_HOSTNAME", "canonical.example.test");
		const domain = {
			domain: "example.test",
			dnsRecords: {},
		} as unknown as Doc<"domains">;
		const settings = { mtaStsMode: "enforce" } as unknown as Doc<"instanceSettings">;
		const warming = {
			ips: [{ ip: "203.0.113.10", fcrdns: { ehlo: "per-ip.example.test" } }],
		} as unknown as Doc<"warmingState">;
		expect(deploymentRecordsForItem("deployment.fcrdns", warming)[0]?.name).toBe(
			"per-ip.example.test",
		);
		const records = domainRecordsForItem("domain.mta_sts", domain, [], settings);
		expect(records).toHaveLength(1);
		expect(records[0]?.value).toBe(
			buildMtaStsTxtValue(mtaStsPolicyId("enforce", ["canonical.example.test"])),
		);
		expect(records[0]?.value).not.toContain("per-ip.example.test");
	});
});
