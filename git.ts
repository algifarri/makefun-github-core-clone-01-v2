// git.ts — pkt-line framing and packfile read/write.
//
// The wire pieces of the smart-HTTP protocol: pkt-line encode/decode
// (including an incremental decoder for request bodies), and packfiles
// written without deltas (cheap to produce) and read with full OFS/REF
// delta resolution (a real git client pushes deltas).

import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { hashObject, type GitObject, type GitObjectType } from './store.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

// ---------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface Pkt {
  kind: PktKind;
  payload: Buffer;
  raw: Buffer;
}

/** One data packet: 4 hex length bytes (payload + 4) then the payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.alloc(4);
  head.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, data]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');
export const RESPONSE_END = Buffer.from('0002', 'ascii');

export function encodePktLines(items: ReadonlyArray<string | Buffer | 'flush' | 'delim' | 'response-end'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(FLUSH);
    else if (item === 'delim') parts.push(DELIM);
    else if (item === 'response-end') parts.push(RESPONSE_END);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

const HEX4 = /^[0-9a-fA-F]{4}$/;

/**
 * Incremental pkt-line decoder. Push response chunks as they arrive;
 * `next()` returns a packet when one is complete, null when it needs more
 * bytes. `finish()` marks the stream ended. `takeBuffered()` drains any
 * bytes that were never framed (the raw pack after a receive-pack flush).
 */
export class PktDecoder {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private ended = false;

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.buffered += chunk.length;
  }

  finish(): void {
    this.ended = true;
  }

  get remaining(): number {
    return this.buffered;
  }

  takeBuffered(): Buffer {
    if (this.buffered === 0) return Buffer.alloc(0);
    const out = Buffer.concat(this.chunks, this.buffered);
    this.chunks = [];
    this.buffered = 0;
    return out;
  }

  private peek(n: number): Buffer | null {
    if (this.buffered < n) return null;
    const first = this.chunks[0]!;
    if (first.length >= n) return first.subarray(0, n);
    const out = Buffer.allocUnsafe(n);
    let filled = 0;
    for (const chunk of this.chunks) {
      const need = n - filled;
      if (need <= 0) break;
      const take = Math.min(need, chunk.length);
      chunk.copy(out, filled, 0, take);
      filled += take;
    }
    return out;
  }

  private take(n: number): Buffer {
    const first = this.chunks[0]!;
    if (first.length >= n) {
      if (first.length === n) this.chunks.shift();
      else this.chunks[0] = first.subarray(n);
      this.buffered -= n;
      return first.subarray(0, n);
    }
    const out = Buffer.allocUnsafe(n);
    let filled = 0;
    while (filled < n) {
      const chunk = this.chunks[0]!;
      const need = n - filled;
      if (chunk.length <= need) {
        chunk.copy(out, filled);
        filled += chunk.length;
        this.chunks.shift();
      } else {
        chunk.copy(out, filled, 0, need);
        this.chunks[0] = chunk.subarray(need);
        filled = n;
      }
    }
    this.buffered -= n;
    return out;
  }

  next(): Pkt | null {
    if (this.buffered < 4) {
      if (this.ended && this.buffered > 0) throw new Error(`truncated pkt-line: ${this.buffered} trailing byte(s)`);
      return null;
    }
    const head = this.peek(4)!;
    if (!HEX4.test(head.toString('ascii'))) throw new Error(`invalid pkt-line length ${JSON.stringify(head.toString('ascii'))}`);
    const length = Number.parseInt(head.toString('ascii'), 16);
    if (length === 0) {
      this.take(4);
      return { kind: 'flush', payload: Buffer.alloc(0), raw: Buffer.from('0000') };
    }
    if (length === 1) {
      this.take(4);
      return { kind: 'delim', payload: Buffer.alloc(0), raw: Buffer.from('0001') };
    }
    if (length === 2) {
      this.take(4);
      return { kind: 'response-end', payload: Buffer.alloc(0), raw: Buffer.from('0002') };
    }
    if (length === 3 || length > 65520) throw new Error(`invalid pkt-line length ${length}`);
    if (this.buffered < length) {
      if (this.ended) throw new Error(`truncated pkt-line: ${length} announced, ${this.buffered} available`);
      return null;
    }
    const raw = this.take(length);
    return { kind: 'data', payload: raw.subarray(4), raw };
  }
}

/** Decode a complete buffer into packets. */
export function decodePktLines(bytes: Buffer): Pkt[] {
  const decoder = new PktDecoder();
  decoder.push(bytes);
  decoder.finish();
  const out: Pkt[] = [];
  for (;;) {
    const packet = decoder.next();
    if (packet === null) break;
    out.push(packet);
  }
  return out;
}

// ---------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------

/** Write a packfile: PACK v2, every object zlib-deflated without deltas, SHA-1 trailer. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 4, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(list.length, 8);
  const parts: Buffer[] = [head];
  for (const object of list) {
    const typeCode = TYPE_CODE[object.type];
    const size = object.data.length;
    // Entry header: varint size, type in bits 4-6 of the first byte.
    const headerBytes: number[] = [];
    let remaining = size;
    let first = (typeCode << 4) | (remaining & 0x0f);
    remaining >>>= 4;
    if (remaining > 0) first |= 0x80;
    headerBytes.push(first);
    while (remaining > 0) {
      let byte = remaining & 0x7f;
      remaining >>>= 7;
      if (remaining > 0) byte |= 0x80;
      headerBytes.push(byte);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

interface RawEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start]!;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset++]!;
    value = ((value + 1) << 7) + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past it. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta (copy/insert instruction stream) to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += delta[offset++]! * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += delta[offset++]! * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

/**
 * Read a packfile (version 2 or 3) and resolve every object, including
 * OFS_DELTA and REF_DELTA. `resolveBase` supplies a base a thin pack
 * leaves out (the client already holds it). Every object's SHA-1 is
 * recomputed; a mismatch is an error.
 */
export function readPack(pack: Buffer, options: { resolveBase?: (oid: string) => GitObject | undefined } = {}): Map<string, GitObject> {
  const buffer = pack;
  if (buffer.length < 32) throw new Error(`pack is ${buffer.length} bytes, too short`);
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(buffer, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(buffer, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`);
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (CODE_TYPE[typeCode] === undefined) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(buffer.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();

  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    const cached = (entry as RawEntry & { resolved?: { type: GitObjectType; data: Buffer; oid: string } }).resolved;
    if (cached !== undefined) return cached;
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let result: { type: GitObjectType; data: Buffer; oid: string };
    if (entry.typeCode === 6 || entry.typeCode === 7) {
      let baseEntry: RawEntry | undefined;
      let baseObj: GitObject | undefined;
      if (entry.typeCode === 6) {
        baseEntry = byOffset.get(entry.baseOffset!);
        if (baseEntry === undefined) throw new Error(`ofs-delta base offset ${entry.baseOffset} is missing`);
        const base = resolve(baseEntry);
        baseObj = { type: base.type, data: base.data };
      } else {
        const found = resolvedByOid.get(entry.baseOid!);
        if (found !== undefined) {
          const base = resolve(found);
          baseObj = { type: base.type, data: base.data };
        } else if (options.resolveBase !== undefined) {
          baseObj = options.resolveBase(entry.baseOid!);
        }
        if (baseObj === undefined) throw new Error(`ref-delta base ${entry.baseOid} is not in the pack`);
      }
      const data = applyDelta(baseObj.data, entry.data);
      const type = baseObj.type;
      const oid = hashObject(type, data);
      result = { type, data, oid };
    } else {
      const type = CODE_TYPE[entry.typeCode]!;
      const oid = hashObject(type, entry.data);
      result = { type, data: entry.data, oid };
    }
    resolving.delete(entry.offset);
    (entry as RawEntry & { resolved?: { type: GitObjectType; data: Buffer; oid: string } }).resolved = result;
    resolvedByOid.set(result.oid, entry);
    objects.set(result.oid, { type: result.type, data: result.data });
    return result;
  };

  for (const entry of raw) resolve(entry);
  return objects;
}
