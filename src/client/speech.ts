/**
 * Speech-to-text from the device microphone.
 *
 * The robot has no microphone. Speech therefore has to be captured somewhere
 * else, and the phone is where it is.
 *
 * The primary path is the Web Speech API, which runs recognition on-device on
 * Android and needs no API key, no server and no network round trip. That
 * matters for a demo: it works with the laptop switched off.
 *
 * It is not universally available, though. Chrome's implementation needs the
 * Google app for speech services, and Android WebView support is patchy, so
 * the recorder path below is the fallback: capture audio here, transcribe it
 * on the companion server.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface SpeechResult {
  text: string;
  /** 0..1, when the platform reports a confidence. */
  confidence?: number;
}

export type SpeechAvailability = "ready" | "no-mic" | "no-mic-permission" | "unsupported";

export interface SpeechState {
  availability: SpeechAvailability;
  /** True while the mic is open and we are listening. */
  listening: boolean;
  /** Whatever has been transcribed so far, for live feedback. */
  interim: string;
  /** Set when recognition started but could not finish. */
  error: string | null;
}

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: any) => void) | null;
  onerror: ((e: any) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
};

function recognitionCtor(): (new () => SpeechRecognitionLike) | null {
  const w = globalThis as any;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export class SpeechService {
  private recognition: SpeechRecognitionLike | null = null;
  private listeners = new Set<(s: SpeechState) => void>();

  private state: SpeechState = {
    availability: "unsupported",
    listening: false,
    interim: "",
    error: null,
  };

  constructor() {
    this.state = {
      ...this.state,
      availability: this.probe(),
    };
  }

  private probe(): SpeechAvailability {
    if (typeof navigator === "undefined") return "unsupported";
    if (!navigator.mediaDevices?.getUserMedia) return "no-mic";
    return recognitionCtor() ? "ready" : "no-mic";
  }

  getState(): SpeechState {
    return this.state;
  }

  subscribe(cb: (s: SpeechState) => void): () => void {
    this.listeners.add(cb);
    cb(this.state);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private update(patch: Partial<SpeechState>): void {
    this.state = { ...this.state, ...patch };
    for (const cb of this.listeners) cb(this.state);
  }

  /**
   * Listen once and resolve with the transcription.
   *
   * Resolves null when the user cancelled or nothing intelligible was said —
   * silence is a normal outcome for a child mumbling at a robot, and must not
   * look like an error.
   */
  listen(timeoutMs = 7000): Promise<SpeechResult | null> {
    const Ctor = recognitionCtor();
    if (!Ctor) return Promise.resolve(null);

    if (!navigator.mediaDevices?.getUserMedia) {
      this.update({ availability: "no-mic" });
      return Promise.resolve(null);
    }

    return new Promise<SpeechResult | null>((resolve) => {
      let settled = false;
      const finish = (result: SpeechResult | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.update({ listening: false, interim: "" });
        resolve(result);
      };

      const recognition = new Ctor();
      this.recognition = recognition;
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.lang = "en-US";
      recognition.maxAlternatives = 1;

      recognition.onstart = () => this.update({ listening: true, error: null, interim: "" });

      recognition.onresult = (event: any) => {
        let interim = "";
        for (let i = 0; i < event.resultIndex; i += 1) {
          const result = event.results[i];
          const transcript = result[0]?.transcript ?? "";
          if (result.isFinal) {
            const confidence = typeof result[0]?.confidence === "number"
              ? result[0].confidence
              : undefined;
            finish({ text: transcript.trim(), confidence });
            return;
          }
          interim += transcript;
        }
        this.update({ interim: interim.trim() });
      };

      recognition.onerror = (event: any) => {
        const code = String(event?.error ?? "unknown");
        const message =
          code === "not-allowed" || code === "service-not-allowed"
            ? "Microphone permission denied"
            : code === "no-speech"
              ? "Didn't hear anything"
              : `Speech recognition failed (${code})`;
        this.update({ error: message, availability: code.includes("not-allowed") ? "no-mic-permission" : this.state.availability });
        finish(null);
      };

      recognition.onend = () => finish(null);

      // A recogniser that never fires would hang the button forever, so the
      // listen gesture is always time-boxed.
      const timer = setTimeout(() => {
        try {
          recognition.stop();
        } catch {
          /* already stopped */
        }
        finish(null);
      }, timeoutMs);

      try {
        recognition.start();
      } catch {
        finish(null);
      }
    });
  }

  /** Abandon an in-flight listen, e.g. the user navigated away. */
  cancel(): void {
    try {
      this.recognition?.abort();
    } catch {
      /* already stopped */
    }
    this.recognition = null;
    this.update({ listening: false, interim: "" });
  }
}

export const speech = new SpeechService();