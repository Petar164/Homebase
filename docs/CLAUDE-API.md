# Claude as an optional cloud model

**HELIOS is local first.** The model on this machine answers. Claude,
through Anthropic's API, answers one message only when you ask for Claude
in that message, and only if you have switched cloud models on. HELIOS
never chooses Claude by itself.

This page says how to ask for Claude, how it is set up, what it sends,
what it costs and what happens when it fails.

Related: [the models and the budget](AI-VOICE-STACK.md),
[the security model](SECURITY.md), [web access](WEB-ACCESS.md).

**Status.** Built and tested on the Mac with stand-ins. **No real request
has ever been made**: no API key exists. The checks at the end of this page
are for the first real ones.

## In short

- **The local model is the default, always.** On the laptop that is
  `gpt-oss:20b`. A long question, a hard question, a missing or failing
  local model: none of these sends anything to Claude.
- **Claude answers only when you ask for it**, for that one message: begin
  the message with "Ask Claude ...", spoken or typed, or use "Ask Claude"
  on the screen. The next message is an ordinary one again.
- **Off until you switch it on.** A key in the `.env` file does not switch
  anything on. The switch is on the main screen and asks for the password.
  Switching it on makes Claude available to be asked for. Nothing more.
- **It is billed per request, on its own.** A Claude subscription (Pro or
  Max) does not include API use. The API needs its own key and its own
  credit, from the Anthropic Console.
- **A monthly limit in euros**, €20 unless you change it. When it is
  reached, nothing more is sent and the local model answers.
- **Sensitive records are not sent without a yes for that conversation**,
  also when you asked for Claude. Anything that looks like a password or
  a key is never sent.

## How it works

```
your message
     │
     ▼
 does this message ask for Claude?        (it begins with one of a fixed
     │                                      list of commands, or the
     │                                      screen's "Ask Claude" was used)
     ├── no ──► the model on this machine answers. Always.
     │
     └── yes
          ▼
      may it go to Claude?    switched on · a usable key · room in the
          │                   budget · nothing secret · nothing sensitive
          │                   without your yes
          ├── no ──► HELIOS says why, and the model on this machine
          │          answers under its own name
          ▼
      the most it can cost is set aside
          │
          ▼
      Claude answers this one message ──► words on screen and by voice
          │
          └─► or asks for a tool ──► the same gate as for every model
```

The rule is in `apps/core/src/ai/policy.ts`, in one place: a cloud model
is looked at only for a message that asks for Claude. The provider is
`apps/core/src/ai/claude.ts`, on Anthropic's official SDK,
`@anthropic-ai/sdk`. The turn loop is `apps/core/src/ai/helios.ts`.

## How to ask for Claude

There are two ways, and both hold for one message only.

**On the screen.** "Ask Claude", next to the message box. It lights up,
the message box says "This one message goes to Claude", and after you
send the message it is off again. It is for a typed message: if you hold
the talk button instead, it goes off, and a spoken message asks in words.

**In words, typed or spoken.** Begin your message by telling HELIOS to
use Claude, by name:

| You say | |
|---|---|
| "Ask Claude to analyze this." "Ask Claude what I should drop." | the usual form |
| "Use Claude for this question." "Try Claude." | |
| "Let Claude answer this one." "Have Claude look at this." "Get Claude to check the numbers." | |
| "Send this to Claude." "Run it by Claude." "Switch to Claude for this." | |
| "Check this with Claude." "Compare the two plans using Claude." | |
| "I want Claude for this one." | |

**The command comes first.** Only the beginning of a message is read for
it. A greeting may stand before it ("Helios, ...", "Thanks. Now ..."), and
so may "please", "can you", "could you", "I'd like you to" and "let's".
The question can follow the command: "Ask Claude: what is the best plan
here?", or "Use Claude for this question: ...". A command on its own
refers to what was said before it: "Ask Claude to analyze this."

These are a fixed list, read by a fixed rule. No model is asked what you
meant. So the same words always decide the same way, and what does not
match stays on this machine:

- **A mention is not a request**: "What is Claude?", "I read about Claude
  yesterday", "my chat with Claude went badly".
- **Wondering is not a request**: "Should I ask Claude?", "Ask Claude?",
  "If I ask Claude, what does it cost?"
- **Saying not to is not a request**: "Don't ask Claude.", and also "Don't,
  under any circumstances, ask Claude."
- **Anything later in the message is not a request**: thinking aloud ("I
  could just ask Claude"), what somebody else said ("He said, ask
  Claude"), and text you pasted in. An article that ends in "Try Claude
  today" does not send itself to Claude.
- **Other words are not the name**: "the cloud model", "the stronger
  model", "think hard", "Sonnet", "Claude Code", "Claude's API key". The
  phrases that selected the cloud model in earlier versions no longer do.
- **Speaking to Claude is not asking HELIOS for it**: "Claude, what do
  you think?"

**When the words come close.** A request that does not come first is not
a request either: "What is the best plan here? Ask Claude." stays on this
machine. So that you do not take the answer for Claude's, HELIOS says so
before it answers, on screen and by voice, whenever a message holds such
a command without beginning with it: "I did not take that as a request
for Claude, so the answer below is from this machine. To ask Claude, begin
your message with "Ask Claude"."

By voice the same rule reads what the speech recogniser wrote. If it
mishears the name as "cloud", the request is not recognised and the local
model answers. Say it again, or use the screen.

**What you see.** Your message is marked "asked Claude". While Claude is
at work the screen says "Claude is answering" with the model's name. Under
every answer stands the model that wrote it and why: "you asked for
Claude", or "an ordinary request". The request is also written to the
audit log, and each call to the egress log.

## Setting it up

1. Create an API key in the Anthropic Console and put credit on the
   account. This is separate from any Claude subscription.
2. Put the key in the `.env` file next to `package.json`:
   `ANTHROPIC_API_KEY=...`. Git ignores that file.
3. `npm run homebase -- cloud status` shows whether the key can be used,
   which models are set, and the limits. It sends nothing.
4. `npm run homebase -- cloud check` sends one short test question to the
   light model, after asking you. It costs a fraction of a cent, shows
   what it cost, and tells you plainly if the key or the account is
   refused. Add `strong` to test the strong model.
5. Start the core. On the main screen, top right: "Claude off · Turn on",
   and enter the password. It then says "Claude on · only when you ask".

To stop using it, "Turn off" works at once and needs no password. Taking
the key out of `.env` has the same effect after a restart.

## Settings

In `config.json` in the data folder, under `ai`:

| Setting | Default | Meaning |
|---|---|---|
| `cloud.allowed` | `false` | The switch. The screen's "Turn on" sets it. On means: Claude can be asked for |
| `cloud.strongModel` | `claude-sonnet-5-5` | The model that answers when you ask for Claude |
| `cloud.lightModel` | `claude-haiku-5-5` | Used by `cloud check` only. Nothing in a conversation uses it |
| `cloud.effort.strong`, `.light` | `medium`, `low` | How hard each model thinks. Lower is faster and cheaper |
| `cloud.maxOutputTokens.strong`, `.light` | 8,000, 2,000 | The longest one answer may be. Also the most one answer can cost |
| `cloud.budget.capEur`, `.warnEur` | 20, 15 | The monthly limit and the warning before it |
| `cloud.budget.usdToEur`, `.taxAllowance` | 1, 0.21 | How dollars are counted as euros: on the safe side |
| `cloud.pricePerMTok` | see below | The prices the budget counts with. Update them when Anthropic's change |
| `cloud.baseUrl` | empty | Another address than Anthropic's own. Leave empty |

There is no setting that makes HELIOS choose Claude by itself. Three
entries of earlier versions are no longer read, so a settings file that
still holds them changes nothing: `prefer` and `routing` (they sent long
or analytical questions to the cloud), and `"enabled": true` under `cloud`
(earlier versions wrote that by themselves).

## What leaves this machine

Nothing leaves because cloud models are switched on. Something leaves
only for a message that asks for Claude. Then this is sent to Anthropic,
over an encrypted connection, and nothing else:

- HELIOS's fixed instructions and the list of its tools.
- The part of this conversation a model is shown: at most the 40 messages
  up to yours. "Ask Claude to analyze this" is about what was said before,
  so that is what goes with it.
- What Claude then asks HELIOS's tools for, to answer you: your tasks or
  calendar, a search of earlier conversations, text from the web. Each
  such result is labelled, and the table below applies to it.

Not sent: your files, the database, other conversations as a whole, and
no key or password of any kind.

| What the conversation holds | What happens when you ask for Claude |
|---|---|
| Ordinary and private things (your questions, tasks, calendar) | Sent |
| Sensitive things (money figures, anything marked sensitive) | Not sent until you say yes. A card shows what would go. A yes covers what that conversation holds at that moment, for 30 minutes; anything sensitive that comes in later asks again |
| Secret things (anything that looks like a password or key) | Never sent, and not shown to the local model either |

Every request that went out, was held for a yes, or was stopped by the
limit is one line in the egress log: when, which model, how large, the
highest label in it, and what it cost. The text itself is not logged
anywhere.

Claude does not search the web for HELIOS and runs nothing on Anthropic's
side: no server-side tools are switched on. Web searches are made by this
machine, under the rules in [WEB-ACCESS.md](WEB-ACCESS.md).

What Anthropic does with what it receives is governed by its own terms
for API customers, not by this page. Read them before switching this on.

## The key

- Only `ANTHROPIC_API_KEY` counts. The SDK would by itself also pick up a
  sign-in token, a profile another tool left on disk, or an address from
  another variable. HELIOS passes the SDK its own key and Anthropic's own
  address and lets it take nothing from its surroundings, so that a
  credential nobody set up for HELIOS is never used.
- A value that cannot be right is refused before anything is sent, and
  `cloud status` says which: an Admin key (it could manage the whole
  account), the sign-in token of a Claude subscription, a value with a
  space or a line break in it.
- The key is sent to Anthropic only. Another address (`cloud.baseUrl`)
  must be `https`, or this machine itself.
- It is never written to the settings file, the database, the audit log
  or the core's log, and it is not passed to the voice worker. The SDK's
  own logging is switched off, because at its most talkative it prints
  requests. Error messages shown to you are written by HELIOS and never
  repeat what the API answered.
- It is still a plain line in `.env`. Protected storage (Windows
  Credential Manager) is not built.

## What it costs

Prices as HELIOS counts them, in US dollars per million tokens. They are
the list prices as of November 2026 and are settings: check Anthropic's
price page before relying on them.

| Model | Input | Output |
|---|---|---|
| `claude-sonnet-5-5` | $2.00 | $10.00 |
| `claude-haiku-5-5` | $0.10 (prompts up to 100,000 tokens; $0.50 above) | $0.50 ($2.50 above) |
| `claude-opus-5-5` (not used unless you set it) | $4.00 | $20.00 |

**What a question to Claude is likely to cost.** Worked out from those
prices and from the size of HELIOS's own requests, which was measured on
the Mac. It is not a measured bill: no request has been made.

- HELIOS's instructions and tools are about 6,300 bytes, sent with every
  request. A first question adds a few hundred bytes. That is about 1,700
  tokens, or 2,250 the cautious way the budget counts.
- An answer is Claude's thinking plus its words. 400 tokens is a fair
  guess for a spoken answer.

| | One answer | A question that uses one tool (two requests) | Set aside before each request |
|---|---|---|---|
| Sonnet 5.5 | about €0.01 | about €0.02 | €0.10 |

In euros as the budget counts them: one dollar as one euro, plus 21 per
cent. A long conversation costs more per question, because the earlier
messages are sent again each time. Since Claude answers only when asked,
the month's cost is the number of times you ask: ten questions a day
would be about €3 to €6 a month. A month in which you never ask costs
nothing.

**The limit.** Before each request the most it can cost is set aside. If
that does not fit under the monthly limit, the request is not made. After
the answer the real cost replaces what was set aside. Details:
[AI-VOICE-STACK.md](AI-VOICE-STACK.md#budget-and-cost). Three cases are
counted on the safe side:

- A request that broke off after Claude had begun to answer may be on the
  bill, and nobody here knows for how much. It is counted at the full
  amount that was set aside, marked as an estimate.
- When Claude declines a request and Anthropic lets another Claude model
  answer instead, both attempts are on the bill. Both are counted, each at
  its own model's price.
- The one `cloud check` request is not counted. Its cost is shown when it
  runs.

The limit in HELIOS is a second line of defence. The first is the
spending limit you can set on the account in the Anthropic Console.

## When Claude is not the one answering

You asked for Claude, and it cannot or may not answer. HELIOS never
answers in Claude's place without saying so. It says why first, on screen
and by voice, and the answer that follows carries the name of the model
that wrote it.

| What stands in the way | What you are told, before the local model's answer |
|---|---|
| Cloud models are switched off | "Claude is switched off on this machine, so it was not asked. You can turn cloud models on from the main screen. The answer below is from the model on this machine." Nothing is switched on for you |
| No usable key | "Claude cannot be asked: no API key is set (ANTHROPIC_API_KEY in the .env file). ..." |
| The month's budget is used up | "This month's cloud budget is used up, so Claude was not asked. ..." |
| The conversation holds something secret | "This conversation holds something that never goes to a cloud model, so Claude was not asked. ..." |
| The key was not accepted | "claude-sonnet-5-5 could not answer. Anthropic did not accept the API key. Check ANTHROPIC_API_KEY in the .env file." and then "The answer below is from the model on this machine, not from Claude." |
| No credit, or a billing problem | "... Anthropic reports a billing problem. The API account may have no credit left; a Claude subscription does not include any." and the same second sentence |
| Too many requests, an overloaded service, no internet | Named as such, and the same second sentence. An overloaded service is tried once more first |
| Claude declined the question | "The model declined to answer that." Anthropic may answer with another Claude model instead |
| The answer hit its length limit | The part that arrived, and "That answer was cut off at its length limit." |
| You said no to sending sensitive content | "Not sent: nothing more went to Claude. Ask again without asking for Claude, and the model on this machine answers." No answer follows |
| The request did not come first in your message | "I did not take that as a request for Claude, so the answer below is from this machine. To ask Claude, begin your message with "Ask Claude"." |
| You said yes to a web request of an earlier question, after asking something else | "This belongs to an earlier question that asked for Claude. You have said something else since, so Claude is not asked again, and the answer below is not from Claude." |

A failed request is not repeated by HELIOS. The one exception costs
nothing: when Anthropic turns a request down over the reasoning that is
sent back with it, the same question is asked once more without that
reasoning.

If the local model fails, nothing is handed to Claude in its place.
HELIOS says that the model did not answer.

## Tool requests and changes

Claude can ask for the same tools as the local model, and every request
passes the same gate (see [SECURITY.md](SECURITY.md)): the input is
checked, the risk tier decides, and a change waits for your yes unless
you have allowed small changes to run by themselves.

- A tool request from an answer that was cut off or declined never runs.
- Nothing is run twice because a model failed. What a tool did is written
  to the transcript before the model is asked again, so the model that
  takes over sees it. If that model asks for a change all the same, the
  change waits for your yes, also when small changes are allowed to run
  by themselves.
- Your yes to a request is written down before its action runs. The same
  yes cannot run it a second time, not even after a crash in the middle,
  and a request that a model repeats gets a card of its own.
- A card that asks whether a conversation may be sent to Claude belongs
  to the question it was raised for. When you send another message, the
  card is closed. A yes that comes too late sends nothing.
- Every other card remembers its question too. When Claude asked for a
  web search and you say yes while that is still your latest question,
  Claude reads what came back. If you have said something else in
  between, the search still runs, but the model on this machine reads the
  result: neither the earlier request for Claude nor a later one is used
  for it.

## Limits, and what is not tested

- **Never run against the real API.** Everything here was tested with
  stand-ins: a stand-in for the SDK's client, and the real SDK talking to
  a stand-in service on the Mac. Whether Anthropic accepts each field of
  the request is only shown by a real call.
- **Never run with a real microphone.** That a spoken "Ask Claude ..."
  is written down by the speech recogniser the way the rule expects is
  not tested. The rule itself is tested on written examples.
- **The list of commands is short on purpose, and only the beginning of a
  message is read.** A request phrased another way, or placed after other
  words, is not recognised, and the local model answers. That is the side
  it is meant to fail on. The screen's "Ask Claude" always works.
- **Words are read as yours.** If a message begins with pasted text, and
  that text begins with such a command, it counts as a request. "Send
  this to Claude" is read as the assistant also when you know a person of
  that name.
- The limit counts what HELIOS sends. It does not see other use of the
  same key.
- Prices are settings and go out of date. An unknown model is counted at
  the highest known price.
- When an answer breaks off in the middle, the words that were already
  shown or spoken stay shown or spoken, and the next model's answer
  follows them, after the sentence that says it is not Claude's.
- A running answer cannot be cancelled. There is no such control yet.
- The key is in a plain file.

## Checks on the laptop

Run on the test instance (its own data folder, port 7127), with a key in
`.env`. A check is "Passed" only when it ran on the laptop and did what
the right column says. They cost a few cents in total.

| # | Do | Expect |
|---|---|---|
| C1 | `npm run homebase -- cloud status` without a key, then with one | "not usable: no API key is set", then "set". The key is not printed. "Used: only for a message in which you ask for Claude" |
| C2 | `npm run homebase -- cloud check`, answer `yes` | The light model answers in one sentence. Tokens and cost are shown |
| C3 | `npm run homebase -- cloud check strong`, answer `yes` | The strong model answers. This shows that the fallback option is accepted |
| C4 | Start the core with the key in place and Claude off. Ask: "Ask Claude which of my tasks matters most." | "Claude is switched off on this machine, so it was not asked. ..." and then the local model's answer, with `gpt-oss:20b` under it |
| C5 | "Turn on" on the screen | The password is asked for. Then: "Claude on · only when you ask" |
| C6 | With Claude on, ask an ordinary question, then a long and difficult one, without naming Claude | The local model answers both. Under each: "an ordinary request". "Cloud this month" does not move |
| C7 | Ask C4's question again | "Claude is answering" appears, the words come as they are written, and the Claude model's name and "you asked for Claude" are under the answer. "Cloud this month" shows a few cents |
| C8 | Ask a follow-up without naming Claude: "And the second most important?" | The local model answers |
| C9 | Ask: "Ask Claude how the shop did this month." | A card asks before the money figures are sent. "No": nothing is sent |
| C10 | Put a wrong key in `.env`, restart, ask C4's question. Put the right key back | "Anthropic did not accept the API key...", then "The answer below is from the model on this machine, not from Claude.", then the local model's answer |
| C11 | Hold to talk: "Helios, ask Claude which of my tasks matters most." Then, without naming Claude: "And what is due tomorrow?" | Claude answers the first, the local model the second. Note what the recogniser wrote for "Claude" |
| C12 | Type, with the request after the question: "Which of my tasks matters most? Ask Claude." | "I did not take that as a request for Claude, ..." and then the local model's answer. "Cloud this month" does not move |

| # | Result | Date | Notes |
|---|---|---|---|
| C1 | Not run | | |
| C2 | Not run | | |
| C3 | Not run | | |
| C4 | Not run | | |
| C5 | Not run | | |
| C6 | Not run | | |
| C7 | Not run | | |
| C8 | Not run | | |
| C9 | Not run | | |
| C10 | Not run | | |
| C11 | Not run | | |
| C12 | Not run | | |
