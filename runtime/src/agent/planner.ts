import type { DomSnapshot } from "./domSnapshot.js";
import { scoreCreateButton } from "./elementScoring.js";
import type { Step } from "./steps.js";

export interface Plan {
  steps: Step[];
}

export interface PlanOptions {
  previousError?: string;
}

interface ChatCompletionChoice {
  message?: {
    content?: string | Array<{ type?: string; text?: string }>;
  };
}

interface ChatCompletionResponse {
  choices?: ChatCompletionChoice[];
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

function asNonNegativeInt(value: unknown): number | undefined {
  const parsed = asNumber(value);
  if (parsed === undefined || !Number.isInteger(parsed) || parsed < 0) {
    return undefined;
  }

  return parsed;
}

function pickTimeoutMs(value: unknown): number | undefined {
  const timeout = asNumber(value);
  if (timeout === undefined || timeout <= 0) {
    return undefined;
  }
  return timeout;
}

function extractJsonArrayContent(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const trimmed = text.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed;
  }

  const firstBracket = text.indexOf("[");
  const lastBracket = text.lastIndexOf("]");
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    return text.slice(firstBracket, lastBracket + 1).trim();
  }

  return null;
}

function parseResponseText(raw: unknown): string {
  const data = asObject(raw) as ChatCompletionResponse | null;
  const first = data?.choices?.[0]?.message?.content;
  if (typeof first === "string") {
    return first;
  }

  if (Array.isArray(first)) {
    return first
      .map((part) => part.text)
      .filter((text): text is string => typeof text === "string")
      .join("\n");
  }

  return "[]";
}

function toStep(raw: unknown): Step | null {
  const obj = asObject(raw);
  if (!obj) {
    return null;
  }

  const type = asString(obj.type)?.toUpperCase();
  if (!type) {
    return null;
  }

  switch (type) {
    case "OPEN_URL": {
      const url = asString(obj.url);
      if (!url) {
        return null;
      }
      return { type: "OPEN_URL", url, timeoutMs: pickTimeoutMs(obj.timeoutMs) };
    }
    case "GOOGLE_SEARCH": {
      const query = asString(obj.query);
      if (!query) {
        return null;
      }
      return { type: "GOOGLE_SEARCH", query, timeoutMs: pickTimeoutMs(obj.timeoutMs) };
    }
    case "CLICK_FIRST_RESULT":
      return { type: "CLICK_FIRST_RESULT", timeoutMs: pickTimeoutMs(obj.timeoutMs) };
    case "WAIT_FOR_TEXT": {
      const text = asString(obj.text);
      if (!text) {
        return null;
      }
      return { type: "WAIT_FOR_TEXT", text, timeoutMs: pickTimeoutMs(obj.timeoutMs) };
    }
    case "CLICK": {
      const elementId = asNonNegativeInt(obj.elementId);
      const selector = asString(obj.selector);
      const text = asString(obj.text);
      if (elementId === undefined && !selector && !text) {
        return null;
      }

      const modeRaw = asString(obj.mode)?.toLowerCase();
      const mode = modeRaw === "fuzzy" ? "fuzzy" : modeRaw === "strict" ? "strict" : undefined;
      const href = asString(obj.href);

      return {
        type: "CLICK",
        elementId,
        selector,
        text,
        href,
        mode,
        timeoutMs: pickTimeoutMs(obj.timeoutMs),
      };
    }
    case "TYPE": {
      const text = asString(obj.text);
      if (!text) {
        return null;
      }
      const selector = asString(obj.selector);
      const label = asString(obj.label);
      const placeholder = asString(obj.placeholder);
      if (!selector && !label && !placeholder) {
        return null;
      }

      return {
        type: "TYPE",
        text,
        selector,
        label,
        placeholder,
        clearFirst: obj.clearFirst === true,
        timeoutMs: pickTimeoutMs(obj.timeoutMs),
      };
    }
    case "WAIT_FOR_SELECTOR": {
      const selector = asString(obj.selector);
      if (!selector) {
        return null;
      }
      const stateRaw = asString(obj.state)?.toLowerCase();
      const state = stateRaw === "attached" ? "attached" : stateRaw === "visible" ? "visible" : undefined;
      return {
        type: "WAIT_FOR_SELECTOR",
        selector,
        state,
        timeoutMs: pickTimeoutMs(obj.timeoutMs),
      };
    }
    case "EXTRACT": {
      const kindRaw = asString(obj.kind)?.toLowerCase();
      if (kindRaw !== "url" && kindRaw !== "title" && kindRaw !== "text") {
        return null;
      }
      const selector = asString(obj.selector);
      return {
        type: "EXTRACT",
        kind: kindRaw,
        selector,
        timeoutMs: pickTimeoutMs(obj.timeoutMs),
      };
    }
    case "PRESS": {
      const key = asString(obj.key);
      if (!key) {
        return null;
      }
      return { type: "PRESS", key, timeoutMs: pickTimeoutMs(obj.timeoutMs) };
    }
    case "SCROLL": {
      const deltaY = asNumber(obj.deltaY);
      if (deltaY === undefined) {
        return null;
      }
      return { type: "SCROLL", deltaY };
    }
    case "WAIT_NAVIGATION":
      return { type: "WAIT_NAVIGATION", timeoutMs: pickTimeoutMs(obj.timeoutMs) };
    case "SET_EVENT_DATE": {
      const date = asString(obj.date);
      if (!date) {
        return null;
      }
      return { type: "SET_EVENT_DATE", date, timeoutMs: pickTimeoutMs(obj.timeoutMs) };
    }
    case "SET_EVENT_START": {
      const time = asString(obj.time);
      if (!time) {
        return null;
      }
      return { type: "SET_EVENT_START", time, timeoutMs: pickTimeoutMs(obj.timeoutMs) };
    }
    case "SET_EVENT_END": {
      const time = asString(obj.time);
      if (!time) {
        return null;
      }
      return { type: "SET_EVENT_END", time, timeoutMs: pickTimeoutMs(obj.timeoutMs) };
    }
    case "SAVE_EVENT":
      return { type: "SAVE_EVENT", timeoutMs: pickTimeoutMs(obj.timeoutMs) };
    case "SNAPSHOT":
      return { type: "SNAPSHOT" };
    default:
      return null;
  }
}

function parseStepsFromText(text: string): Step[] {
  const content = extractJsonArrayContent(text);
  if (!content) {
    return [];
  }

  try {
    const parsed = JSON.parse(content) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((item) => toStep(item))
      .filter((item): item is Step => item !== null);
  } catch {
    return [];
  }
}

export async function planWithLLM(
  command: string,
  snapshot: DomSnapshot,
  options?: PlanOptions,
): Promise<Plan> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  const elementsText = snapshot.elements
    .map((element) => {
      const text = element.text ?? "";
      const aria = element.aria ?? "";
      const href = element.href ?? "";
      return `${element.id}: <${element.tag}> ${text} ${aria} ${href}`.trim();
    })
    .join("\n");

  const createCandidates = scoreCreateButton(snapshot.elements).slice(0, 5);
  const createCandidatesText = createCandidates.length > 0
    ? createCandidates
      .map((candidate) => (
        `${candidate.id}: score=${candidate.score} text="${candidate.text}" role=${candidate.role ?? "unknown"}`
      ))
      .join("\n")
    : "none";

  const previousErrorBlock = options?.previousError
    ? `\nPrevious execution failed with error:\n${options.previousError}\nGenerate a corrected plan.\n`
    : "";

  const prompt = `
You control a browser automation runtime.

Current page:
URL: ${snapshot.url}
TITLE: ${snapshot.title}

ELEMENTS:
${elementsText}

CREATE_CANDIDATES:
${createCandidatesText}

User request:
${command}
${previousErrorBlock}

Return ONLY a JSON array of steps.
Allowed step types:
OPEN_URL, GOOGLE_SEARCH, CLICK_FIRST_RESULT, CLICK, TYPE, PRESS, WAIT_NAVIGATION, WAIT_FOR_SELECTOR, WAIT_FOR_TEXT, EXTRACT, SCROLL, SNAPSHOT, SET_EVENT_DATE, SET_EVENT_START, SET_EVENT_END, SAVE_EVENT

When clicking by element id use:
{ "type":"CLICK", "elementId": 3 }

If user intent includes create/new/meeting/event, prefer clicking one of CREATE_CANDIDATES
using CLICK with elementId (before fallback to text selectors).

When creating a calendar event:
1. After clicking the create button,
2. The next step MUST be TYPE for the event title,
3. Then SET_EVENT_DATE,
4. Then SET_EVENT_START,
5. Then SET_EVENT_END,
6. Then SAVE_EVENT.
Never replace TYPE steps with PRESS unless TYPE has already been executed.
Do NOT place datetime into a single TYPE step.

Example:
User request: create event "чйотам" at 2026-03-05 11:00
Correct plan:
[
  { "type": "CLICK", "text": "Create", "mode": "fuzzy" },
  { "type": "CLICK", "text": "Event", "mode": "fuzzy" },
  { "type": "TYPE", "text": "чйотам", "selector": "input[aria-label*='title'], input[aria-label*='назв']" },
  { "type": "SET_EVENT_DATE", "date": "2026-03-05" },
  { "type": "SET_EVENT_START", "time": "11:00" },
  { "type": "SET_EVENT_END", "time": "12:00" },
  { "type": "SAVE_EVENT" }
]

To observe page again use:
{ "type":"SNAPSHOT" }

For EXTRACT use:
{ "type":"EXTRACT", "kind":"url|title|text", "selector":"..." }
`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, 10_000);

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0,
        messages: [
          {
            role: "system",
            content: "You are a browser automation planner. Return ONLY JSON.",
          },
          { role: "user", content: prompt },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    const data = await response.json() as unknown;
    const text = parseResponseText(data);
    return {
      steps: parseStepsFromText(text),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
