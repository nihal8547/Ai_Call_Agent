import { describe, expect, it } from "vitest";
import { decodeVoiceNote, encodeVoiceNote, voiceNoteSeconds, wav } from "../src";

/** A second of a 440 Hz tone with a slow amplitude wobble, like a voice: mono 16-bit PCM */
function tone(sampleRate: number, seconds: number): Buffer {
  const n = Math.round(sampleRate * seconds);
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    pcm.writeInt16LE(
      Math.round(12_000 * Math.sin(2 * Math.PI * 440 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t))),
      i * 2,
    );
  }
  return pcm;
}

const rms = (pcm: Buffer) => {
  let sum = 0;
  for (let i = 0; i < pcm.length; i += 2) sum += pcm.readInt16LE(i) ** 2;
  return Math.sqrt(sum / (pcm.length / 2));
};

describe("voice notes (Ogg/Opus)", () => {
  it("encodes 24 kHz speech audio into a valid Ogg/Opus stream", () => {
    const { ogg, seconds } = encodeVoiceNote(tone(24_000, 2.5), 24_000);
    expect(seconds).toBeCloseTo(2.5, 2);
    expect(ogg.subarray(0, 4).toString("ascii")).toBe("OggS");
    expect(ogg.includes(Buffer.from("OpusHead"))).toBe(true);
    expect(ogg.includes(Buffer.from("OpusTags"))).toBe(true);
    // Small enough for WhatsApp: about 24 kbit/s
    expect(ogg.length).toBeLessThan(2.5 * 4000);
    expect(voiceNoteSeconds(ogg)).toBeCloseTo(2.5, 1);
  });

  it("decodes back to audio of the same length and loudness", () => {
    const source = tone(24_000, 2);
    const { ogg } = encodeVoiceNote(source, 24_000);
    const { pcm, seconds } = decodeVoiceNote(ogg, 16_000);
    expect(seconds).toBeGreaterThan(1.95);
    expect(seconds).toBeLessThan(2.05);
    const ratio = rms(pcm) / rms(source);
    expect(ratio).toBeGreaterThan(0.7);
    expect(ratio).toBeLessThan(1.3);
  });

  it("rejects files that aren't intact Ogg/Opus", () => {
    const { ogg } = encodeVoiceNote(tone(16_000, 0.5), 16_000);
    const damaged = Buffer.from(ogg);
    damaged[60] = (damaged[60]! + 1) % 256;
    expect(() => decodeVoiceNote(damaged)).toThrow(/Damaged Ogg page/);
    expect(() => decodeVoiceNote(Buffer.from("ID3 not an ogg file"))).toThrow(/Not an Ogg file/);
  });

  it("wraps PCM in a WAV header", () => {
    const w = wav(Buffer.alloc(3200), 16_000);
    expect(w.subarray(0, 4).toString()).toBe("RIFF");
    expect(w.readUInt32LE(24)).toBe(16_000);
    expect(w.length).toBe(3244);
  });
});
