"use client";

import { AGENT_LANGUAGES, systemLines, voiceForLanguage, voicesFor } from "@platform/shared";
import { SelectField, TextField } from "@/components/ui/field";
import { Check, Section, TextArea } from "@/components/ui/inputs";
import { useDraft } from "./draft-context";

export function ProfileTab() {
  const { config, update, errorFor } = useDraft();
  // Agents saved before this setting existed don't have it
  const disclosure = config.disclosure ?? { ai: false, message: "" };
  return (
    <div className="space-y-6">
      <Section title="Identity" description="How the agent introduces itself on every call.">
        <div className="grid gap-4 md:grid-cols-2">
          <TextField
            label="Business name (spoken)"
            value={config.businessName}
            error={errorFor("businessName")}
            onChange={(e) => update((c) => void (c.businessName = e.target.value))}
          />
          <TextField
            label="Agent introduces itself as"
            value={config.agentName}
            error={errorFor("agentName")}
            onChange={(e) => update((c) => void (c.agentName = e.target.value))}
          />
          <TextField
            className="md:col-span-2"
            label="Greeting"
            value={config.greeting}
            error={errorFor("greeting")}
            hint="Placeholders: {{agent_name}}, {{business_name}}, and any question key such as {{customer_name}}."
            onChange={(e) => update((c) => void (c.greeting = e.target.value))}
          />
          <div className="space-y-3 md:col-span-2">
            <Check
              label="Say it's an AI assistant, right after the greeting"
              hint="Callers and WhatsApp customers should know they're talking to an AI (Qatar PDPPL, India DPDP)."
              checked={disclosure.ai}
              onChange={(ai) => update((c) => void (c.disclosure = { ...disclosure, ai }))}
            />
            {disclosure.ai ? (
              <TextField
                label="In your own words (optional)"
                value={disclosure.message}
                placeholder={systemLines(config.language).aiDisclosure}
                error={errorFor("disclosure.message")}
                hint="Empty: the sentence shown here, in the agent's language."
                onChange={(e) =>
                  update((c) => void (c.disclosure = { ...disclosure, message: e.target.value }))
                }
              />
            ) : null}
          </div>
          <SelectField
            label="Language"
            value={config.language}
            error={errorFor("language")}
            hint="What callers are understood in, and what the agent speaks. Arabic agents also understand English."
            onChange={(e) =>
              update((c) => {
                c.language = e.target.value;
                // Keep the voice if it speaks the new language, otherwise pick one that does
                c.voice.voice = voiceForLanguage(c.language, c.voice.voice);
              })
            }
          >
            {AGENT_LANGUAGES.some((l) => l.code === config.language) ? null : (
              <option value={config.language}>{config.language}</option>
            )}
            {AGENT_LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.name}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Voice"
            value={config.voice.voice}
            error={errorFor("voice.voice")}
            hint="Amazon Polly voices through Twilio"
            onChange={(e) => update((c) => void (c.voice.voice = e.target.value))}
          >
            {voicesFor(config.language).some((v) => v.id === config.voice.voice) ? null : (
              <option value={config.voice.voice}>{config.voice.voice}</option>
            )}
            {voicesFor(config.language).map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </SelectField>
        </div>
      </Section>

      <Section
        title="Conversation"
        description="How calls flow. Streaming feels like talking to a person: replies start sooner and callers can interrupt."
      >
        <div className="grid gap-4 md:grid-cols-2">
          <SelectField
            label="Conversation mode"
            value={config.voice.mode ?? "classic"}
            error={errorFor("voice.mode")}
            hint={
              (config.voice.mode ?? "classic") === "streaming"
                ? "Twilio ConversationRelay: speech is recognised as it's spoken and the reply is streamed. Billed per minute. If the stream breaks, the call carries on turn by turn."
                : "Turn by turn: the caller finishes, then the agent answers. Works everywhere."
            }
            onChange={(e) => update((c) => void (c.voice.mode = e.target.value as "classic" | "streaming"))}
          >
            <option value="classic">Classic (turn by turn)</option>
            <option value="streaming">Streaming (natural, interruptible)</option>
          </SelectField>
          {(config.voice.mode ?? "classic") === "streaming" ? (
            <SelectField
              label="Speech recognition"
              value={config.voice.transcriber ?? "auto"}
              error={errorFor("voice.transcriber")}
              hint="Automatic uses Google for Arabic and Deepgram for English and Hindi."
              onChange={(e) =>
                update((c) => void (c.voice.transcriber = e.target.value as "auto" | "deepgram" | "google"))
              }
            >
              <option value="auto">Automatic</option>
              <option value="deepgram">Deepgram</option>
              <option value="google">Google</option>
            </SelectField>
          ) : null}
        </div>
      </Section>

      <Section
        title="Behaviour"
        description="Guidance for the AI when it phrases replies and understands callers."
      >
        <div className="grid gap-4">
          <TextArea
            label="Personality"
            rows={2}
            value={config.persona}
            error={errorFor("persona")}
            onChange={(e) => update((c) => void (c.persona = e.target.value))}
          />
          <TextArea
            label="Instructions"
            rows={3}
            value={config.instructions}
            error={errorFor("instructions")}
            onChange={(e) => update((c) => void (c.instructions = e.target.value))}
          />
          <TextArea
            label="Business rules (one per line)"
            rows={4}
            value={config.businessRules.join("\n")}
            error={errorFor("businessRules")}
            onChange={(e) =>
              update(
                (c) =>
                  void (c.businessRules = e.target.value
                    .split("\n")
                    .map((l) => l.trim())
                    .filter(Boolean)),
              )
            }
          />
          <Check
            label="Answer caller questions from the knowledge base"
            hint="When nothing relevant is found, the agent says so and the team follows up. It never invents business facts."
            checked={config.workflow.answerQuestions}
            onChange={(v) => update((c) => void (c.workflow.answerQuestions = v))}
          />
        </div>
      </Section>

      <Section
        title="AI model"
        description="Without an API key the agent still works, using rule-based understanding and fixed wording."
      >
        <div className="grid gap-4 md:grid-cols-4">
          <TextField
            label="Model"
            value={config.llm.model}
            error={errorFor("llm.model")}
            onChange={(e) => update((c) => void (c.llm.model = e.target.value))}
          />
          <TextField
            label="Temperature"
            type="number"
            step="0.1"
            min={0}
            max={1}
            value={config.llm.temperature}
            error={errorFor("llm.temperature")}
            onChange={(e) => update((c) => void (c.llm.temperature = Number(e.target.value)))}
          />
          <TextField
            label="Timeout (ms)"
            type="number"
            value={config.llm.timeoutMs}
            error={errorFor("llm.timeoutMs")}
            onChange={(e) => update((c) => void (c.llm.timeoutMs = Number(e.target.value)))}
          />
          <div className="md:mt-7">
            <Check
              label="Natural rephrasing"
              checked={config.llm.rephrase}
              onChange={(v) => update((c) => void (c.llm.rephrase = v))}
            />
          </div>
        </div>
      </Section>
    </div>
  );
}
