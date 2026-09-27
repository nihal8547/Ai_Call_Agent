import OpusScript from "opusscript";

/**
 * WhatsApp voice notes are Opus audio in an Ogg container (RFC 7845), mono. Encoding and decoding
 * use libopus compiled to WebAssembly (opusscript), so no ffmpeg or native module is needed; the
 * Ogg framing (RFC 3533) is written here.
 */

type Rate = 8000 | 12000 | 16000 | 24000 | 48000;

/** Opus granule positions always count 48 kHz samples */
const GRANULE_RATE = 48_000;
/** Encoder look-ahead at 48 kHz (libopus default): decoders drop these samples */
const PRE_SKIP = 312;
const FRAME_MS = 20;

// ── Ogg pages ───────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();

function oggCrc(buf: Buffer): number {
  let crc = 0;
  for (const b of buf) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ b) & 0xff]!) >>> 0;
  return crc;
}

function page(o: { serial: number; seq: number; granule: bigint; flags: number; packets: Buffer[] }): Buffer {
  const lacing: number[] = [];
  for (const p of o.packets) {
    let n = p.length;
    while (n >= 255) {
      lacing.push(255);
      n -= 255;
    }
    lacing.push(n);
  }
  if (lacing.length > 255) throw new Error("Too many segments in one Ogg page");
  const header = Buffer.alloc(27 + lacing.length);
  header.write("OggS", 0, "ascii");
  header.writeUInt8(0, 4); // version
  header.writeUInt8(o.flags, 5);
  header.writeBigInt64LE(o.granule, 6);
  header.writeUInt32LE(o.serial, 14);
  header.writeUInt32LE(o.seq, 18);
  header.writeUInt32LE(0, 22); // CRC, filled below
  header.writeUInt8(lacing.length, 26);
  lacing.forEach((v, i) => header.writeUInt8(v, 27 + i));
  const out = Buffer.concat([header, ...o.packets]);
  out.writeUInt32LE(oggCrc(out), 22);
  return out;
}

type OggPacket = { data: Buffer; granule: bigint };

/** Packets of an Ogg stream (pages checked by CRC); throws on anything that isn't Ogg */
function readOgg(buf: Buffer): OggPacket[] {
  const packets: OggPacket[] = [];
  let partial: Buffer[] = [];
  let at = 0;
  while (at < buf.length) {
    if (buf.toString("ascii", at, at + 4) !== "OggS") throw new Error("Not an Ogg file");
    const segments = buf.readUInt8(at + 26);
    const headerLen = 27 + segments;
    const lacing = [...buf.subarray(at + 27, at + headerLen)];
    const bodyLen = lacing.reduce((a, b) => a + b, 0);
    const pageBuf = Buffer.from(buf.subarray(at, at + headerLen + bodyLen));
    const crc = pageBuf.readUInt32LE(22);
    pageBuf.writeUInt32LE(0, 22);
    if (oggCrc(pageBuf) !== crc) throw new Error("Damaged Ogg page");
    const granule = buf.readBigInt64LE(at + 6);
    let offset = at + headerLen;
    for (const len of lacing) {
      partial.push(buf.subarray(offset, offset + len));
      offset += len;
      if (len < 255) {
        packets.push({ data: Buffer.concat(partial), granule });
        partial = [];
      }
    }
    at += headerLen + bodyLen;
  }
  return packets;
}

// ── Encoding ────────────────────────────────────────────────────────────────

/**
 * Mono 16-bit PCM → an Ogg/Opus voice note WhatsApp plays as a voice message.
 * `sampleRate` must be one Opus supports (Gemini speech is 24 kHz).
 */
export function encodeVoiceNote(
  pcm: Buffer,
  sampleRate: Rate,
  bitrate = 24_000,
): { ogg: Buffer; seconds: number } {
  const encoder = new OpusScript(sampleRate, 1, OpusScript.Application.VOIP);
  try {
    encoder.setBitrate(bitrate);
    const frame = (sampleRate * FRAME_MS) / 1000;
    const frameBytes = frame * 2;
    const granulePerFrame = BigInt((GRANULE_RATE * FRAME_MS) / 1000);
    const serial = Math.floor(Math.random() * 0xffffffff) >>> 0;
    let seq = 0;

    const head = Buffer.alloc(19);
    head.write("OpusHead", 0, "ascii");
    head.writeUInt8(1, 8); // version
    head.writeUInt8(1, 9); // mono
    head.writeUInt16LE(PRE_SKIP, 10);
    head.writeUInt32LE(sampleRate, 12);
    head.writeInt16LE(0, 16); // gain
    head.writeUInt8(0, 18); // mapping family
    const vendor = Buffer.from("platform-whatsapp", "utf8");
    const tags = Buffer.alloc(8 + 4 + vendor.length + 4);
    tags.write("OpusTags", 0, "ascii");
    tags.writeUInt32LE(vendor.length, 8);
    vendor.copy(tags, 12);
    tags.writeUInt32LE(0, 12 + vendor.length);

    const pages = [
      page({ serial, seq: seq++, granule: 0n, flags: 0x02, packets: [head] }),
      page({ serial, seq: seq++, granule: 0n, flags: 0, packets: [tags] }),
    ];

    const frames = Math.max(1, Math.ceil(pcm.length / frameBytes));
    let granule = BigInt(PRE_SKIP);
    let batch: Buffer[] = [];
    for (let i = 0; i < frames; i++) {
      let chunk = pcm.subarray(i * frameBytes, (i + 1) * frameBytes);
      if (chunk.length < frameBytes) chunk = Buffer.concat([chunk, Buffer.alloc(frameBytes - chunk.length)]);
      batch.push(Buffer.from(encoder.encode(chunk, frame)));
      granule += granulePerFrame;
      const last = i === frames - 1;
      // About one second per page (well under 255 segments for voice bitrates)
      if (batch.length === 50 || last) {
        pages.push(page({ serial, seq: seq++, granule, flags: last ? 0x04 : 0, packets: batch }));
        batch = [];
      }
    }
    return { ogg: Buffer.concat(pages), seconds: pcm.length / 2 / sampleRate };
  } finally {
    encoder.delete();
  }
}

// ── Decoding ────────────────────────────────────────────────────────────────

/** Length of an Ogg/Opus voice note, from its last granule position */
export function voiceNoteSeconds(ogg: Buffer): number {
  const packets = readOgg(ogg);
  const head = packets[0]?.data;
  if (!head || head.toString("ascii", 0, 8) !== "OpusHead") throw new Error("Not an Opus voice note");
  const preSkip = head.readUInt16LE(10);
  const last = packets.at(-1)!.granule;
  return Math.max(0, Number(last) - preSkip) / GRANULE_RATE;
}

/** An Ogg/Opus voice note → mono 16-bit PCM at `sampleRate` (for speech recognition) */
export function decodeVoiceNote(ogg: Buffer, sampleRate: Rate = 16_000): { pcm: Buffer; seconds: number } {
  const packets = readOgg(ogg);
  const head = packets[0]?.data;
  if (!head || head.toString("ascii", 0, 8) !== "OpusHead") throw new Error("Not an Opus voice note");
  const channels = head.readUInt8(9);
  const preSkip = Math.round((head.readUInt16LE(10) * sampleRate) / GRANULE_RATE);
  const decoder = new OpusScript(sampleRate, channels === 2 ? 2 : 1, OpusScript.Application.VOIP);
  try {
    const parts: Buffer[] = [];
    for (const p of packets.slice(2)) {
      if (!p.data.length) continue;
      const out = Buffer.from(decoder.decode(p.data));
      parts.push(channels === 2 ? downmix(out) : out);
    }
    const all = Buffer.concat(parts).subarray(preSkip * 2);
    return { pcm: all, seconds: all.length / 2 / sampleRate };
  } finally {
    decoder.delete();
  }
}

function downmix(stereo: Buffer): Buffer {
  const mono = Buffer.alloc(stereo.length / 2);
  for (let i = 0; i < mono.length / 2; i++)
    mono.writeInt16LE(Math.round((stereo.readInt16LE(i * 4) + stereo.readInt16LE(i * 4 + 2)) / 2), i * 2);
  return mono;
}

/** Mono 16-bit PCM in a WAV file */
export function wav(pcm: Buffer, sampleRate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
