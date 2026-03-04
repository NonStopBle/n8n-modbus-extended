import type {
	INodeType,
	INodeTypeDescription,
	IExecuteFunctions,
	INodeExecutionData,
	IDataObject,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import {
	createClient,
	extractModbusData,
	type ModbusCredential,
	registerCount,
} from './GenericFunctions';
import { ModbusDataType } from './types';

export class Modbus implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'MODBUS',
		name: 'modbus',
		icon: 'file:modbus.svg',
		group: ['input'],
		version: 1,
		description: 'Read and write to MODBUS devices using all standard function codes',
		eventTriggerDescription: '',
		defaults: { name: 'MODBUS' },
		usableAsTool: true,
		//@ts-ignore
		inputs: ['main'],
		//@ts-ignore
		outputs: ['main'],
		credentials: [{ name: 'modbusApi', required: true }],
		properties: [
			// ─── Function Code ──────────────────────────────────────────────
			{
				displayName: 'Function',
				name: 'function',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'FC01 — Read Coils',
						value: 'readCoils',
						description: 'Read digital output (coil) status',
					},
					{
						name: 'FC02 — Read Discrete Inputs',
						value: 'readDiscreteInputs',
						description: 'Read digital input status (read-only)',
					},
					{
						name: 'FC03 — Read Holding Registers',
						value: 'readHoldingRegisters',
						description: 'Read analog output registers (read/write)',
					},
					{
						name: 'FC04 — Read Input Registers',
						value: 'readInputRegisters',
						description: 'Read analog input registers (read-only)',
					},
					{
						name: 'FC05 — Write Single Coil',
						value: 'writeSingleCoil',
						description: 'Set a single coil ON or OFF',
					},
					{
						name: 'FC06 — Write Single Register',
						value: 'writeSingleRegister',
						description: 'Write a single holding register',
					},
					{
						name: 'FC15 — Write Multiple Coils',
						value: 'writeMultipleCoils',
						description: 'Set multiple coils at once',
					},
					{
						name: 'FC16 — Write Multiple Registers',
						value: 'writeMultipleRegisters',
						description: 'Write multiple holding registers at once',
					},
				],
				default: 'readHoldingRegisters',
			},

			// ─── Common ─────────────────────────────────────────────────────
			{
				displayName: 'Memory Address',
				name: 'memoryAddress',
				type: 'number',
				default: 0,
				description: 'The starting register or coil address (0-based)',
			},
			{
				displayName: 'Unit-ID',
				name: 'unitId',
				type: 'number',
				default: 1,
				description: 'Unit-ID to address devices behind Modbus bridges / gateways',
			},

			// ─── Read: quantity (FC01–FC04) ──────────────────────────────────
			{
				displayName: 'Quantity',
				name: 'quantity',
				type: 'number',
				default: 1,
				description: 'Number of coils or registers to read',
				displayOptions: {
					show: {
						function: ['readCoils', 'readDiscreteInputs', 'readHoldingRegisters', 'readInputRegisters'],
					},
				},
			},

			// ─── Read registers: data type (FC03, FC04) ──────────────────────
			{
				displayName: 'Data Type',
				name: 'dataType',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Signed 16-Bit Integer (int16)', value: 'int16' },
					{ name: 'Unsigned 16-Bit Integer (uint16)', value: 'uint16' },
					{ name: 'Signed 32-Bit Integer (int32)', value: 'int32' },
					{ name: 'Unsigned 32-Bit Integer (uint32)', value: 'uint32' },
					{ name: 'Signed 64-Bit Integer (int64)', value: 'int64' },
					{ name: 'Unsigned 64-Bit Integer (uint64)', value: 'uint64' },
				],
				default: 'int16',
				description:
					'Multi-register types (32/64-bit) consume 2 or 4 registers per value and are read in big-endian word order',
				displayOptions: {
					show: { function: ['readHoldingRegisters', 'readInputRegisters'] },
				},
			},

			// ─── FC05: Write Single Coil ─────────────────────────────────────
			{
				displayName: 'Coil Value',
				name: 'coilValue',
				type: 'boolean',
				default: true,
				description: 'Whether to set the coil ON (true) or OFF (false)',
				displayOptions: { show: { function: ['writeSingleCoil'] } },
			},

			// ─── FC06: Write Single Register ─────────────────────────────────
			{
				displayName: 'Data Type',
				name: 'dataTypeWrite',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Signed 16-Bit Integer (int16)', value: 'int16' },
					{ name: 'Unsigned 16-Bit Integer (uint16)', value: 'uint16' },
					{ name: 'Signed 32-Bit Integer (int32)', value: 'int32' },
					{ name: 'Unsigned 32-Bit Integer (uint32)', value: 'uint32' },
				],
				default: 'int16',
				displayOptions: { show: { function: ['writeSingleRegister', 'writeMultipleRegisters'] } },
			},
			{
				displayName: 'Value',
				name: 'registerValue',
				type: 'number',
				default: 0,
				typeOptions: { maxValue: 4294967295, minValue: -2147483648 },
				description: 'The value to write to the register',
				displayOptions: { show: { function: ['writeSingleRegister'] } },
			},

			// ─── FC15: Write Multiple Coils ───────────────────────────────────
			{
				displayName: 'Coil Values',
				name: 'coilValues',
				type: 'string',
				default: '1,0,1',
				description:
					'Comma-separated list of coil values: use 1 for ON, 0 for OFF. Example: 1,0,1,1,0',
				displayOptions: { show: { function: ['writeMultipleCoils'] } },
			},

			// ─── FC16: Write Multiple Registers ──────────────────────────────
			{
				displayName: 'Register Values',
				name: 'registerValues',
				type: 'string',
				default: '100,200',
				description: 'Comma-separated list of integer values to write. Example: 100,200,300',
				displayOptions: { show: { function: ['writeMultipleRegisters'] } },
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		let responseData: IDataObject = {};
		const credentials = await this.getCredentials<ModbusCredential>('modbusApi');
		const client = await createClient(credentials);

		try {
			const fc = this.getNodeParameter('function', 0) as string;
			const memoryAddress = this.getNodeParameter('memoryAddress', 0) as number;
			const unitId = this.getNodeParameter('unitId', 0, 1) as number;
			const extra = { unitId };

			// ── FC01: Read Coils ───────────────────────────────────────────
			if (fc === 'readCoils') {
				const quantity = this.getNodeParameter('quantity', 0) as number;
				responseData = await new Promise<IDataObject>((resolve, reject) => {
					client.readCoils({ address: memoryAddress, quantity, extra }, (err, data) => {
						if (err) return reject(new NodeOperationError(this.getNode(), 'MODBUS: ' + err.message));
						if (!data) return reject(new NodeOperationError(this.getNode(), 'MODBUS: no data'));
						resolve({ data: data.response.data });
					});
				});
			}

			// ── FC02: Read Discrete Inputs ─────────────────────────────────
			else if (fc === 'readDiscreteInputs') {
				const quantity = this.getNodeParameter('quantity', 0) as number;
				responseData = await new Promise<IDataObject>((resolve, reject) => {
					client.readDiscreteInputs({ address: memoryAddress, quantity, extra }, (err, data) => {
						if (err) return reject(new NodeOperationError(this.getNode(), 'MODBUS: ' + err.message));
						if (!data) return reject(new NodeOperationError(this.getNode(), 'MODBUS: no data'));
						resolve({ data: data.response.data });
					});
				});
			}

			// ── FC03: Read Holding Registers ───────────────────────────────
			else if (fc === 'readHoldingRegisters') {
				const quantity = this.getNodeParameter('quantity', 0) as number;
				const dataType = this.getNodeParameter('dataType', 0, 'int16') as ModbusDataType;
				responseData = await new Promise<IDataObject>((resolve, reject) => {
					client.readHoldingRegisters(
						{ address: memoryAddress, quantity: quantity * registerCount(dataType), extra },
						(err, data) => {
							if (err) return reject(new NodeOperationError(this.getNode(), 'MODBUS: ' + err.message));
							if (!data?.response?.data) return reject(new NodeOperationError(this.getNode(), 'MODBUS: no data'));
							resolve({ data: extractModbusData(this.getNode(), data.response.data, dataType) });
						},
					);
				});
			}

			// ── FC04: Read Input Registers ─────────────────────────────────
			else if (fc === 'readInputRegisters') {
				const quantity = this.getNodeParameter('quantity', 0) as number;
				const dataType = this.getNodeParameter('dataType', 0, 'int16') as ModbusDataType;
				responseData = await new Promise<IDataObject>((resolve, reject) => {
					client.readInputRegisters(
						{ address: memoryAddress, quantity: quantity * registerCount(dataType), extra },
						(err, data) => {
							if (err) return reject(new NodeOperationError(this.getNode(), 'MODBUS: ' + err.message));
							if (!data?.response?.data) return reject(new NodeOperationError(this.getNode(), 'MODBUS: no data'));
							resolve({ data: extractModbusData(this.getNode(), data.response.data, dataType) });
						},
					);
				});
			}

			// ── FC05: Write Single Coil ────────────────────────────────────
			else if (fc === 'writeSingleCoil') {
				const value = this.getNodeParameter('coilValue', 0) as boolean;
				responseData = await new Promise<IDataObject>((resolve, reject) => {
					client.writeSingleCoil({ address: memoryAddress, value, extra }, (err, data) => {
						if (err) return reject(new NodeOperationError(this.getNode(), 'MODBUS: ' + err.message));
						resolve({ success: true, address: memoryAddress, value });
					});
				});
			}

			// ── FC06: Write Single Register ────────────────────────────────
			else if (fc === 'writeSingleRegister') {
				const value = this.getNodeParameter('registerValue', 0) as number;
				const dataType = this.getNodeParameter('dataTypeWrite', 0, 'int16') as ModbusDataType;
				const buffer = Buffer.alloc(registerCount(dataType) * 2);

				switch (dataType) {
					case 'int16':
						if (value > 32767 || value < -32768)
							throw new NodeOperationError(this.getNode(), 'MODBUS: value out of range for int16');
						buffer.writeInt16BE(value);
						break;
					case 'uint16':
						if (value > 65535 || value < 0)
							throw new NodeOperationError(this.getNode(), 'MODBUS: value out of range for uint16');
						buffer.writeUInt16BE(value);
						break;
					case 'int32':
						if (value > 2147483647 || value < -2147483648)
							throw new NodeOperationError(this.getNode(), 'MODBUS: value out of range for int32');
						buffer.writeInt32BE(value);
						break;
					case 'uint32':
						if (value > 4294967295 || value < 0)
							throw new NodeOperationError(this.getNode(), 'MODBUS: value out of range for uint32');
						buffer.writeUInt32BE(value);
						break;
					default:
						throw new NodeOperationError(this.getNode(), `MODBUS: unsupported data type ${dataType}`);
				}

				// For multi-register writes triggered via FC06, split into individual 2-byte registers
				// and use FC16 if more than one register is needed
				const regCount = registerCount(dataType);
				if (regCount === 1) {
					responseData = await new Promise<IDataObject>((resolve, reject) => {
						client.writeSingleRegister({ address: memoryAddress, value: buffer, extra }, (err) => {
							if (err) return reject(new NodeOperationError(this.getNode(), 'MODBUS: ' + err.message));
							resolve({ success: true, address: memoryAddress, value });
						});
					});
				} else {
					// Split 32-bit value across multiple registers via FC16
					const values: Buffer[] = [];
					for (let i = 0; i < regCount; i++) {
						const buf = Buffer.alloc(2);
						buffer.copy(buf, 0, i * 2, i * 2 + 2);
						values.push(buf);
					}
					responseData = await new Promise<IDataObject>((resolve, reject) => {
						client.writeMultipleRegisters({ address: memoryAddress, values, extra }, (err) => {
							if (err) return reject(new NodeOperationError(this.getNode(), 'MODBUS: ' + err.message));
							resolve({ success: true, address: memoryAddress, value });
						});
					});
				}
			}

			// ── FC15: Write Multiple Coils ─────────────────────────────────
			else if (fc === 'writeMultipleCoils') {
				const raw = this.getNodeParameter('coilValues', 0) as string;
				const values = raw
					.split(',')
					.map((s) => s.trim())
					.filter((s) => s !== '')
					.map((s) => {
						if (s !== '0' && s !== '1')
							throw new NodeOperationError(
								this.getNode(),
								`MODBUS: invalid coil value "${s}" — use 0 or 1`,
							);
						return s === '1';
					});

				if (values.length === 0)
					throw new NodeOperationError(this.getNode(), 'MODBUS: coil values list is empty');

				responseData = await new Promise<IDataObject>((resolve, reject) => {
					client.writeMultipleCoils({ address: memoryAddress, values, extra }, (err) => {
						if (err) return reject(new NodeOperationError(this.getNode(), 'MODBUS: ' + err.message));
						resolve({ success: true, address: memoryAddress, quantity: values.length, values });
					});
				});
			}

			// ── FC16: Write Multiple Registers ────────────────────────────
			else if (fc === 'writeMultipleRegisters') {
				const raw = this.getNodeParameter('registerValues', 0) as string;
				const dataType = this.getNodeParameter('dataTypeWrite', 0, 'int16') as ModbusDataType;
				const numbers = raw
					.split(',')
					.map((s) => s.trim())
					.filter((s) => s !== '')
					.map((s) => {
						const n = Number(s);
						if (isNaN(n))
							throw new NodeOperationError(
								this.getNode(),
								`MODBUS: "${s}" is not a valid number`,
							);
						return n;
					});

				if (numbers.length === 0)
					throw new NodeOperationError(this.getNode(), 'MODBUS: register values list is empty');

				const values: Buffer[] = numbers.flatMap((value) => {
					const regCount = registerCount(dataType);
					const buf = Buffer.alloc(regCount * 2);
					switch (dataType) {
						case 'int16':  buf.writeInt16BE(value);  break;
						case 'uint16': buf.writeUInt16BE(value); break;
						case 'int32':  buf.writeInt32BE(value);  break;
						case 'uint32': buf.writeUInt32BE(value); break;
					}
					const regs: Buffer[] = [];
					for (let i = 0; i < regCount; i++) {
						const r = Buffer.alloc(2);
						buf.copy(r, 0, i * 2, i * 2 + 2);
						regs.push(r);
					}
					return regs;
				});

				responseData = await new Promise<IDataObject>((resolve, reject) => {
					client.writeMultipleRegisters({ address: memoryAddress, values, extra }, (err) => {
						if (err) return reject(new NodeOperationError(this.getNode(), 'MODBUS: ' + err.message));
						resolve({ success: true, address: memoryAddress, quantity: values.length, values: numbers });
					});
				});
			}
		} finally {
			client.destroy();
		}

		return [this.helpers.returnJsonArray(responseData)];
	}
}
