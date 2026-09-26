import { AppointmentConfig } from "@platform/shared";
import { describe, expect, it } from "vitest";
import {
  checkSlot,
  explainProblem,
  freeSlots,
  isPrivateAddress,
  nearestSlots,
  resolvePublic,
  type SlotQuery,
} from "../src";
import { clinicContext, NOW } from "./support";

const hours = clinicContext().config.workingHours;
const at = (iso: string) => new Date(iso);
const q = (patch: Partial<SlotQuery> = {}): SlotQuery => ({
  date: "2026-09-29", // Tuesday, clinic open 09:00–19:00 IST
  timezone: "Asia/Kolkata",
  hours,
  rules: AppointmentConfig.parse({ durationMinutes: 30, slotStepMinutes: 60, leadTimeMinutes: 60 }),
  busy: [],
  now: NOW,
  ...patch,
});

describe("slots", () => {
  it("lists start times inside opening hours on the grid, with the visit fitting before closing", () => {
    expect(freeSlots(q())).toEqual([
      "09:00",
      "10:00",
      "11:00",
      "12:00",
      "13:00",
      "14:00",
      "15:00",
      "16:00",
      "17:00",
      "18:00",
    ]);
    expect(freeSlots(q({ date: "2026-10-04" }))).toEqual([]); // Sunday: closed
  });

  it("respects busy time, buffers and capacity", () => {
    const busy = [{ start: at("2026-09-29T04:30:00Z"), end: at("2026-09-29T05:00:00Z") }]; // 10:00–10:30 IST
    expect(freeSlots(q({ busy }))).not.toContain("10:00");
    const buffered = q({
      busy,
      rules: AppointmentConfig.parse({ durationMinutes: 30, slotStepMinutes: 30, bufferMinutes: 15 }),
    });
    expect(freeSlots(buffered)).not.toContain("10:30");
    expect(freeSlots(buffered)).not.toContain("09:30");
    expect(freeSlots(buffered)).toContain("11:00");
    const twoChairs = q({
      busy,
      rules: AppointmentConfig.parse({ durationMinutes: 30, slotStepMinutes: 60, capacity: 2 }),
    });
    expect(freeSlots(twoChairs)).toContain("10:00");
    expect(checkSlot({ ...twoChairs, busy: [...busy, ...busy] }, "10:00").problem).toBe("taken");
  });

  it("explains why a time can't be booked", () => {
    expect(checkSlot(q({ date: "2026-09-28" }), "11:00").problem).toBe("in_the_past");
    expect(checkSlot(q({ date: "2026-09-28" }), "12:00").problem).toBe("too_soon"); // 30 min away, lead time 60
    expect(checkSlot(q(), "20:00").problem).toBe("closed");
    expect(checkSlot(q(), "18:45").problem).toBe("closed"); // would run past 19:00
    expect(checkSlot(q({ date: "2027-01-10" }), "10:00").problem).toBe("too_far");
    expect(checkSlot(q(), "10:00").problem).toBeNull();
    // Without configured hours any requested time is accepted
    expect(checkSlot(q({ hours: undefined }), "20:00").problem).toBeNull();
  });

  it("offers the closest free times and says them naturally", () => {
    expect(nearestSlots(["09:00", "11:00", "15:00", "16:00"], "14:00", 2)).toEqual(["15:00", "16:00"]);
    expect(explainProblem("taken", "2026-09-29", "10:00", ["11:00", "15:30"])).toBe(
      "10 AM on Tuesday, 29 September is already booked. On Tuesday, 29 September I have 11 AM or 3:30 PM free.",
    );
    expect(explainProblem("closed", "2026-10-04", "10:00", [])).toContain(
      "I don't have any free times that day.",
    );
  });
});

describe("network guard", () => {
  it.each([
    ["127.0.0.1", true],
    ["10.1.2.3", true],
    ["172.20.0.1", true],
    ["192.168.1.10", true],
    ["169.254.169.254", true], // cloud metadata
    ["100.64.0.1", true],
    ["0.0.0.0", true],
    ["::1", true],
    ["fd00::1", true],
    ["fe80::1", true],
    ["::ffff:10.0.0.1", true],
    ["8.8.8.8", false],
    ["172.32.0.1", false],
    ["2606:4700::1111", false],
  ])("%s private = %s", (ip, expected) => {
    expect(isPrivateAddress(ip)).toBe(expected);
  });

  it("refuses hosts that resolve to private addresses unless allowed", async () => {
    await expect(resolvePublic("localhost", false)).rejects.toMatchObject({ kind: "blocked" });
    await expect(resolvePublic("169.254.169.254", false)).rejects.toMatchObject({ kind: "blocked" });
    expect(await resolvePublic("127.0.0.1", true)).toBe("127.0.0.1");
  });
});
