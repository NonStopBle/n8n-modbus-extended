import type { ICredentialType, INodeProperties } from 'n8n-workflow';

export class ModbusApi implements ICredentialType {
	name = 'modbusApi';

	displayName = 'MODBUS API';

	documentationUrl = 'https://github.com/lostedz/n8n-nodes-modbus';

	properties: INodeProperties[] = [
		{
			displayName: 'Protocol',
			name: 'protocol',
			type: 'options',
			options: [
				{
					name: 'Modbus TCP',
					value: 'tcp',
				},
			],
			default: 'tcp',
		},
		{
			displayName: 'Host',
			name: 'host',
			type: 'string',
			default: '',
		},
		{
			displayName: 'Port',
			name: 'port',
			type: 'number',
			default: 502,
		},
		{
			displayName: 'Enable MBAP Header',
			name: 'enableMbapHeader',
			type: 'boolean',
			default: true,
			description:
				'Whether to use standard Modbus TCP framing with the MBAP header. ' +
				'Disable this for devices that use raw Modbus RTU-over-TCP (no MBAP wrapper), ' +
				'such as serial-to-Ethernet converters in transparent/passthrough mode.',
		},
	];
}
