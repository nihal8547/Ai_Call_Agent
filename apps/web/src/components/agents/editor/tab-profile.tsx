"use client";

import { AGENT_LANGUAGES, voiceForLanguage, voicesFor } from "@platform/shared";
import { SelectField, TextField } from "@/components/ui/field";
import { Check, Section, TextArea } from "@/components/ui/inputs";
import { useDraft } from "./draft-context";

export function ProfileTab() {
  const { config, update, errorFor } = useDraft();
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
