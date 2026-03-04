import type {
	ITriggerFunctions,
	IDataObject,
	INodeType,
	INodeTypeDescription,
	ITriggerResponse,
	IRun,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import {
	createClient,
	extractModbusData,
	type IModbusClient,
	type ModbusCredential,
	registerCount,
} from './GenericFunctions';
import { ModbusDataType } from './types';

interface Options {
	parallelProcessing: boolean;
}

export class ModbusTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'MODBUS Trigger',
		name: 'modbusTrigger',
		icon: 'file:modbus.svg',
		group: ['trigger'],
		version: 1,
		description: 'Polls a Modbus device and fires when a value changes',
		eventTriggerDescription: '',
		defaults: { name: 'MODBUS Trigger' },
		triggerPanel: {
			header: '',
			executionsHelp: {
				inactive:
					"<b>While building your workflow</b>, click the 'listen' button, then trigger a MODBUS event. This will trigger an execution, which will show up in this editor.<br /><br /><b>Once you're happy with your workflow</b>, <a data-key='activate'>activate</a> it. Then every time a change is detected, the workflow will execute. These executions will show up in the <a data-key='executions'>executions list</a>, but not in the editor.",
				active:
					"<b>While building your workflow</b>, click the 'listen' button, then trigger a MODBUS event. This will trigger an execution, which will show up in this editor.<br /><br /><b>Your workflow will also execute automatically</b>, since it's activated. Every time a change is detected, this node will trigger an execution. These executions will show up in the <a data-key='executions'>executions list</a>, but not in the editor.",
			},
			activationHint:
				"Once you've finished building your workflow, <a data-key='activate'>activate</a> it to have it also listen continuously (you just won't see those executions here).",
		},
		inputs: [],
		//@ts-ignore
		outputs: ['main'],
		credentials: [{ name: 'modbusApi', required: true }],
		properties: [
			// ─── Function Code (read-only FCs) ───────────────────────────────
			{
				displayName: 'Function',
				name: 'function',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'FC01 — Read Coils',
						value: 'readCoils',
						description: 'Poll digital output (coil) status',
					},
					{
						name: 'FC02 — Read Discrete Inputs',
						value: 'readDiscreteInputs',
						description: 'Poll digital input status',
					},
					{
						name: 'FC03 — Read Holding Registers',
						value: 'readHoldingRegisters',
						description: 'Poll analog output registers',
					},
					{
						name: 'FC04 — Read Input Registers',
						value: 'readInputRegisters',
						description: 'Poll analog input registers',
					},
				],
				default: 'readHoldingRegisters',
			},

			// ─── Common ──────────────────────────────────────────────────────
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
			{
				displayName: 'Quantity',
				name: 'quantity',
				type: 'number',
				default: 1,
				description: 'Number of coils or registers to poll per cycle',
			},

			// ─── Data type: only for register reads ──────────────────────────
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
				displayOptions: {
					show: { function: ['readHoldingRegisters', 'readInputRegisters'] },
				},
			},

			// ─── Polling interval ────────────────────────────────────────────
			{
				displayName: 'Polling Interval (ms)',
				name: 'polling',
				type: 'number',
				default: 1000,
				description: 'How often to poll the device, in milliseconds',
			},

			// ─── Options ─────────────────────────────────────────────────────
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add option',
				default: {},
				options: [
					{
						displayName: 'Parallel Processing',
						name: 'parallelProcessing',
						type: 'boolean',
						default: false,
						description: 'Whether to allow the workflow to run again before the previous run finishes',
					},
				],
			},
		],
	};

	async trigger(this: ITriggerFunctions): Promise<ITriggerResponse> {
		let poller: NodeJS.Timeout;
		let client: IModbusClient;

		try {
			const credentials = await this.getCredentials<ModbusCredential>('modbusApi');
			const fc = this.getNodeParameter('function') as string;
			const memoryAddress = this.getNodeParameter('memoryAddress') as number;
			const unitId = this.getNodeParameter('unitId', 1) as number;
			const quantity = this.getNodeParameter('quantity') as number;
			const polling = this.getNodeParameter('polling') as number;
			const options = this.getNodeParameter('options') as Options;
			const extra = { unitId };

			const isRegisterRead = fc === 'readHoldingRegisters' || fc === 'readInputRegisters';
			const dataType = isRegisterRead
				? (this.getNodeParameter('dataType', 'int16') as ModbusDataType)
				: 'int16'; // unused for coil reads

			if (isNaN(memoryAddress)) {
				throw new NodeOperationError(this.getNode(), 'Memory address must be a valid number.');
			}

			client = await createClient(credentials);

			// Effective register quantity accounts for multi-register data types
			const registerQuantity = isRegisterRead ? quantity * registerCount(dataType) : quantity;

			// ── Generic poll function — returns the current raw value ─────────
			const poll = (
				cb: (
					err: Error | null,
					result: { buffers?: Buffer[]; bits?: boolean[] } | null,
				) => void,
			) => {
				if (isRegisterRead) {
					const readFn =
						fc === 'readHoldingRegisters'
							? client.readHoldingRegisters.bind(client)
							: client.readInputRegisters.bind(client);
					readFn({ address: memoryAddress, quantity: registerQuantity, extra }, (err, data) => {
						if (err) return cb(err, null);
						cb(null, { buffers: data?.response?.data });
					});
				} else {
					const readFn =
						fc === 'readCoils'
							? client.readCoils.bind(client)
							: client.readDiscreteInputs.bind(client);
					readFn({ address: memoryAddress, quantity, extra }, (err, data) => {
						if (err) return cb(err, null);
						cb(null, { bits: data?.response?.data });
					});
				}
			};

			// ── Comparison helpers ────────────────────────────────────────────
			const compareBuffers = (a?: Buffer[], b?: Buffer[]) => {
				if (!a || !b || a.length !== b.length) return false;
				return a.every((buf, i) => buf.equals(b[i]));
			};

			const compareBits = (a?: boolean[], b?: boolean[]) => {
				if (!a || !b || a.length !== b.length) return false;
				return a.every((v, i) => v === b[i]);
			};

			// ── Format output ─────────────────────────────────────────────────
			const formatResult = (result: {
				buffers?: Buffer[];
				bits?: boolean[];
			}): IDataObject => {
				if (isRegisterRead && result.buffers) {
					return {
						function: fc,
						address: memoryAddress,
						dataType,
						data: extractModbusData(this.getNode(), result.buffers, dataType),
					};
				}
				return {
					function: fc,
					address: memoryAddress,
					data: result.bits,
				};
			};

			// ── Active / workflow trigger mode ────────────────────────────────
			if (this.getMode() === 'trigger') {
				const donePromise = !options.parallelProcessing
					? this.helpers.createDeferredPromise<IRun>()
					: undefined;

				let previousBuffers: Buffer[] | undefined;
				let previousBits: boolean[] | undefined;

				poller = setInterval(() => {
					poll((err, result) => {
						if (err) {
							clearInterval(poller);
							throw new NodeOperationError(this.getNode(), err.message);
						}

						const changed = isRegisterRead
							? !compareBuffers(previousBuffers, result?.buffers)
							: !compareBits(previousBits, result?.bits);

						if (changed) {
							previousBuffers = result?.buffers;
							previousBits = result?.bits;
							this.emit([this.helpers.returnJsonArray([formatResult(result!)])]);
							if (donePromise) donePromise.promise;
						}
					});
				}, polling);
			}

			// ── Manual trigger (test) mode ────────────────────────────────────
			const manualTriggerFunction = async () => {
				return new Promise<void>((resolve, reject) => {
					let cycle = 0;
					let previousBuffers: Buffer[] | undefined;
					let previousBits: boolean[] | undefined;

					poller = setInterval(() => {
						poll((err, result) => {
							if (err) {
								clearInterval(poller);
								reject(new NodeOperationError(this.getNode(), err.message));
								return;
							}

							const changed = isRegisterRead
								? !compareBuffers(previousBuffers, result?.buffers)
								: !compareBits(previousBits, result?.bits);

							if (changed || cycle === 0) {
								previousBuffers = result?.buffers;
								previousBits = result?.bits;

								if (cycle > 0) {
									this.emit([this.helpers.returnJsonArray([formatResult(result!)])]);
									clearInterval(poller);
									resolve();
								}
								cycle++;
							}
						});
					}, polling);
				});
			};

			const closeFunction = async () => {
				clearInterval(poller);
				client.destroy();
			};

			return { closeFunction, manualTriggerFunction };
		} catch (error) {
			throw error;
		}
	}
}
