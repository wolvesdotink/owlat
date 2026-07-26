interface DeliverabilitySetupValueBase {
	id: string;
	label: string;
}

export type DeliverabilitySetupValue =
	| (DeliverabilitySetupValueBase & {
			kind: 'dns_record';
			name: string;
			recordType: 'TXT' | 'CNAME' | 'MX' | 'TLSA' | 'A' | 'AAAA' | 'PTR';
			value: string;
			ttl: number;
	  })
	| (DeliverabilitySetupValueBase & {
			kind: 'spf_mechanisms';
			domain: string;
			mechanisms: readonly string[];
			instruction: string;
	  })
	| (DeliverabilitySetupValueBase & {
			kind: 'smtp_setting';
			setting: 'ehlo_hostname';
			value: string;
	  });
