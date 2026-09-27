# 1. Overview

## What it is

A platform where any business (real estate, clinics, hotels, restaurants, car service …) builds
its own **AI phone agent** without code. The agent answers real phone calls, talks naturally,
asks the business's qualification questions, answers questions from the business's documents,
books appointments, transfers to a person when needed, and saves every caller as a lead.

It is **multi-tenant**: one deployment serves many businesses, each completely isolated from the
others, each with its own users, agents, numbers, data and settings.

## Who uses it

| Person                                   | What they do                                                                  |
| ---------------------------------------- | ----------------------------------------------------------------------------- |
| **Caller**                               | Phones the business and talks to the agent (English, Hindi-English, Arabic …) |
| **Business owner / admin**               | Sets up agents, numbers, integrations, members, billing access                |
| **Staff (manager, agent, viewer roles)** | Reads calls and leads, follows up, manages appointments                       |
| **Platform operator**                    | Runs the platform (Twilio account, queues dashboard, monitoring)              |

## Features

### Agents

- **Templates** to start from: real estate, clinic reception, hotel reservations, restaurant
  booking, and Qatar real estate and clinic in **Arabic**.
- **Agent editor**: identity, greeting, personality, language and voice, qualification questions
  (text, name, phone, email, number, amount, date, time, choice, yes/no), a visual **workflow**
  (greeting → collect → branch → confirm and act → tool → handoff → end), business rules,
  working hours and holidays, escalation rules, fallback sentences, AI settings.
- **Drafts and versions**: edit a draft, publish it; calls in progress keep the version they
  started on; restore any older version.
- **Test console**: talk to the agent by typing, before publishing.

### Calls

- Real phone calls through **Twilio** (voice webhooks, speech recognition, text-to-speech).
- Live call list, and for every call: transcript, what was captured, tools run, knowledge used,
  timings per turn, cost estimate, outcome (appointment booked, lead captured, follow-up …).
- **Transfer to a person** (with a whisper to staff), or take a message when nobody is available.

### Phone numbers

- **Buy a Twilio number** in the app.
- **Keep your existing number** (Ooredoo, Vodafone or any carrier): forward it to the agent; the
  app shows the forwarding codes and runs a **test call**.
- **SIP connection** from a business SIP line or office PBX, with a setup sheet for the carrier.
- Blocked callers, per-number call limits.

### Knowledge base (RAG)

- Upload PDF, Word (.docx), Excel (.xlsx), CSV, text and Markdown, and images (PNG, JPEG, WebP,
  read with OCR). Files are recognised by their content, split into passages, embedded (pgvector)
  and searched during calls.
- The agent answers **only from the documents**; if it can't, it says so and records a
  **knowledge gap** for the team (with "Add to FAQ").

### Leads and appointments

- Every call becomes a lead with its details; a lead board with custom statuses.
- Appointments with a calendar view, availability rules, Google Calendar sync.

### Integrations and tools

- Webhooks, email (Gmail, Outlook / Microsoft 365 or any SMTP server), Google Calendar, Google
  Sheets, HubSpot, Zoho CRM.
- **One-click connect**: "Continue with Google / Microsoft / HubSpot / Zoho" opens the provider's
  sign-in page; after allowing access the business comes back already connected. Manual keys,
  tokens and SMTP remain as "other ways to connect".
- Tools run during calls (check availability, book, cancel, save lead, notify staff …) or in the
  background through queues, with retries and a **failed deliveries** list.

### Analytics

- Calls, outcomes, qualification funnel, busiest hours, reply latency, tool failures, knowledge
  answers, estimated cost; CSV export.

### Business and security settings

- Country (calling code, currency, time zone), longest call, how long records are kept.
- Members and roles with fine-grained permissions, emailed invitations (with resend), API keys,
  audit log.
- "Forgot password" by email.
- Two-step sign-in (authenticator app), sessions list with sign-out everywhere.

### Languages

- English (India, UK, US), Hindi, and **Arabic** (Qatar, UAE, Saudi Arabia, Kuwait): Arabic agents
  understand Gulf Arabic, standard Arabic and English.

## The three apps

| App        | For                                                         | Address (development)          |
| ---------- | ----------------------------------------------------------- | ------------------------------ |
| **web**    | The dashboard people use                                    | http://localhost:3000          |
| **api**    | Everything else talks to it: the web app, Twilio, API keys  | http://localhost:4000          |
| **worker** | Background work: documents, analytics, retention, schedules | (no web port; metrics on 9464) |
