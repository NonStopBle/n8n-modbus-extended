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
// Unified client interface
// Both the standard modbus-stream client and the raw RTU-over-TCP client
// expose the same three methods used by the nodes.
// ---------------------------------------------------------------------------

export interface IModbusClient {
	readHoldingRegisters(
		options: { address: number; quantity: number; extra?: { unitId?: number } },
		cb: (err: Error | null, data: { response: { data: Buffer[] } } | null) => void,
	): void;

	writeSingleRegister(
		options: { address: number; value: Buffer; extra?: { unitId?: number } },
		cb: (err: Error | null, data: { response: unknown } | null) => void,
	): void;

	writeMultipleRegisters(
		options: { address: number; values: Buffer[]; extra?: { unitId?: number } },
		cb: (err: Error | null, data: { response: unknown } | null) => void,
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
	result.writeUInt16LE(crc, 0); // Modbus CRC is little-endian
	return result;
}

// ---------------------------------------------------------------------------
// Raw Modbus RTU-over-TCP client (no MBAP header)
// ---------------------------------------------------------------------------

class RawModbusClient implements IModbusClient {
	private socket: net.Socket;
	private transactionId = 0;

	constructor(socket: net.Socket) {
		this.socket = socket;
	}

	private nextId(): number {
		this.transactionId = (this.transactionId + 1) & 0xffff;
		return this.transactionId;
	}

	/**
	 * Build a raw Modbus RTU frame (no MBAP):
	 *   [unitId, funcCode, ...pduBytes, CRC_lo, CRC_hi]
	 */
	private buildFrame(unitId: number, funcCode: number, pdu: Buffer): Buffer {
		const header = Buffer.alloc(2);
		header[0] = unitId & 0xff;
		header[1] = funcCode & 0xff;
		const body = Buffer.concat([header, pdu]);
		const crc = crc16(body);
		return Buffer.concat([body, crc]);
	}

	/**
	 * Send a frame and collect the response.
	 * We read until we have at least `minBytes` bytes, then return.
	 */
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

	readHoldingRegisters(
		options: { address: number; quantity: number; extra?: { unitId?: number } },
		cb: (err: Error | null, data: { response: { data: Buffer[] } } | null) => void,
	): void {
		const unitId = options.extra?.unitId ?? 1;
		const pdu = Buffer.alloc(4);
		pdu.writeUInt16BE(options.address, 0);
		pdu.writeUInt16BE(options.quantity, 2);

		const frame = this.buildFrame(unitId, 0x03, pdu);

		// Response: [unitId(1), fc(1), byteCount(1), data(byteCount), CRC(2)]
		// Minimum: 5 bytes + data
		const minResponseBytes = 3 + options.quantity * 2 + 2;

		this.sendRaw(frame, minResponseBytes, 5000, (err, raw) => {
			if (err) return cb(err, null);
			if (!raw || raw.length < 5) return cb(new Error('MODBUS raw: short response'), null);

			// Verify function code
			if (raw[1] & 0x80) {
				const exCode = raw[2];
				return cb(new Error(`MODBUS exception code: 0x${exCode.toString(16)}`), null);
			}

			const byteCount = raw[2];
			const dataRegisters: Buffer[] = [];
			for (let i = 0; i < byteCount; i += 2) {
				const reg = Buffer.alloc(2);
				raw.copy(reg, 0, 3 + i, 3 + i + 2);
				dataRegisters.push(reg);
			}

			cb(null, { response: { data: dataRegisters } });
		});
	}

	writeSingleRegister(
		options: { address: number; value: Buffer; extra?: { unitId?: number } },
		cb: (err: Error | null, data: { response: unknown } | null) => void,
	): void {
		const unitId = options.extra?.unitId ?? 1;
		const pdu = Buffer.alloc(4);
		pdu.writeUInt16BE(options.address, 0);
		options.value.copy(pdu, 2, 0, 2);

		const frame = this.buildFrame(unitId, 0x06, pdu);
		// Echo response: [unitId, fc, addr_hi, addr_lo, val_hi, val_lo, CRC(2)] = 8 bytes
		this.sendRaw(frame, 8, 5000, (err, raw) => {
			if (err) return cb(err, null);
			if (!raw || raw.length < 6) return cb(new Error('MODBUS raw: short write response'), null);
			if (raw[1] & 0x80) return cb(new Error(`MODBUS exception 0x${raw[2].toString(16)}`), null);
			cb(null, { response: { address: options.address, value: options.value } });
		});
	}

	writeMultipleRegisters(
		options: { address: number; values: Buffer[]; extra?: { unitId?: number } },
		cb: (err: Error | null, data: { response: unknown } | null) => void,
	): void {
		const unitId = options.extra?.unitId ?? 1;
		const quantity = options.values.length;
		const byteCount = quantity * 2;
		const pdu = Buffer.alloc(5 + byteCount);
		pdu.writeUInt16BE(options.address, 0);
		pdu.writeUInt16BE(quantity, 2);
		pdu[4] = byteCount;
		options.values.forEach((v, i) => v.copy(pdu, 5 + i * 2));

		const frame = this.buildFrame(unitId, 0x10, pdu);
		// Response: [unitId, fc, addr_hi, addr_lo, qty_hi, qty_lo, CRC(2)] = 8 bytes
		this.sendRaw(frame, 8, 5000, (err, raw) => {
			if (err) return cb(err, null);
			if (!raw || raw.length < 6) return cb(new Error('MODBUS raw: short write response'), null);
			if (raw[1] & 0x80) return cb(new Error(`MODBUS exception 0x${raw[2].toString(16)}`), null);
			cb(null, { response: { address: options.address, quantity } });
		});
	}

	destroy(): void {
		this.socket.destroy();
	}
}

// ---------------------------------------------------------------------------
// MBAP-wrapped (standard Modbus TCP) client adapter
// Wraps modbus-stream's TCPStream so it conforms to IModbusClient
// ---------------------------------------------------------------------------

class MbapModbusClient implements IModbusClient {
	constructor(private inner: modbus.TCPStream) {}

	readHoldingRegisters(
		options: { address: number; quantity: number; extra?: { unitId?: number } },
		cb: (err: Error | null, data: { response: { data: Buffer[] } } | null) => void,
	): void {
		this.inner.readHoldingRegisters(options as any, cb as any);
	}

	writeSingleRegister(
		options: { address: number; value: Buffer; extra?: { unitId?: number } },
		cb: (err: Error | null, data: { response: unknown } | null) => void,
	): void {
		this.inner.writeSingleRegister(options as any, cb as any);
	}

	writeMultipleRegisters(
		options: { address: number; values: Buffer[]; extra?: { unitId?: number } },
		cb: (err: Error | null, data: { response: unknown } | null) => void,
	): void {
		this.inner.writeMultipleRegisters(options as any, cb as any);
	}

	destroy(): void {
		this.inner.destroy();
	}
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export const createClient = async (credentials: ModbusCredential): Promise<IModbusClient> => {
	const { host, port, timeout = 5000, enableMbapHeader = true } = credentials;

	if (enableMbapHeader) {
		// Standard Modbus TCP with MBAP header via modbus-stream
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
		// Raw Modbus RTU-over-TCP (no MBAP header)
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
// Data helpers (unchanged)
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
