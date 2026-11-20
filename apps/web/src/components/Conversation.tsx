import type { Approval, ConversationMessage, ConversationSummary, CoreEvent, HeliosState, TurnResult, WebActivity } from "@homebase/shared";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api.ts";
import { ActivityLine, Cited, WebNote } from "./WebSources.tsx";

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
  /** Send the next message to Claude. It holds for that one message, then switches itself off. */
  const [claude, setClaude] = useState(false);
  /** The name of the model at work on an answer right now, while that model is Claude. */
  const [claudeAtWork, setClaudeAtWork] = useState<string | null>(null);
  /** Web requests of the turn in progress: what is being searched or read right now. */
  const [activity, setActivity] = useState<WebActivity[]>([]);

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
        if (event.state === "idle") {
          setStreaming("");
          setClaudeAtWork(null);
          // The turn is over. What the web was used for, and what failed, now stands under the answer itself.
          setActivity([]);
        }
      } else if (event.type === "activity" && mine(event.conversationId)) {
        setActivity((existing) => [...existing.filter((other) => other.id !== event.activity.id), event.activity]);
      } else if (event.type === "answering" && mine(event.conversationId)) {
        setClaudeAtWork(event.cloud ? event.model : null);
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
    setActivity([]);
    try {
      // "Ask Claude" goes along with this one message and is then off again: the next message is an ordinary one.
      const turn = await api<TurnResult>("POST", "/api/helios/message", { text: say, conversationId: conversationId ?? undefined, claude: claude ? true : undefined });
      setClaude(false);
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
      // "Ask Claude" is for the next typed message. A spoken message asks in
      // words. So the choice does not stay lit across something spoken, to
      // be used by a message typed later.
      if (action === "start") setClaude(false);
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
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  // With the transcript hidden, what is shown is the answer to the latest
  // message, together with the remarks HELIOS made on the way to it. Such a
  // remark can be that Claude was asked for and is not the one answering,
  // and an answer must never stand there without it.
  const lastOwn = messages.findLastIndex((message) => message.role === "user");
  const sinceLastOwn = messages.slice(lastOwn + 1);
  // Until the new answer begins, the one before it stays on screen, as it
  // always did. Not while Claude is at work, though: an earlier answer must
  // not stand right above "Claude is answering" as if it were Claude's.
  const earlier = messages.slice(0, Math.max(lastOwn, 0));
  const latestTurn = sinceLastOwn.length > 0 || claudeAtWork ? sinceLastOwn : earlier.slice(earlier.findLastIndex((message) => message.role === "user") + 1);
  const shown = transcript ? messages.slice(-5) : latestTurn.slice(-4);

  return (
    <div className="mx-auto flex h-full w-full max-w-[38rem] flex-col justify-end gap-3 pb-2">
      {/* When the transcript is taller than its place, its oldest lines are cut off at the top instead of running into the rest of the screen. */}
      <div aria-live="polite" className="flex min-h-0 flex-col justify-end gap-2 overflow-hidden">
        {shown.map((message) =>
          message.role === "user" ? (
            <p key={message.id} className="text-right text-sm text-mute">
              {message.text}
              {/* This message asked for Claude. The mark belongs to this message alone. */}
              {message.askedClaude && <span className="ml-2 text-xs tracking-widest text-salmon/80 uppercase">asked Claude</span>}
            </p>
          ) : message.role === "assistant" ? (
            <div key={message.id}>
              <p className="text-xl leading-snug font-light text-bone">
                <Cited text={message.text} sources={message.web?.sources} />
              </p>
              {/* An answer that used the live web says so and shows its sources; one that did not has nothing here. */}
              {message.web && <WebNote web={message.web} open={message.id === lastAssistant?.id} />}
            </div>
          ) : (
            <p key={message.id} className="text-sm text-salmon/90">
              {message.text}
            </p>
          ),
        )}
        {/* Shown only while Claude itself is at work on the answer. */}
        {claudeAtWork && <p className="text-xs tracking-widest text-salmon/80 uppercase">Claude is answering · {claudeAtWork}</p>}
        {streaming && <p className="text-xl leading-snug font-light text-soft">{streaming}</p>}
        {activity.slice(-3).map((entry) => (
          <ActivityLine key={entry.id} activity={entry} />
        ))}
        {/* Which model wrote the last answer, and why it was the one chosen. */}
        {lastAssistant?.model && !streaming && shown.some((message) => message.id === lastAssistant.id) && (
          <p className="text-xs text-mute">
            {lastAssistant.model}
            {lastAssistant.route && ` · ${lastAssistant.route}`}
          </p>
        )}
      </div>

      {approvals.map((approval) => (
        <div key={approval.id} role="group" aria-label="HELIOS needs your yes" className="rounded-lg border border-salmon/40 bg-ink/90 p-4">
          <p className="label">{approval.kind === "cloud_egress" || approval.web ? "Leaves this machine" : "Needs your yes"}</p>
          <p className="mt-1 text-base break-words text-bone">{approval.summary}</p>
          {/* A web request: exactly what would be sent, to whom, and why HELIOS asks first. */}
          {approval.web && (
            <dl className="mt-2 space-y-0.5 text-xs text-mute">
              <div>
                <dt className="inline">Goes to </dt>
                <dd className="inline text-soft">{approval.web.to}</dd>
              </div>
              <div className="break-all">
                <dt className="inline">What is sent </dt>
                <dd className="inline text-soft">{approval.web.sends}</dd>
              </div>
              <div>
                <dt className="inline">Why you are asked </dt>
                <dd className="inline text-soft">{approval.web.because}</dd>
              </div>
            </dl>
          )}
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
              {approval.web ? (approval.web.kind === "search" ? "Search" : "Open it") : approval.kind === "cloud_egress" ? "Send it" : "Yes, do it"}
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
          placeholder={busy ? "HELIOS is answering…" : claude ? "This one message goes to Claude…" : "Say something to HELIOS…"}
          aria-label="Message to HELIOS"
          className="min-w-0 flex-1 rounded-full border border-line bg-ink/80 px-5 py-2.5 text-base text-bone outline-none placeholder:text-mute focus:border-salmon/60"
        />
        <button
          type="button"
          onClick={() => setClaude((on) => !on)}
          aria-pressed={claude}
          title="Send the next message to Claude, and only that one"
          className={`text-xs tracking-widest uppercase ${claude ? "text-salmon" : "text-mute hover:text-bone"}`}
        >
          Ask Claude
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
