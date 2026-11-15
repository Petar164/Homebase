import type { Approval, ConversationMessage, ConversationSummary, CoreEvent, HeliosState, TurnResult } from "@homebase/shared";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api.ts";

// The conversation with HELIOS, shown under the brain like subtitles.
// Typing is the stand-in for speaking until the voice worker exists; the
// messages, the live state and the approval requests all arrive over the
// core's event stream, so a spoken conversation will appear here unchanged.

/** A page reload continues the last conversation if it is this recent. */
const CONTINUE_WITHIN_MINUTES = 30;

/** The part of the voice status this screen uses. */
type VoiceInfo = { worker: "off" | "starting" | "running" | "restarting" | "failed"; lastError: { code: string } | null };

export function Conversation({ onState, onChanged }: { onState: (state: HeliosState) => void; onChanged: () => void }) {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [streaming, setStreaming] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [transcript, setTranscript] = useState(() => localStorage.getItem("homebase.transcript") !== "off");
  const [voice, setVoice] = useState<VoiceInfo | null>(null);
  const [helios, setHelios] = useState<HeliosState>("idle");
  const [talking, setTalking] = useState(false);
  /** Ask for the stronger model for the next message only. */
  const [strong, setStrong] = useState(false);

  // The event handler below is created once; these refs give it the latest values.
  const current = useRef<string | null>(null);
  current.current = conversationId;
  const reportState = useRef(onState);
  reportState.current = onState;

  const addMessages = useCallback((incoming: ConversationMessage[]) => {
    setMessages((existing) => {
      const known = new Set(existing.map((message) => message.id));
      return [...existing, ...incoming.filter((message) => !known.has(message.id))].sort((a, b) => a.seq - b.seq);
    });
  }, []);

  const putApproval = useCallback((approval: Approval) => {
    setApprovals((existing) => [...existing.filter((other) => other.id !== approval.id), ...(approval.status === "pending" ? [approval] : [])]);
  }, []);

  useEffect(() => {
    api<Approval[]>("GET", "/api/approvals").then(setApprovals).catch(() => {});
    api<ConversationSummary[]>("GET", "/api/conversations")
      .then(async (list) => {
        const latest = list[0];
        if (!latest || Date.now() - new Date(latest.lastMessageAt).getTime() > CONTINUE_WITHIN_MINUTES * 60_000) return;
        setConversationId(latest.id);
        addMessages(await api<ConversationMessage[]>("GET", `/api/conversations/${latest.id}/messages`));
      })
      .catch(() => {});
  }, [addMessages]);

  useEffect(() => {
    const load = () => api<VoiceInfo>("GET", "/api/voice/status").then(setVoice).catch(() => {});
    load();
    const timer = setInterval(load, 20_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    // The browser reconnects an EventSource by itself if the core restarts.
    const source = new EventSource("/api/stream");
    source.onmessage = (raw) => {
      let event: CoreEvent;
      try {
        event = JSON.parse(raw.data as string) as CoreEvent;
      } catch {
        return;
      }
      const mine = (id: string) => current.current === null || current.current === id;
      if (event.type === "state") {
        setHelios(event.state);
        if (event.state === "idle" || event.state === "transcribing") setTalking(false);
        reportState.current(event.state);
        if (event.state === "idle") setStreaming("");
      } else if (event.type === "delta" && mine(event.conversationId)) {
        setStreaming((soFar) => soFar + event.text);
      } else if (event.type === "message" && mine(event.conversationId)) {
        addMessages([event.message]);
        if (event.message.role === "assistant") setStreaming("");
      } else if (event.type === "approval") {
        putApproval(event.approval);
      }
    };
    return () => source.close();
  }, [addMessages, putApproval]);

  const fail = (caught: unknown) => setError(caught instanceof ApiError ? caught.message : "The core is not answering.");

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const say = text.trim();
    if (!say || busy) return;
    setBusy(true);
    setError("");
    setText("");
    try {
      const turn = await api<TurnResult>("POST", "/api/helios/message", { text: say, conversationId: conversationId ?? undefined, reasoning: strong ? "strong" : undefined });
      setStrong(false);
      setConversationId(turn.conversationId);
      addMessages(turn.messages);
      turn.approvals.forEach(putApproval);
    } catch (caught) {
      fail(caught);
      setText(say);
    } finally {
      setBusy(false);
    }
  };

  const decide = async (approval: Approval, decision: "approve" | "deny") => {
    setError("");
    try {
      const result = await api<{ approval: Approval; turn: TurnResult | null }>("POST", `/api/approvals/${approval.id}/decide`, { decision });
      putApproval(result.approval);
      if (result.turn) addMessages(result.turn.messages);
      onChanged(); // an approved action may have changed what the screen shows
    } catch (caught) {
      fail(caught);
    }
  };

  // Push-to-talk. The microphone belongs to the machine the core runs on,
  // not to this browser: the button only tells the core when to listen.
  const voiceReady = voice?.worker === "running";
  const talk = useCallback(
    async (action: "start" | "stop") => {
      setError("");
      setTalking(action === "start");
      try {
        await api("POST", "/api/voice/listen", { action });
      } catch (caught) {
        setTalking(false);
        setError(caught instanceof ApiError ? caught.message : "The core is not answering.");
      }
    },
    [],
  );
  const stopSpeaking = () => api("POST", "/api/voice/stop-speaking", {}).catch(fail);

  // Holding the space bar talks too, unless something is being typed.
  useEffect(() => {
    if (!voiceReady) return;
    const typing = (target: EventTarget | null) => target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
    const down = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat || typing(event.target)) return;
      event.preventDefault();
      void talk("start");
    };
    const up = (event: KeyboardEvent) => {
      if (event.code !== "Space" || typing(event.target)) return;
      event.preventDefault();
      void talk("stop");
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [voiceReady, talk]);

  const toggleTranscript = () => {
    setTranscript((on) => {
      localStorage.setItem("homebase.transcript", on ? "off" : "on");
      return !on;
    });
  };

  const startNew = () => {
    setConversationId(null);
    setMessages([]);
    setStreaming("");
    setError("");
  };

  // With the transcript off, only HELIOS's latest words stay on screen.
  const lastAnswer = [...messages].reverse().find((message) => message.role !== "user");
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  const shown = transcript ? messages.slice(-5) : lastAnswer ? [lastAnswer] : [];

  return (
    <div className="mx-auto flex h-full w-full max-w-[38rem] flex-col justify-end gap-3 pb-2">
      <div aria-live="polite" className="space-y-2">
        {shown.map((message) =>
          message.role === "user" ? (
            <p key={message.id} className="text-right text-sm text-mute">
              {message.text}
            </p>
          ) : message.role === "assistant" ? (
            <p key={message.id} className="text-xl leading-snug font-light text-bone">
              {message.text}
            </p>
          ) : (
            <p key={message.id} className="text-sm text-salmon/90">
              {message.text}
            </p>
          ),
        )}
        {streaming && <p className="text-xl leading-snug font-light text-soft">{streaming}</p>}
        {/* Which model wrote the last answer, and why it was the one chosen. */}
        {lastAssistant?.model && !streaming && (
          <p className="text-xs text-mute">
            {lastAssistant.model}
            {lastAssistant.route && ` · ${lastAssistant.route}`}
          </p>
        )}
      </div>

      {approvals.map((approval) => (
        <div key={approval.id} role="group" aria-label="HELIOS needs your yes" className="rounded-lg border border-salmon/40 bg-ink/90 p-4">
          <p className="label">{approval.kind === "cloud_egress" ? "Leaves this machine" : "Needs your yes"}</p>
          <p className="mt-1 text-base text-bone">{approval.summary}</p>
          {approval.preview.length > 0 && (
            <ul className="mt-2 max-h-28 space-y-0.5 overflow-hidden text-xs text-mute">
              {approval.preview.slice(-6).map((line, index) => (
                <li key={index} className="truncate">
                  <span className={line.sensitivity === "sensitive" ? "text-salmon" : ""}>{line.sensitivity}</span> · {line.role} · {line.excerpt}
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 flex gap-2">
            <button type="button" onClick={() => decide(approval, "approve")} className="rounded-md bg-bone px-4 py-1.5 text-sm font-medium text-void hover:bg-white">
              {approval.kind === "cloud_egress" ? "Send it" : "Yes, do it"}
            </button>
            <button type="button" onClick={() => decide(approval, "deny")} className="rounded-md border border-line px-4 py-1.5 text-sm text-soft hover:border-mute">
              No
            </button>
          </div>
        </div>
      ))}

      {error && (
        <p role="alert" className="text-sm text-salmon">
          {error}
        </p>
      )}

      <form onSubmit={send} className="flex items-center gap-3">
        {voiceReady &&
          (helios === "speaking" ? (
            <button type="button" onClick={stopSpeaking} className="shrink-0 rounded-full border border-salmon/60 px-4 py-2.5 text-sm text-bone hover:bg-salmon/10">
              Stop
            </button>
          ) : (
            <button
              type="button"
              onPointerDown={() => void talk("start")}
              onPointerUp={() => talking && void talk("stop")}
              onPointerLeave={() => talking && void talk("stop")}
              aria-pressed={talking}
              className={`shrink-0 rounded-full border px-4 py-2.5 text-sm select-none ${talking ? "border-salmon bg-salmon/15 text-bone" : "border-line text-soft hover:border-mute"}`}
            >
              {talking ? "Listening…" : "Hold to talk"}
            </button>
          ))}
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          maxLength={4000}
          placeholder={busy ? "HELIOS is answering…" : "Say something to HELIOS…"}
          aria-label="Message to HELIOS"
          className="min-w-0 flex-1 rounded-full border border-line bg-ink/80 px-5 py-2.5 text-base text-bone outline-none placeholder:text-mute focus:border-salmon/60"
        />
        <button
          type="button"
          onClick={() => setStrong((on) => !on)}
          aria-pressed={strong}
          title="Use the stronger model for the next message"
          className={`text-xs tracking-widest uppercase ${strong ? "text-salmon" : "text-mute hover:text-bone"}`}
        >
          Think hard
        </button>
        <button type="button" onClick={toggleTranscript} className="text-xs tracking-widest text-mute uppercase hover:text-bone" aria-pressed={transcript}>
          Transcript {transcript ? "on" : "off"}
        </button>
        {messages.length > 0 && (
          <button type="button" onClick={startNew} className="text-xs tracking-widest text-mute uppercase hover:text-bone">
            New
          </button>
        )}
      </form>
    </div>
  );
}
