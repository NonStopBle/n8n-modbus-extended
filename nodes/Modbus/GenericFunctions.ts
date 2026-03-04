import modbus from 'modbus-stream';
import * as net from 'net';
import { ApplicationError, INode, NodeOperationError } from 'n8n-workflow';
import { ModbusDataType } from './types';

// ---------------------------------------------------------------------------
// Credential shape
// ---------------------------------------------------------------------------

interface BaseModbusCredential {
	host: string;
	port: number;
	timeout: number;
	/** When false the MBAP wrapper is stripped and raw Modbus RTU frames are used */
	enableMbapHeader: boolean;
}

export type ModbusCredential = BaseModbusCredential;

// ---------------------------------------------------------------------------
// Shared option shapes
// ---------------------------------------------------------------------------

export interface ReadOptions {
	address: number;
	quantity: number;
	extra?: { unitId?: number };
}

export interface WriteCoilOptions {
	address: number;
	/** true = ON (0xFF00), false = OFF (0x0000) */
	value: boolean;
	extra?: { unitId?: number };
}

export interface WriteMultipleCoilsOptions {
	address: number;
	values: boolean[];
	extra?: { unitId?: number };
}

export interface WriteRegisterOptions {
	address: number;
	value: Buffer; // 2-byte big-endian
	extra?: { unitId?: number };
}

export interface WriteMultipleRegistersOptions {
	address: number;
	values: Buffer[]; // array of 2-byte big-endian buffers
	extra?: { unitId?: number };
}

export interface CoilResponse {
	response: { data: boolean[] };
}

export interface RegisterResponse {
	response: { data: Buffer[] };
}

export interface WriteResponse {
	response: unknown;
}

// ---------------------------------------------------------------------------
// Unified client interface — all 8 standard Modbus function codes
// ---------------------------------------------------------------------------

export interface IModbusClient {
	// FC01 — Read Coils (digital outputs)
	readCoils(options: ReadOptions, cb: (err: Error | null, data: CoilResponse | null) => void): void;

	// FC02 — Read Discrete Inputs (digital inputs, read-only)
	readDiscreteInputs(
		options: ReadOptions,
		cb: (err: Error | null, data: CoilResponse | null) => void,
	): void;

	// FC03 — Read Holding Registers (analog outputs, read/write)
	readHoldingRegisters(
		options: ReadOptions,
		cb: (err: Error | null, data: RegisterResponse | null) => void,
	): void;

	// FC04 — Read Input Registers (analog inputs, read-only)
	readInputRegisters(
		options: ReadOptions,
		cb: (err: Error | null, data: RegisterResponse | null) => void,
	): void;

	// FC05 — Write Single Coil
	writeSingleCoil(
		options: WriteCoilOptions,
		cb: (err: Error | null, data: WriteResponse | null) => void,
	): void;

	// FC06 — Write Single Register
	writeSingleRegister(
		options: WriteRegisterOptions,
		cb: (err: Error | null, data: WriteResponse | null) => void,
	): void;

	// FC0F (15) — Write Multiple Coils
	writeMultipleCoils(
		options: WriteMultipleCoilsOptions,
		cb: (err: Error | null, data: WriteResponse | null) => void,
	): void;

	// FC10 (16) — Write Multiple Registers
	writeMultipleRegisters(
		options: WriteMultipleRegistersOptions,
		cb: (err: Error | null, data: WriteResponse | null) => void,
	): void;

	destroy(): void;
}

// ---------------------------------------------------------------------------
// CRC-16/IBM (Modbus) helper
// ---------------------------------------------------------------------------

function crc16(buffer: Buffer): Buffer {
	let crc = 0xffff;
	for (let i = 0; i < buffer.length; i++) {
		crc ^= buffer[i];
		for (let j = 0; j < 8; j++) {
			if (crc & 0x0001) {
				crc = (crc >> 1) ^ 0xa001;
			} else {
				crc >>= 1;
			}
		}
	}
	const result = Buffer.alloc(2);
	result.writeUInt16LE(crc, 0);
	return result;
}

// ---------------------------------------------------------------------------
// Bit-unpack helper for coil/discrete responses
// FC01 and FC02 pack bits LSB-first: bit0 of byte0 = coil 0, bit1 = coil 1, …
// ---------------------------------------------------------------------------

function unpackBits(data: Buffer, quantity: number): boolean[] {
	const result: boolean[] = [];
	for (let i = 0; i < quantity; i++) {
		const byteIdx = Math.floor(i / 8);
		const bitIdx = i % 8;
		result.push(((data[byteIdx] >> bitIdx) & 0x01) === 1);
	}
	return result;
}

// Pack boolean array into bit-packed bytes (LSB first) for FC0F
function packBits(values: boolean[]): Buffer {
	const byteCount = Math.ceil(values.length / 8);
	const buf = Buffer.alloc(byteCount, 0);
	values.forEach((v, i) => {
		if (v) buf[Math.floor(i / 8)] |= 1 << (i % 8);
	});
	return buf;
}

// ---------------------------------------------------------------------------
// Raw Modbus RTU-over-TCP client (no MBAP header)
// ---------------------------------------------------------------------------

class RawModbusClient implements IModbusClient {
	constructor(private socket: net.Socket) {}

	/** Build a raw RTU frame: [unitId, fc, ...pdu, CRC_lo, CRC_hi] */
	private buildFrame(unitId: number, funcCode: number, pdu: Buffer): Buffer {
		const header = Buffer.from([unitId & 0xff, funcCode & 0xff]);
		const body = Buffer.concat([header, pdu]);
		return Buffer.concat([body, crc16(body)]);
	}

	/** Send frame and wait for at least minBytes of response */
	private sendRaw(
		frame: Buffer,
		minBytes: number,
		timeout: number,
		cb: (err: Error | null, raw: Buffer | null) => void,
	): void {
		const chunks: Buffer[] = [];
		let received = 0;
		let done = false;

		const timer = setTimeout(() => {
			if (!done) {
				done = true;
				this.socket.removeListener('data', onData);
				this.socket.removeListener('error', onError);
				cb(new Error('MODBUS raw timeout waiting for response'), null);
			}
		}, timeout);

		const onData = (chunk: Buffer) => {
			chunks.push(chunk);
			received += chunk.length;
			if (received >= minBytes && !done) {
				done = true;
				clearTimeout(timer);
				this.socket.removeListener('data', onData);
				this.socket.removeListener('error', onError);
				cb(null, Buffer.concat(chunks));
			}
		};

		const onError = (err: Error) => {
			if (!done) {
				done = true;
				clearTimeout(timer);
				this.socket.removeListener('data', onData);
				cb(err, null);
			}
		};

		this.socket.on('data', onData);
		this.socket.once('error', onError);
		this.socket.write(frame);
	}

	/** Shared logic for FC01 and FC02 (bit-packed coil response) */
	private readBits(
		funcCode: number,
		options: ReadOptions,
		cb: (err: Error | null, data: CoilResponse | null) => void,
	): void {
		const unitId = options.extra?.unitId ?? 1;
		const pdu = Buffer.alloc(4);
		pdu.writeUInt16BE(options.address, 0);
		pdu.writeUInt16BE(options.quantity, 2);

		const byteCount = Math.ceil(options.quantity / 8);
		// [unitId, fc, byteCount, data..., CRC(2)]
		const minResponseBytes = 3 + byteCount + 2;

		this.sendRaw(this.buildFrame(unitId, funcCode, pdu), minResponseBytes, 5000, (err, raw) => {
			if (err) return cb(err, null);
			if (!raw || raw.length < 5) return cb(new Error('MODBUS raw: short coil response'), null);
			if (raw[1] & 0x80) return cb(new Error(`MODBUS exception 0x${raw[2].toString(16)}`), null);

			const dataBytes = raw.slice(3, 3 + raw[2]);
			cb(null, { response: { data: unpackBits(dataBytes, options.quantity) } });
		});
	}

	/** Shared logic for FC03 and FC04 (register response) */
	private readRegisters(
		funcCode: number,
		options: ReadOptions,
		cb: (err: Error | null, data: RegisterResponse | null) => void,
	): void {
		const unitId = options.extra?.unitId ?? 1;
		const pdu = Buffer.alloc(4);
		pdu.writeUInt16BE(options.address, 0);
		pdu.writeUInt16BE(options.quantity, 2);

		// [unitId, fc, byteCount, data(qty*2), CRC(2)]
		const minResponseBytes = 3 + options.quantity * 2 + 2;

		this.sendRaw(this.buildFrame(unitId, funcCode, pdu), minResponseBytes, 5000, (err, raw) => {
			if (err) return cb(err, null);
			if (!raw || raw.length < 5) return cb(new Error('MODBUS raw: short register response'), null);
			if (raw[1] & 0x80) return cb(new Error(`MODBUS exception 0x${raw[2].toString(16)}`), null);

			const byteCount = raw[2];
			const registers: Buffer[] = [];
			for (let i = 0; i < byteCount; i += 2) {
				const reg = Buffer.alloc(2);
				raw.copy(reg, 0, 3 + i, 3 + i + 2);
				registers.push(reg);
			}
			cb(null, { response: { data: registers } });
		});
	}

	readCoils(options: ReadOptions, cb: (err: Error | null, data: CoilResponse | null) => void): void {
		this.readBits(0x01, options, cb);
	}

	readDiscreteInputs(
		options: ReadOptions,
		cb: (err: Error | null, data: CoilResponse | null) => void,
	): void {
		this.readBits(0x02, options, cb);
	}

	readHoldingRegisters(
		options: ReadOptions,
		cb: (err: Error | null, data: RegisterResponse | null) => void,
	): void {
		this.readRegisters(0x03, options, cb);
	}

	readInputRegisters(
		options: ReadOptions,
		cb: (err: Error | null, data: RegisterResponse | null) => void,
	): void {
		this.readRegisters(0x04, options, cb);
	}

	writeSingleCoil(
		options: WriteCoilOptions,
		cb: (err: Error | null, data: WriteResponse | null) => void,
	): void {
		const unitId = options.extra?.unitId ?? 1;
		const pdu = Buffer.alloc(4);
		pdu.writeUInt16BE(options.address, 0);
		pdu.writeUInt16BE(options.value ? 0xff00 : 0x0000, 2);

		// Echo response: [unitId, fc, addr(2), val(2), CRC(2)] = 8 bytes
		this.sendRaw(this.buildFrame(unitId, 0x05, pdu), 8, 5000, (err, raw) => {
			if (err) return cb(err, null);
			if (!raw || raw.length < 6) return cb(new Error('MODBUS raw: short coil write response'), null);
			if (raw[1] & 0x80) return cb(new Error(`MODBUS exception 0x${raw[2].toString(16)}`), null);
			cb(null, { response: { address: options.address, value: options.value } });
		});
	}

	writeSingleRegister(
		options: WriteRegisterOptions,
		cb: (err: Error | null, data: WriteResponse | null) => void,
	): void {
		const unitId = options.extra?.unitId ?? 1;
		const pdu = Buffer.alloc(4);
		pdu.writeUInt16BE(options.address, 0);
		options.value.copy(pdu, 2, 0, 2);

		// Echo response: 8 bytes
		this.sendRaw(this.buildFrame(unitId, 0x06, pdu), 8, 5000, (err, raw) => {
			if (err) return cb(err, null);
			if (!raw || raw.length < 6) return cb(new Error('MODBUS raw: short register write response'), null);
			if (raw[1] & 0x80) return cb(new Error(`MODBUS exception 0x${raw[2].toString(16)}`), null);
			cb(null, { response: { address: options.address, value: options.value } });
		});
	}

	writeMultipleCoils(
		options: WriteMultipleCoilsOptions,
		cb: (err: Error | null, data: WriteResponse | null) => void,
	): void {
		const unitId = options.extra?.unitId ?? 1;
		const packed = packBits(options.values);
		const pdu = Buffer.alloc(5 + packed.length);
		pdu.writeUInt16BE(options.address, 0);
		pdu.writeUInt16BE(options.values.length, 2);
		pdu[4] = packed.length;
		packed.copy(pdu, 5);

		// Response: [unitId, fc, addr(2), qty(2), CRC(2)] = 8 bytes
		this.sendRaw(this.buildFrame(unitId, 0x0f, pdu), 8, 5000, (err, raw) => {
			if (err) return cb(err, null);
			if (!raw || raw.length < 6) return cb(new Error('MODBUS raw: short coil write response'), null);
			if (raw[1] & 0x80) return cb(new Error(`MODBUS exception 0x${raw[2].toString(16)}`), null);
			cb(null, { response: { address: options.address, quantity: options.values.length } });
		});
	}

	writeMultipleRegisters(
		options: WriteMultipleRegistersOptions,
		cb: (err: Error | null, data: WriteResponse | null) => void,
	): void {
		const unitId = options.extra?.unitId ?? 1;
		const byteCount = options.values.length * 2;
		const pdu = Buffer.alloc(5 + byteCount);
		pdu.writeUInt16BE(options.address, 0);
		pdu.writeUInt16BE(options.values.length, 2);
		pdu[4] = byteCount;
		options.values.forEach((v, i) => v.copy(pdu, 5 + i * 2));

		// Response: [unitId, fc, addr(2), qty(2), CRC(2)] = 8 bytes
		this.sendRaw(this.buildFrame(unitId, 0x10, pdu), 8, 5000, (err, raw) => {
			if (err) return cb(err, null);
			if (!raw || raw.length < 6) return cb(new Error('MODBUS raw: short register write response'), null);
			if (raw[1] & 0x80) return cb(new Error(`MODBUS exception 0x${raw[2].toString(16)}`), null);
			cb(null, { response: { address: options.address, quantity: options.values.length } });
		});
	}

	destroy(): void {
		this.socket.destroy();
	}
}

// ---------------------------------------------------------------------------
// MBAP-wrapped (standard Modbus TCP) client adapter
// ---------------------------------------------------------------------------

class MbapModbusClient implements IModbusClient {
	constructor(private inner: modbus.TCPStream) {}

	readCoils(options: ReadOptions, cb: (err: Error | null, data: CoilResponse | null) => void): void {
		(this.inner as any).readCoils(options, (err: Error | null, res: any) => {
			if (err || !res) return cb(err, null);
			// modbus-stream returns Buffer[] for coils — unpack them
			const raw: Buffer[] = res?.response?.data ?? [];
			const bits: boolean[] = [];
			raw.forEach((b) => {
				for (let i = 0; i < 8 && bits.length < options.quantity; i++) {
					bits.push(((b[0] >> i) & 1) === 1);
				}
			});
			cb(null, { response: { data: bits } });
		});
	}

	readDiscreteInputs(
		options: ReadOptions,
		cb: (err: Error | null, data: CoilResponse | null) => void,
	): void {
		(this.inner as any).readDiscreteInputs(options, (err: Error | null, res: any) => {
			if (err || !res) return cb(err, null);
			const raw: Buffer[] = res?.response?.data ?? [];
			const bits: boolean[] = [];
			raw.forEach((b) => {
				for (let i = 0; i < 8 && bits.length < options.quantity; i++) {
					bits.push(((b[0] >> i) & 1) === 1);
				}
			});
			cb(null, { response: { data: bits } });
		});
	}

	readHoldingRegisters(
		options: ReadOptions,
		cb: (err: Error | null, data: RegisterResponse | null) => void,
	): void {
		this.inner.readHoldingRegisters(options as any, cb as any);
	}

	readInputRegisters(
		options: ReadOptions,
		cb: (err: Error | null, data: RegisterResponse | null) => void,
	): void {
		(this.inner as any).readInputRegisters(options, cb);
	}

	writeSingleCoil(
		options: WriteCoilOptions,
		cb: (err: Error | null, data: WriteResponse | null) => void,
	): void {
		(this.inner as any).writeSingleCoil(
			{ address: options.address, value: options.value ? 0xff00 : 0x0000, extra: options.extra },
			cb,
		);
	}

	writeSingleRegister(
		options: WriteRegisterOptions,
		cb: (err: Error | null, data: WriteResponse | null) => void,
	): void {
		this.inner.writeSingleRegister(options as any, cb as any);
	}

	writeMultipleCoils(
		options: WriteMultipleCoilsOptions,
		cb: (err: Error | null, data: WriteResponse | null) => void,
	): void {
		// modbus-stream expects values as Buffer[] of single bytes
		const packed = packBits(options.values);
		const bufs: Buffer[] = [];
		for (let i = 0; i < packed.length; i++) {
			bufs.push(Buffer.from([packed[i]]));
		}
		(this.inner as any).writeMultipleCoils(
			{ address: options.address, values: bufs, extra: options.extra },
			cb,
		);
	}

	writeMultipleRegisters(
		options: WriteMultipleRegistersOptions,
		cb: (err: Error | null, data: WriteResponse | null) => void,
	): void {
		this.inner.writeMultipleRegisters(options as any, cb as any);
	}

	destroy(): void {
		(this.inner as unknown as { socket?: { destroy(): void }; destroy?(): void })
			?.socket?.destroy();
	}
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export const createClient = async (credentials: ModbusCredential): Promise<IModbusClient> => {
	const { host, port, timeout = 5000, enableMbapHeader = true } = credentials;

	if (enableMbapHeader) {
		return new Promise((resolve, reject) => {
			modbus.tcp.connect(port, host, { debug: null, connectTimeout: timeout }, (err, client) => {
				if (err) {
					reject(new ApplicationError(err.message));
					return;
				}
				resolve(new MbapModbusClient(client));
			});
		});
	} else {
		return new Promise((resolve, reject) => {
			const socket = net.createConnection({ host, port });
			const timer = setTimeout(() => {
				socket.destroy();
				reject(new ApplicationError(`Raw Modbus TCP connection to ${host}:${port} timed out`));
			}, timeout);

			socket.once('connect', () => {
				clearTimeout(timer);
				resolve(new RawModbusClient(socket));
			});

			socket.once('error', (err) => {
				clearTimeout(timer);
				reject(new ApplicationError(err.message));
			});
		});
	}
};

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------

export function registerCount(dataType: ModbusDataType): number {
	if (dataType.endsWith('32')) return 2;
	if (dataType.endsWith('64')) return 4;
	return 1;
}

export function extractModbusData(
	node: INode,
	data: Buffer[],
	dataType: ModbusDataType,
): Array<number | bigint> {
	const registersPerItem = registerCount(dataType);
	if (data.length % registersPerItem !== 0) {
		throw new NodeOperationError(node, 'MODBUS Error: data is not aligned');
	}
	const mergedData: Buffer[] = [];
	for (let i = 0; i < data.length; i += registersPerItem) {
		if (registersPerItem === 1) {
			mergedData.push(data[i]);
		} else {
			const buf = Buffer.alloc(registersPerItem * 2);
			for (let j = 0; j < registersPerItem; j++) {
				data[i + j].copy(buf, j * 2);
			}
			mergedData.push(buf);
		}
	}
	return mergedData.map((buffer) => {
		switch (dataType) {
			case 'int16':
				return buffer.readInt16BE();
			case 'uint16':
				return buffer.readUInt16BE();
			case 'int32':
				return buffer.readInt32BE();
			case 'uint32':
				return buffer.readUInt32BE();
			case 'int64':
				return buffer.readBigInt64BE();
			case 'uint64':
				return buffer.readBigUInt64BE();
		}
	});
}
