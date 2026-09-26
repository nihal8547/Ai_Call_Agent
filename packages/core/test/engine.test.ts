import { AgentConfig } from "@platform/shared";
import { describe, expect, it } from "vitest";
import { handleTurn, startCall } from "../src";
import { clinic, converse, ctx, hotel, realEstate, restaurant } from "./support";

describe("fallback-only conversations (no LLM) complete every template", () => {
  it("real estate (Ava): qualifies the buyer and books a site visit", () => {
    const c = converse(realEstate(), [
      "My name is Rahul",
      "an apartment",
      "around 80 lakh",
      "within 3 months",
      "Baner or Wakad",
      "home loan",
      "next saturday",
      "5 pm",
      "yes please",
    ]);
    expect(c.outputs[0]!.speech).toBe(
      "Hi, this is Ava from ABC Real Estate. Thanks for calling about our properties! May I know your name, please?",
    );
    expect(c.last.session.collected).toEqual({
      customer_name: "Rahul",
      property_type: "Apartment",
      budget: 8_000_000,
      timeline: "Within 3 months",
      preferred_area: "Baner or Wakad",
      financing: "Bank loan",
      visit_date: "2026-10-03",
      visit_time: "17:00",
    });
    expect(c.transcript).toContain(
      "AGENT: Got it, 80 lakh rupees. When are you planning to buy: immediately, within 3 months, in 3 to 6 months, or just exploring?",
    );
    expect(c.transcript).toContain("AGENT: Shall I book your site visit on Saturday, 3 October at 5 PM?");
    expect(c.toolCalls.map((t) => t.tool)).toEqual(["appointments.create", "leads.create"]);
    expect(c.toolCalls[0]!.input).toMatchObject({
      title: "Site visit: Rahul",
      date: "2026-10-03",
      time: "17:00",
    });
    expect(c.last.control).toBe("hangup");
    expect(c.last.session).toMatchObject({ outcome: "APPOINTMENT_BOOKED", qualification: "QUALIFIED" });
  });

  it("real estate: an explorer skips the visit and is saved as a lead", () => {
    const c = converse(realEstate(), ["Anita", "villa", "2 crore", "just exploring", "Kharadi", "own funds"]);
    expect(c.last.speech).toContain("I'll have our team share project details in Kharadi with you.");
    expect(c.toolCalls.map((t) => t.tool)).toEqual(["leads.create"]);
    expect(c.last.session.outcome).toBe("LEAD_CAPTURED");
    expect(c.last.session.collected.visit_date).toBeUndefined();
  });

  it("clinic: books an appointment", () => {
    const c = converse(clinic(), [
      "this is Priya",
      "root canal",
      "within a week",
      "tomorrow",
      "10 am",
      "yes",
    ]);
    expect(c.transcript).toContain(
      "AGENT: I can book Root canal for Priya on Tuesday, 29 September at 10 AM. Shall I confirm?",
    );
    expect(c.last.session.outcome).toBe("APPOINTMENT_BOOKED");
  });

  it("clinic: an emergency is transferred to the front desk", () => {
    const c = converse(clinic(), ["Priya", "root canal", "it's an emergency"]);
    expect(c.last.control).toBe("transfer");
    expect(c.last.transferTo).toBe("+911140000099");
    expect(c.last.session.outcome).toBe("HUMAN_HANDOFF");
  });

  it("hotel: takes a reservation request with numbers and an optional yes/no", () => {
    const c = converse(hotel(), [
      "Kumar",
      "12th october",
      "3 nights",
      "two guests",
      "deluxe",
      "no thanks",
      "yes",
    ]);
    expect(c.last.session.collected).toMatchObject({
      check_in: "2026-10-12",
      nights: 3,
      guests: 2,
      room_type: "Deluxe",
      breakfast: false,
    });
    expect(c.last.session.outcome).toBe("LEAD_CAPTURED");
  });

  it("restaurant: books a table", () => {
    const c = converse(restaurant(), ["Sam", "4 people", "friday", "8 pm", "birthday", "yes"]);
    expect(c.last.session.collected).toMatchObject({
      party_size: 4,
      reservation_date: "2026-10-02",
      reservation_time: "20:00",
      occasion: "Birthday",
    });
    expect(c.last.speech).toContain("You're all set!");
    expect(c.last.session.outcome).toBe("APPOINTMENT_BOOKED");
  });
});

describe("LLM understanding path", () => {
  it("accepts several fields at once, out of order", () => {
    const c = converse(realEstate(), [
      {
        transcript: "I'm Rahul, looking for a flat around 80 lakh in Baner",
        understanding: {
          intent: "answer",
          fields: {
            customer_name: "Rahul",
            property_type: "Apartment",
            budget: 8000000,
            preferred_area: "Baner",
          },
        },
      },
    ]);
    expect(c.last.session.collected).toMatchObject({
      customer_name: "Rahul",
      property_type: "Apartment",
      budget: 8_000_000,
      preferred_area: "Baner",
    });
    // Next question is the first still-missing field
    expect(c.last.prompt).toMatchObject({ kind: "field", fieldKey: "timeline" });
  });

  it("rejects invalid or invented values and re-asks", () => {
    const c = converse(realEstate(), [
      "Rahul",
      "apartment",
      {
        transcript: "five rupees",
        understanding: { intent: "answer", fields: { budget: 5, favourite_colour: "blue" } },
      },
    ]);
    const ev = c.last.events;
    expect(ev).toContainEqual({
      type: "validation_error",
      field: "budget",
      raw: 5,
      error: "must be at least 500000",
    });
    expect(c.last.session.collected).not.toHaveProperty("favourite_colour");
    expect(c.last.speech).toContain("Roughly how much are you planning to spend?");
  });

  it("applies corrections and says so", () => {
    const c = converse(realEstate(), [
      "Rahul",
      "apartment",
      "80 lakh",
      {
        transcript: "actually make that 1 crore",
        understanding: { intent: "answer", fields: { budget: "1 crore" } },
      },
    ]);
    expect(c.last.session.collected.budget).toBe(10_000_000);
    expect(c.last.speech).toContain("Okay, I've updated the budget to 1 crore rupees.");
  });

  it("opens the circuit breaker after repeated LLM failures", () => {
    const c = converse(realEstate(), [
      { transcript: "Rahul", llmError: true },
      { transcript: "apartment", llmError: true },
    ]);
    expect(c.last.session.fallbackOnly).toBe(true);
    expect(c.last.events).toContainEqual({ type: "fallback", reason: "circuit_open" });
    // …and the call carries on with deterministic understanding
    expect(c.last.session.collected).toMatchObject({ customer_name: "Rahul", property_type: "Apartment" });
  });
});

describe("questions and knowledge", () => {
  it("answers from knowledge when a grounded answer is supplied, then continues", () => {
    const c = converse(clinic(), [
      {
        transcript: "do you do dental implants?",
        answer: "Yes, we offer dental implants with a free consultation.",
      },
    ]);
    expect(c.last.speech).toBe(
      "Yes, we offer dental implants with a free consultation. May I have the patient's name?",
    );
    expect(c.last.session.pendingQuestions).toEqual([]);
  });

  it("never invents an answer: safe response + follow-up, without using up an attempt", () => {
    const c = converse(clinic(), ["what are your consultation charges?"]);
    expect(c.last.speech).toBe(
      "That's a good question. I don't have that detail right now, so I'll have our team confirm it for you. May I have the patient's name?",
    );
    expect(c.last.session.pendingQuestions).toEqual(["what are your consultation charges?"]);
    expect(c.last.session.attempts.patient_name).toBe(1);
  });
});

describe("resilience", () => {
  it("handles silence, then ends politely after repeated silence", () => {
    const c = converse(clinic(), ["", ""]);
    expect(c.outputs[1]!.speech).toBe("Sorry, I didn't catch that. May I have the patient's name?");
    const last = converse(clinic(), ["", "", ""]).last;
    expect(last.speech).toContain("I'm having trouble hearing you");
    expect(last.control).toBe("hangup");
    expect(last.session.outcome).toBe("ABANDONED");
  });

  it("re-asks with the configured rephrasing, then skips a field it cannot capture", () => {
    const c = converse(realEstate(), ["Rahul", "apartment", "no idea", "hmm", "not sure"]);
    const texts = c.transcript.filter((l) => l.startsWith("AGENT"));
    expect(texts[3]).toContain("Roughly how much are you planning to spend?");
    expect(c.last.session.skipped).toContain("budget");
    expect(c.last.prompt?.fieldKey).toBe("timeline");
  });

  it("a declined confirmation clears the details and asks again", () => {
    const c = converse(clinic(), [
      "Priya",
      "cleaning",
      "flexible",
      "tomorrow",
      "10 am",
      "no",
      "thursday",
      "4 pm",
      "yes",
    ]);
    expect(c.transcript).toContain(
      "AGENT: No problem, let's change that. Which day would you like to come in?",
    );
    expect(c.last.session.collected).toMatchObject({ preferred_date: "2026-10-01", preferred_time: "16:00" });
    expect(c.last.session.outcome).toBe("APPOINTMENT_BOOKED");
  });

  it("'no, make it 6 pm' changes the detail and re-confirms", () => {
    const c = converse(clinic(), ["Priya", "cleaning", "flexible", "tomorrow", "10 am", "no, make it 6 pm"]);
    expect(c.last.session.collected.preferred_time).toBe("18:00");
    expect(c.last.speech).toContain("on Tuesday, 29 September at 6 PM. Shall I confirm?");
  });

  it("a failing booking tool never breaks the call", () => {
    const c = converse(clinic(), ["Priya", "cleaning", "flexible", "tomorrow", "10 am", "yes"], {
      toolResult: () => ({ ok: false, error: "calendar timeout" }),
    });
    expect(c.transcript.join(" ")).toContain("I couldn't complete that just now");
    expect(c.transcript.join(" ")).not.toMatch(/timeout/);
    expect(c.last.control).toBe("hangup");
    expect(c.last.session.outcome).not.toBe("APPOINTMENT_BOOKED");
  });

  it("caller asks for a person: transfer when available, take a message when not", () => {
    const transfer = converse(clinic(), ["can I speak to a real person"]);
    expect(transfer.last.control).toBe("transfer");
    // Real estate has no handoff configured
    const message = converse(realEstate(), ["connect me to a human"]);
    expect(message.last.control).toBe("hangup");
    expect(message.last.speech).toContain("someone will call you back");
    expect(message.last.session.outcome).toBe("FOLLOW_UP_REQUIRED");
  });

  it("outside working hours the clinic takes a message and never transfers", () => {
    const night = { ...ctx, now: new Date("2026-09-28T18:30:00Z") }; // 00:00 IST
    const c = converse(clinic(), ["Priya", "root canal", "emergency"], { context: night });
    expect(c.outputs[0]!.speech).toContain("Our office is closed right now");
    expect(c.last.control).toBe("hangup");
    expect(c.last.session.outcome).toBe("FOLLOW_UP_REQUIRED");
  });

  it("'not interested' ends the call politely", () => {
    const c = converse(realEstate(), ["sorry, not interested"]);
    expect(c.last.control).toBe("hangup");
    expect(c.last.session.outcome).toBe("ABANDONED");
  });

  it("enforces the turn limit", () => {
    const cfg = AgentConfig.parse({ ...realEstate(), limits: { maxTurns: 4 } });
    const c = converse(cfg, ["a", "b", "c", "d", "e"]);
    expect(c.last.session.endReason).toBe("max_turns");
  });

  it("never mutates the session it was given", () => {
    const start = startCall(clinic(), ctx, "c1");
    const frozen = structuredClone(start.session);
    handleTurn(start.session, clinic(), { transcript: "Priya" }, ctx);
    expect(start.session).toEqual(frozen);
  });

  it("tool calls carry stable idempotency keys and the collected data", () => {
    const c = converse(clinic(), ["Priya", "cleaning", "flexible", "tomorrow", "10 am", "yes"]);
    const booking = c.toolCalls.find((t) => t.tool === "appointments.create")!;
    expect(booking.idempotencyKey).toBe("call-1:book:6");
    expect(booking.input.collected).toMatchObject({ patient_name: "Priya" });
  });
});
