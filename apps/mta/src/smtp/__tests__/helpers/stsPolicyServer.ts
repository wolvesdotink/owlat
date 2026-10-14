/**
 * A loopback HTTPS server standing in for `mta-sts.owlat.test`, for the
 * MTA-STS policy fetch tests. The throwaway self-signed cert carries
 * subjectAltName DNS:mta-sts.owlat.test and is trusted only through the
 * returned transport's `ca`, so certificate and name checks stay on.
 *
 * The returned transport resolves every name to 127.0.0.1 and allows that
 * address; tests of the address guard pass their own resolver instead.
 * Responses default to `Content-Type: text/plain`, which a handler can
 * override or remove.
 *
 * `cert` picks another throwaway cert, trusted the same way:
 * - `cnOnly`: CN=mta-sts.owlat.test and no subjectAltName at all;
 * - `wildcard`: DNS:*.owlat.test, a whole-label wildcard;
 * - `partialWildcard`: DNS:mta-*.owlat.test;
 * - `suffixWildcard`: DNS:*.co.uk, a wildcard on a public suffix.
 * The three wildcard certs reuse the default cert's key.
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

const STS_CN_ONLY_CERT = `-----BEGIN CERTIFICATE-----
MIIC/DCCAeSgAwIBAgIUSBRCZWHwFbVyZLn+gboXLNfY/IMwDQYJKoZIhvcNAQEL
BQAwHTEbMBkGA1UEAwwSbXRhLXN0cy5vd2xhdC50ZXN0MCAXDTI2MTAxNDA3MzMy
MFoYDzIxMjYwOTIwMDczMzIwWjAdMRswGQYDVQQDDBJtdGEtc3RzLm93bGF0LnRl
c3QwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQC5pmn9NgoimatxpVAm
R+q9HhyYCBrOeuwOyt4W178LX5uLmyHD/JbOerjju6vHiWOEgKp7hBjrwpsOwNVi
kTDrBqsJl/au2Y+NZ0ek9WtVQE1PmM2hOjz7QilLIdf057Nhpph99hpSsjhnY78E
y9Le32I9T6k2ObawL1rQ6e8ig0siWBbrFughAV6jT7NmrRXIalbcdrdqIbFoQUBb
b9bumR7cx8SPCEx5KT5KyxEFhvSTBeG50J+TrZdxyKY1D1nCJjN8qA12j+JiNT1b
4NFN3AQ0Wo58bSJfuPfk6EiDtX8uZ8D9blBT2BtKljNk2kGDJUr+yc8cXP7Qgqtt
S10tAgMBAAGjMjAwMA8GA1UdEwEB/wQFMAMBAf8wHQYDVR0OBBYEFFePricqNkAS
8EVSucOoC6+zW+xTMA0GCSqGSIb3DQEBCwUAA4IBAQBsIFvec/57rE7QOSSz7qu8
7iUXOmBKZ421mvTaUW/mu3c7xrhHrYWUtVKPa2aYi9CWPAngvBT9acWaaF7UWtEx
tKFY1uamTQkRVzGMHplmiX0y8wNA+FTFsj4SKpGoVFqRDhcBFGL+oiobelYvaGkQ
5cXj92L6hEOD/Fxb3xSAy+8ug5kA3GnfVkvEv4w9bxtzo1VF2iFU8arB/vwxReHB
SREoIYhNprWvOB2pUDatbGaWEuOXhLsOlbU81oMY9RJZr5Sn6Ob8jLQbeDVUvx1p
GbWZ9fEsUCeBOHwSW8Pcj1x/KTJkKm3ycIEHhCBeAxdGv1iaBzLaGQxh6rW/QY9R
-----END CERTIFICATE-----`;

const STS_CN_ONLY_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC5pmn9Ngoimatx
pVAmR+q9HhyYCBrOeuwOyt4W178LX5uLmyHD/JbOerjju6vHiWOEgKp7hBjrwpsO
wNVikTDrBqsJl/au2Y+NZ0ek9WtVQE1PmM2hOjz7QilLIdf057Nhpph99hpSsjhn
Y78Ey9Le32I9T6k2ObawL1rQ6e8ig0siWBbrFughAV6jT7NmrRXIalbcdrdqIbFo
QUBbb9bumR7cx8SPCEx5KT5KyxEFhvSTBeG50J+TrZdxyKY1D1nCJjN8qA12j+Ji
NT1b4NFN3AQ0Wo58bSJfuPfk6EiDtX8uZ8D9blBT2BtKljNk2kGDJUr+yc8cXP7Q
gqttS10tAgMBAAECggEATCFVF3Qgpd20c48iFgCp31HI0gOI0qGPyeUhO+bPPh+/
znkYWKFtSlEDHshoAhRyDfUhdDNQcOXF5j/ngVse31JFs1Jw43TuLENtGtVVZYlP
6tMzh+k09qhD/L5tK84UPngt0oGoe77/6E38GEBpQeIDDDdtoYH7S7avnDpCSTkv
Yqk/prtgemZFhRKk9t45fh2YfMlQg/uDBdj7clS2I9s/cQGW20Yzja0jTNmsk7F2
pbEwl+warHDn2bT/fDb7S52KKOlfat/6X4r8mZRMoyg4yFDy5W7kuKVo++GZPrC3
5m+Rk4Mrz3UAG59IN2+aNFOFd/xcMEJWziWoPNRxlQKBgQD7pYorWNxbjk97NZiP
bLYf5aMSii7ZAfzqzz+8DuIVR+ayuU1q2NFr9QVokNOfPrmCE2ZRfu+aVLmR+3eS
91hZnnTe10T9XpWg82fwi6DY5zh6XPsFvlIFDytIsVjq2JuPkcl6P1dTTZ0Vz/DP
Pn9onotQfp/2GDt39pSTavJnJwKBgQC83JjcF6JbXbJpvtpMkc9oJsfaCnWxh2p3
Ag3SL83Unua+XGl7YGD44j8C9qnws5HrLTgTI5URPjH2onDNlBaffLhpCTgx0kZt
5x27klDFeQsohdimX3/12sS1KWGTQawqxhGynATqT2OJsC+F8JM9+qfjSC7p5isB
DOMzz0itiwKBgFGSa6N5fpS/IMyTpwx29OKKEb5kxKLbnhyPad2QBYFYeVPd9VZ5
Sglwt3wZ1j98ma2slDI+r3SbmjvUBALD4wPJ9aB2r4piKqatwDedS1qEOS6RDV3j
P7scG6/IrUYTSPnVDDZwaeI6+nyjly/W1n4XRpmlMj0Xxc8xQyA2PrVpAoGAd+7W
m53emorLy99JHarSvV8zNsHBr7VA5MZHJJz65vTpryVcTt8LdcGnJiiiDpraJTCY
FX9ZIJQQgoDxhXtvSmSXbwxNxUW1OAG2nfDynhSaA2fMBwtKZURB+pGGx07DGH6j
qnrtnCZCHaPm6fW2a3uLtgeW0y45TPd0KOiPTLUCgYEA75N0ob2LYDbl5ZTTMCbV
Ht03cQYSTM46qf9tYY1vJIPyv4UMaJavlSlbqfCy7TSVbBzde+fxo+851A9h0jq3
+GmvvN26I+G72EmX53s05kV0G86mlHTOGivXFzojQvuxurxsJZ4BcClhCYLtLU4+
tcC7tVc5BDCrAUUJTQ201xw=
-----END PRIVATE KEY-----`;

const STS_WILDCARD_CERT = `-----BEGIN CERTIFICATE-----
MIIDLDCCAhSgAwIBAgIUFoCLYQT+sfJMWHBJ52O9KwDsoaAwDQYJKoZIhvcNAQEL
BQAwGDEWMBQGA1UEAwwNd2lsZGNhcmQgdGVzdDAgFw0yNjEwMTQwNzUyMzVaGA8y
MTI2MDkyMDA3NTIzNVowGDEWMBQGA1UEAwwNd2lsZGNhcmQgdGVzdDCCASIwDQYJ
KoZIhvcNAQEBBQADggEPADCCAQoCggEBALTqzupKm1XBXGuaq8irfs+RihrWx5k5
J4CxgYNqT0Fv5UAZa9raLdoNooCrbsqP+qu789tvVEt3L6jNYI2bjwZA6XUtTlHP
ZalBka4sfKooLuX74PfhDjgOKDsmaIuRCXxOIeiub27s9NO6L9qhOyPMnPDMXvlI
QTEO4927/a5mMpfglKePAcOOzwx5SXAKDzF7Zwck2pN2PsZtem+Nz34Drr+3Xf6F
JekseraXHMxI/mizcV8E/L4aOtl9yuq/7WRg/vqWTogxiVH1ajq+p6zErU//llbe
vnCIuei/9RxkQo5zYRuoYpM5yBoDqSvPNDGMAWooS7TiN6dWzEhEtOUCAwEAAaNs
MGowHQYDVR0OBBYEFGYEp8KjeBZJaV/5/i57Lk6/cLDGMB8GA1UdIwQYMBaAFGYE
p8KjeBZJaV/5/i57Lk6/cLDGMBcGA1UdEQQQMA6CDCoub3dsYXQudGVzdDAPBgNV
HRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQAr/LRR/FeM9RrXLZyLRhYo
Mtaj3rOlPCvmBKpZf1/Nxs4Jki13+SVvUoXviRv6a0DA7+V2gNSyuQ04MJWvy++o
kczRQBtsGGHQad0JYULMzV8aKGUTkMUE5rIv2ssUZ4wIqNRWwdEiBU0oAkjFHTNg
f3J2hSHrDkm/pO3cUBxDiO1UeA7/st+iKqdO5G4KlBXFZ+75VX78hJpMfeEGmpwx
PAXBvzQRpWWBHI4v8gsePxlVMIVFCBfiP8ysvAfXIxdE6wRW0PWB4eUOKYlP7RIL
40V2Ow1s9voLPYVqNPKGPRGD0pNubGYXFtoSS/hQ9FFdoISnRow9NBkiwpy587SJ
-----END CERTIFICATE-----`;

const STS_PARTIAL_WILDCARD_CERT = `-----BEGIN CERTIFICATE-----
MIIDMDCCAhigAwIBAgIUDwEE19Kt2w/abNNMcnYyJaAAsVEwDQYJKoZIhvcNAQEL
BQAwGDEWMBQGA1UEAwwNd2lsZGNhcmQgdGVzdDAgFw0yNjEwMTQwNzUyMzVaGA8y
MTI2MDkyMDA3NTIzNVowGDEWMBQGA1UEAwwNd2lsZGNhcmQgdGVzdDCCASIwDQYJ
KoZIhvcNAQEBBQADggEPADCCAQoCggEBALTqzupKm1XBXGuaq8irfs+RihrWx5k5
J4CxgYNqT0Fv5UAZa9raLdoNooCrbsqP+qu789tvVEt3L6jNYI2bjwZA6XUtTlHP
ZalBka4sfKooLuX74PfhDjgOKDsmaIuRCXxOIeiub27s9NO6L9qhOyPMnPDMXvlI
QTEO4927/a5mMpfglKePAcOOzwx5SXAKDzF7Zwck2pN2PsZtem+Nz34Drr+3Xf6F
JekseraXHMxI/mizcV8E/L4aOtl9yuq/7WRg/vqWTogxiVH1ajq+p6zErU//llbe
vnCIuei/9RxkQo5zYRuoYpM5yBoDqSvPNDGMAWooS7TiN6dWzEhEtOUCAwEAAaNw
MG4wHQYDVR0OBBYEFGYEp8KjeBZJaV/5/i57Lk6/cLDGMB8GA1UdIwQYMBaAFGYE
p8KjeBZJaV/5/i57Lk6/cLDGMBsGA1UdEQQUMBKCEG10YS0qLm93bGF0LnRlc3Qw
DwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAAcuJ1yOG6jpYXnVw
4mS66XwMQitqYIs140ryPG1kQ9WqTIIiLL5Z9N/a8QjQofFRDAI/D5suPBr8QBMc
aDFJoTrOnaN3JF7RIm2fHmtaRWFf8VzUD51pPeCAWYWt3ypDKFFoMMnYYiBuRbyI
75xFxevQ48ABGmNjEm4fxneNvXhZRrjbwMCrPNC5+E1fX3G7fNjMDrmwcl83HxgC
qtX6ssiKWyEVxEf/sBEzSV3l+IonpyOH8nAGDao65LQapi2hpc3YuwJc6Jup4s/R
m8mKPAoYs9HuCz3w35+W3C/xjHkYwMFVoE0AVNa7SSlRQC3VJbOAzSWR9B8eKT7g
q6t7Kg==
-----END CERTIFICATE-----`;

const STS_SUFFIX_WILDCARD_CERT = `-----BEGIN CERTIFICATE-----
MIIDJzCCAg+gAwIBAgIUbNM9jrAx92bxAzEN3yHWfJ3ATxAwDQYJKoZIhvcNAQEL
BQAwGDEWMBQGA1UEAwwNd2lsZGNhcmQgdGVzdDAgFw0yNjEwMTQwNzUyMzVaGA8y
MTI2MDkyMDA3NTIzNVowGDEWMBQGA1UEAwwNd2lsZGNhcmQgdGVzdDCCASIwDQYJ
KoZIhvcNAQEBBQADggEPADCCAQoCggEBALTqzupKm1XBXGuaq8irfs+RihrWx5k5
J4CxgYNqT0Fv5UAZa9raLdoNooCrbsqP+qu789tvVEt3L6jNYI2bjwZA6XUtTlHP
ZalBka4sfKooLuX74PfhDjgOKDsmaIuRCXxOIeiub27s9NO6L9qhOyPMnPDMXvlI
QTEO4927/a5mMpfglKePAcOOzwx5SXAKDzF7Zwck2pN2PsZtem+Nz34Drr+3Xf6F
JekseraXHMxI/mizcV8E/L4aOtl9yuq/7WRg/vqWTogxiVH1ajq+p6zErU//llbe
vnCIuei/9RxkQo5zYRuoYpM5yBoDqSvPNDGMAWooS7TiN6dWzEhEtOUCAwEAAaNn
MGUwHQYDVR0OBBYEFGYEp8KjeBZJaV/5/i57Lk6/cLDGMB8GA1UdIwQYMBaAFGYE
p8KjeBZJaV/5/i57Lk6/cLDGMBIGA1UdEQQLMAmCByouY28udWswDwYDVR0TAQH/
BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEACxkcSkl+dSgw7WqMSkMCT9a0WI2B
/gLYF3e4IW1AuoUOHZ9jgHNJ1YAIGlGu1ZUwi3AKDEeF3m86gp3ZmUdGOKf7OsNN
jQThKZuIFtNxSre01d6C8t7TaOEAHmgHHr25Wfv3oe5V0W+8ZJBuSQjFxBTsPPPD
WFfo2CJPVtTG59t4XL4sW1oG5VOX7NCB+T4Ikm7TLXdNMKu0CAasw0WlMEagEXWl
Xxe31NxAu5jaPMaX3CBvvFqMFz+eVJU4Bn25LTiTgcAFQ3KHdd/XnDaCiIo0LRX3
hP1TmKReMK5AFyRO6xjTKiyvz2OiA3aKAwVnfENNCk05067Znb8+Fyl+GQ==
-----END CERTIFICATE-----`;

export type PolicyServerCert =
	| 'default'
	| 'cnOnly'
	| 'wildcard'
	| 'partialWildcard'
	| 'suffixWildcard';

const CERTS: Record<PolicyServerCert, { cert: string; key: string }> = {
	default: { cert: STS_TEST_CERT, key: STS_TEST_KEY },
	cnOnly: { cert: STS_CN_ONLY_CERT, key: STS_CN_ONLY_KEY },
	wildcard: { cert: STS_WILDCARD_CERT, key: STS_TEST_KEY },
	partialWildcard: { cert: STS_PARTIAL_WILDCARD_CERT, key: STS_TEST_KEY },
	suffixWildcard: { cert: STS_SUFFIX_WILDCARD_CERT, key: STS_TEST_KEY },
};

export interface PolicyServer {
	transport: StsFetchTransport;
	requests: () => number;
	close: () => Promise<void>;
}

export async function startPolicyServer(
	handler: (req: IncomingMessage, res: ServerResponse) => void,
	opts: { cert?: PolicyServerCert } = {}
): Promise<PolicyServer> {
	let requests = 0;
	const { cert, key } = CERTS[opts.cert ?? 'default'];
	const server: Server = createServer({ cert, key }, (req, res) => {
		requests++;
		res.setHeader('Content-Type', 'text/plain');
		handler(req, res);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	return {
		transport: {
			port,
			ca: cert,
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
