/**
 * A loopback HTTPS server standing in for `mta-sts.owlat.test`, for the
 * MTA-STS policy fetch tests. The throwaway self-signed cert carries
 * subjectAltName DNS:mta-sts.owlat.test and is trusted only through the
 * returned transport's `ca`, so certificate and name checks stay on.
 *
 * The returned transport resolves every name to 127.0.0.1 and allows that
 * address; tests of the address guard pass their own resolver instead.
 */
import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { StsFetchTransport } from '../../mtaStsFetch.js';

export const STS_TEST_DOMAIN = 'owlat.test';

export const STS_TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDPDCCAiSgAwIBAgIUZv0+y+YjpdtE9xpzDbLsgWGvKCgwDQYJKoZIhvcNAQEL
BQAwHTEbMBkGA1UEAwwSbXRhLXN0cy5vd2xhdC50ZXN0MCAXDTI2MTAxMzIwMDQ0
M1oYDzIxMjYwOTE5MjAwNDQzWjAdMRswGQYDVQQDDBJtdGEtc3RzLm93bGF0LnRl
c3QwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQC06s7qSptVwVxrmqvI
q37PkYoa1seZOSeAsYGDak9Bb+VAGWva2i3aDaKAq27Kj/qru/Pbb1RLdy+ozWCN
m48GQOl1LU5Rz2WpQZGuLHyqKC7l++D34Q44Dig7JmiLkQl8TiHorm9u7PTTui/a
oTsjzJzwzF75SEExDuPdu/2uZjKX4JSnjwHDjs8MeUlwCg8xe2cHJNqTdj7GbXpv
jc9+A66/t13+hSXpLHq2lxzMSP5os3FfBPy+GjrZfcrqv+1kYP76lk6IMYlR9Wo6
vqesxK1P/5ZW3r5wiLnov/UcZEKOc2EbqGKTOcgaA6krzzQxjAFqKEu04jenVsxI
RLTlAgMBAAGjcjBwMB0GA1UdDgQWBBRmBKfCo3gWSWlf+f4uey5Ov3CwxjAfBgNV
HSMEGDAWgBRmBKfCo3gWSWlf+f4uey5Ov3CwxjAPBgNVHRMBAf8EBTADAQH/MB0G
A1UdEQQWMBSCEm10YS1zdHMub3dsYXQudGVzdDANBgkqhkiG9w0BAQsFAAOCAQEA
couDqtri7VoSJWVqrBPbD5LX2LuG1zH8mh3rxv3OzEsRCW1WEEk/3DHDst4NC0ED
8VvG/rSOM/oBdQ/hx5SsTuPOazXtDoVkCDtCbyXGRRXLhRbLrQo4Kc7s3cXurMTY
exNqKdRTdwoWtZTNyD2nKWangiQSbJuXlxCs5qyP3zBcjuPp+SAnBRsoRLcYi5l8
MeDmSFBL52cfJ4vQ1kHUnuXWFAzd6sLBgB56su/8esPGQLPBwHc+gUKgXQqsVCcc
P9hnVlb9Tqww2jzfVrzBz5r1UXxqwLSFnm5cfuxIEHeaMGmt1zSiw5LdIJUdAkTG
w9a9w636s2SaSrVBQSQosQ==
-----END CERTIFICATE-----`;

const STS_TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC06s7qSptVwVxr
mqvIq37PkYoa1seZOSeAsYGDak9Bb+VAGWva2i3aDaKAq27Kj/qru/Pbb1RLdy+o
zWCNm48GQOl1LU5Rz2WpQZGuLHyqKC7l++D34Q44Dig7JmiLkQl8TiHorm9u7PTT
ui/aoTsjzJzwzF75SEExDuPdu/2uZjKX4JSnjwHDjs8MeUlwCg8xe2cHJNqTdj7G
bXpvjc9+A66/t13+hSXpLHq2lxzMSP5os3FfBPy+GjrZfcrqv+1kYP76lk6IMYlR
9Wo6vqesxK1P/5ZW3r5wiLnov/UcZEKOc2EbqGKTOcgaA6krzzQxjAFqKEu04jen
VsxIRLTlAgMBAAECggEAFjmeT7P4nzFQ3Ds1DULcIj273I40GQOncazcvzspH13S
qOw2jr0s0tPH+cyVoLbNUZmWXIexsE+lADSyvtK0YE1LIMT/ERfMYl2WuvHmIrUr
Bb/KpEj2iTZcBOA0Cak4pBepHL+JGvRrIzOFO3OBI2W4hfBlXnRc5dzxa0Tz5h+c
8sy3E3rQuky32p6aa0IhfH2t6TaUvNinl4w/7ZIBO4NElkynLl+TYa5CQY3nNHX8
Z2j2fXeqng02Uw8GYXGn/OZySkh8B21IYdEkI3UG4hvCVDIo82JEqT/IoyDfSLte
8wifaXy5vXrhkU1eBT5kazw7/CiHQr2gnxj4Dly2AQKBgQDj9EgXHtAsh4mIBuie
0sRrMivpSBaROwvjELbcYuveUkRyZhchuQc4AHHx9T4u8681VPZKpfrDPHEaH98h
+9uhYUmTi11ehUujRo/WDtTPkg7ZFNsNimDdPVxgMZMYy/uxluQSq1Kni7tFmIv8
mD76SIR10RnO2GJyCuP6vRESZQKBgQDLLQjFQz1xc23alQ0/PUIuzfSyeDpDg0wr
LkMNBxH4X1aOTjP7b5lo9NrXnlVgHS5xLUKr2CodV9IiZtceL8n0fP0NvIdfHScW
0YJTMM4TBToHPD11cuFGzr5FlzPoD1STbzHfLTTYTtv+CEpB4IgQpjPdHRgsLtuP
Jq8yWyGwgQKBgFKR+sb9L1Th54xxTDOzjthxfPxsU1hZ9g1S0Zn07xFB5W820awy
dI3xg1Ssi9DADjgYRXp2suWjcCiRYObTbxP+xIMAWVrSl7pV5eYYyzdA5cX2Sv6V
oE6jWmGxs2GpCcujJ4wnqLHt6HDmN9bQYweP2wM+McX+FXLPxRLfB18NAoGAR9l9
KIVGzUAMsSfUr3ByXyrmRdbOg+GCpiKOA6VkbXkJmvl82IX2sm8klOuhNYQcUFm5
IhwniIjt/sxvdnVf7d3lf14UYUZl9GPSuqift4o5oyVido5RrECgeOunp4EEX78K
2+mYroX0tjkoSXOlqn2cCa2oRrerXUxI2H3xxAECgYEAswkkxWpaxUcKAymdKo4X
u8kIMpuSPGq0JP3eTvkPqUMLBdbVh2iLmjc81n/7vKalcVOEIxCpWMxBBh4s3RBP
oE4dE4Itw/vCsXsdFkLzYsFVGjEdvFhdzobLeh+6VO/YiF9nTAumPMsOqSQ0wKa1
VK4MDddEBzkLAFKHZcDPFTQ=
-----END PRIVATE KEY-----`;

export interface PolicyServer {
	transport: StsFetchTransport;
	requests: () => number;
	close: () => Promise<void>;
}

export async function startPolicyServer(
	handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<PolicyServer> {
	let requests = 0;
	const server: Server = createServer({ cert: STS_TEST_CERT, key: STS_TEST_KEY }, (req, res) => {
		requests++;
		handler(req, res);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	return {
		transport: {
			port,
			ca: STS_TEST_CERT,
			resolve: (_host, _opts, callback) => callback(null, [{ address: '127.0.0.1', family: 4 }]),
			isAllowedAddress: () => true,
		},
		requests: () => requests,
		close: () => {
			server.closeAllConnections();
			return new Promise((resolve) => server.close(() => resolve()));
		},
	};
}
