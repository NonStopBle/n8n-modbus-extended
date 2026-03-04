![Banner image](https://user-images.githubusercontent.com/10284570/173569848-c624317f-42b1-45a6-ab09-f0ea3c247648.png)

# n8n-nodes-modbus

A community node for [n8n](https://n8n.io) that lets you read and write data to Modbus TCP devices, and trigger workflows when register values change.

Supports both standard **Modbus TCP** (with MBAP header) and **raw Modbus RTU-over-TCP** (no MBAP), making it compatible with a wide range of PLCs, sensors, and serial-to-Ethernet converters.

---

## Installation

Follow the [community nodes installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in the n8n documentation.

---

## Nodes

### MODBUS

A regular node for reading from or writing to holding registers on demand.

| Operation | Description |
|-----------|-------------|
| Read | Read one or more holding registers starting at a given address |
| Write | Write a value to a holding register at a given address |

**Parameters**

| Parameter | Description |
|-----------|-------------|
| Operation | `Read` or `Write` |
| Memory Address | The register index to target |
| Unit-ID | Device address for Modbus bridges / gateways (default `1`) |
| Data Type | Integer width and signedness: `int16`, `uint16`, `int32`, `uint32`, `int64`, `uint64` |
| Quantity *(Read only)* | Number of values to read |
| Value *(Write only)* | The value to write (validated against the selected data type range) |

---

### MODBUS Trigger

A trigger node that polls a holding register at a fixed interval and fires the workflow whenever the value changes.

**Parameters**

| Parameter | Description |
|-----------|-------------|
| Memory Address | The register index to poll |
| Unit-ID | Device address for Modbus bridges / gateways (default `1`) |
| Data Type | Integer width and signedness |
| Quantity | Number of values to poll |
| Polling | Interval between polls in milliseconds (default `1000`) |

---

## Credentials

Create a **MODBUS API** credential and fill in the following fields:

| Field | Description | Default |
|-------|-------------|---------|
| Host | IP address or hostname of the Modbus device | — |
| Port | TCP port | `502` |
| Enable MBAP Header | Toggle between Modbus TCP and raw RTU-over-TCP mode (see below) | `true` |

### MBAP Header — Modbus TCP vs Raw RTU-over-TCP

This setting controls the framing format used on the wire.

**Enabled (default)** — Standard **Modbus TCP** mode. Every request and response is wrapped in a 6-byte MBAP (Modbus Application Protocol) header containing a Transaction ID, Protocol ID, and Length field. This is correct for the vast majority of modern Modbus TCP devices.

**Disabled** — **Raw Modbus RTU-over-TCP** mode. Frames are sent as plain RTU packets (Unit ID + Function Code + Data + CRC-16) with no MBAP wrapper. Use this for devices that operate in serial passthrough or transparent mode, such as:
- Serial-to-Ethernet converters (e.g. Moxa, Lantronix, USR-TCP232)
- Some older PLCs and VFDs exposed over Ethernet without a proper Modbus TCP stack
- Any device that echoes raw RS-485 RTU frames over a TCP socket

If you are seeing connection timeouts or malformed-response errors and your device is a serial converter, try disabling this option.

---

## Supported Data Types

| Type | Size | Range |
|------|------|-------|
| `int16` | 1 register | −32 768 to 32 767 |
| `uint16` | 1 register | 0 to 65 535 |
| `int32` | 2 registers | −2 147 483 648 to 2 147 483 647 |
| `uint32` | 2 registers | 0 to 4 294 967 295 |
| `int64` | 4 registers | −9.2 × 10¹⁸ to 9.2 × 10¹⁸ |
| `uint64` | 4 registers | 0 to 1.8 × 10¹⁹ |

Multi-register types (`int32`, `uint32`, `int64`, `uint64`) are read and written in **big-endian** word order.

---

## Support

If you run into a bug or have a feature request, please open an issue on the [GitHub repository](https://github.com/lostedz/n8n-nodes-modbus).
