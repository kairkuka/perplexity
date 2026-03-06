export type Step =
  | { type: "OPEN_URL"; url: string; timeoutMs?: number }
  | { type: "GOOGLE_SEARCH"; query: string; timeoutMs?: number }
  | { type: "CLICK_FIRST_RESULT"; timeoutMs?: number }
  | { type: "WAIT_FOR_TEXT"; text: string; timeoutMs?: number }
  | {
      type: "CLICK";
      elementId?: number;
      selector?: string;
      text?: string;
      href?: string;
      mode?: "strict" | "fuzzy";
      timeoutMs?: number;
    }
  | {
      type: "TYPE";
      text: string;
      selector?: string;
      label?: string;
      placeholder?: string;
      clearFirst?: boolean;
      timeoutMs?: number;
    }
  | {
      type: "WAIT_FOR_SELECTOR";
      selector: string;
      state?: "visible" | "attached";
      timeoutMs?: number;
    }
  | {
      type: "EXTRACT";
      kind: "url" | "title" | "text";
      selector?: string;
      timeoutMs?: number;
    }
  | {
      type: "PRESS";
      key: string;
      timeoutMs?: number;
    }
  | {
      type: "SCROLL";
      deltaY: number;
    }
  | {
      type: "WAIT_NAVIGATION";
      timeoutMs?: number;
    }
  | {
      type: "SET_EVENT_DATE";
      date: string;
      timeoutMs?: number;
    }
  | {
      type: "SET_EVENT_START";
      time: string;
      timeoutMs?: number;
    }
  | {
      type: "SET_EVENT_END";
      time: string;
      timeoutMs?: number;
    }
  | {
      type: "SAVE_EVENT";
      timeoutMs?: number;
    }
  | {
      type: "SNAPSHOT";
    };

export type StepType = Step["type"];

export interface Plan {
  rawCommand: string;
  steps: Step[];
}
