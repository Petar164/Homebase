# Claude as an optional cloud model

HELIOS answers with the model on this machine. It can also hand a hard
question to Claude, through Anthropic's API, when the owner has allowed
that. This page says how that is set up, what it sends, what it costs and
what happens when it fails.

Related: [which model answers and how the budget counts](AI-VOICE-STACK.md),
[the security model](SECURITY.md), [web access](WEB-ACCESS.md).

**Status.** Built and tested on the Mac with stand-ins. **No real request
has ever been made**: no API key exists. The checks at the end of this page
are for the first real ones.

## In short

- **Off until you switch it on.** A key in the `.env` file does not switch
  anything on. The switch is on the main screen and asks for the password.
- **The local model stays the default.** On the laptop that is
  `gpt-oss:20b`. Claude is asked only when a fixed rule says so, and you
  can keep it to requests you ask for yourself (`ai.prefer: "local"`).
- **It is billed per request, on its own.** A Claude subscription (Pro or
  Max) does not include API use. The API needs its own key and its own
  credit, from the Anthropic Console.
- **A monthly limit in euros**, €20 unless you change it. When it is
  reached, nothing more is sent and the local model answers.
- **Sensitive records are not sent without a yes for that conversation.**
  Anything that looks like a password or a key is never sent.

## How it works

```
your question
     │
     ▼
 fixed rules pick the model ──► the local model (the usual case)
     │
     │ a hard question, or you asked for stronger reasoning
     ▼
 may this go to the cloud?   switched on · room in the budget ·
     │                       nothing secret · nothing sensitive
     │                       without your yes
     ▼
 the most it can cost is set aside
     │
     ▼
 Claude answers ──► words on screen and by voice
     │
     └─► or asks for a tool ──► the same gate as for every model:
                                checked, and confirmed by you
                                where a confirmation is needed
```

The rules that pick the model are in
[AI-VOICE-STACK.md](AI-VOICE-STACK.md#routing-which-model-answers). Two
Claude models are set up: a strong one for hard questions
(`claude-sonnet-5-5`) and a light one for background work and for when no
local model is running (`claude-haiku-5-5`). Both names are settings.

The code is `apps/core/src/ai/claude.ts` (the provider),
`apps/core/src/ai/policy.ts` (the rules and the budget) and the turn loop
in `apps/core/src/ai/helios.ts`. It uses Anthropic's official SDK,
`@anthropic-ai/sdk`.

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
5. Start the core. On the main screen, top right: "Cloud models off ·
   Turn on", and enter the password.

To stop using it, "Turn off" works at once and needs no password. Taking
the key out of `.env` has the same effect after a restart.

## Settings

In `config.json` in the data folder, under `ai`:

| Setting | Default | Meaning |
|---|---|---|
| `cloud.allowed` | `false` | The switch. The screen's "Turn on" sets it |
| `prefer` | `"auto"` | `"auto"`: hard questions go to Claude. `"local"`: only when you ask for stronger reasoning. `"cloud"`: Claude first |
| `cloud.strongModel` | `claude-sonnet-5-5` | For hard questions |
| `cloud.lightModel` | `claude-haiku-5-5` | For background work, and when no local model runs |
| `cloud.effort.strong`, `.light` | `medium`, `low` | How hard each model thinks. Lower is faster and cheaper |
| `cloud.maxOutputTokens.strong`, `.light` | 8,000, 2,000 | The longest one answer may be. Also the most one answer can cost |
| `cloud.budget.capEur`, `.warnEur` | 20, 15 | The monthly limit and the warning before it |
| `cloud.budget.usdToEur`, `.taxAllowance` | 1, 0.21 | How dollars are counted as euros: on the safe side |
| `cloud.pricePerMTok` | see below | The prices the budget counts with. Update them when Anthropic's change |
| `cloud.baseUrl` | empty | Another address than Anthropic's own. Leave empty |

An older settings file can hold `"enabled": true` under `cloud`. Earlier
versions wrote that by themselves. It is no longer read, so it switches
nothing on.

## What leaves this machine

When a request goes to Claude, this is sent to Anthropic, over an
encrypted connection, and nothing else:

- HELIOS's fixed instructions and the list of its tools.
- The part of the conversation a model is shown: at most the 40 messages
  up to your latest one. That includes what tools returned in it, such as
  your tasks or calendar entries, and text HELIOS read from the web.

What decides whether it is sent:

| What the conversation holds | What happens |
|---|---|
| Ordinary and private things (your questions, tasks, calendar) | Sent, when cloud models are on and a rule picks Claude |
| Sensitive things (money figures, anything marked sensitive) | Not sent. The local model answers. If you asked for stronger reasoning, you are asked first and shown what would go; a yes covers that conversation for 30 minutes |
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

**What a question is likely to cost.** Worked out from those prices and
from the size of HELIOS's own requests, which was measured on the Mac. It
is not a measured bill: no request has been made.

- HELIOS's instructions and tools are about 6,300 bytes, sent with every
  request. A first question adds a few hundred bytes. That is about 1,700
  tokens, or 2,250 the cautious way the budget counts.
- An answer is Claude's thinking plus its words. 400 tokens is a fair
  guess for a spoken answer.

| | One answer | A question that uses one tool (two requests) | Set aside before each request |
|---|---|---|---|
| Sonnet 5.5 | about €0.01 | about €0.02 | €0.10 |
| Haiku 5.5 | about €0.0005 | about €0.001 | €0.002 |

In euros as the budget counts them: one dollar as one euro, plus 21 per
cent. A long conversation costs more per question, because the earlier
messages are sent again each time. Ten Sonnet questions a day would be
about €3 to €6 a month.

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

## When it fails

HELIOS says what went wrong, in its own words, and the local model
answers instead when there is one.

| What happened | What you are told |
|---|---|
| The key was not accepted | "Anthropic did not accept the API key. Check ANTHROPIC_API_KEY in the .env file." |
| No credit, or a billing problem | "Anthropic reports a billing problem. The API account may have no credit left; a Claude subscription does not include any." |
| The key may not use that model, or the model name is wrong | Named as such, with the model |
| Too many requests, or the account's own limit | "Anthropic is limiting requests from this account right now..." |
| The service is overloaded | Tried once more automatically, then "Anthropic's service is overloaded or having trouble right now." |
| No internet | "Anthropic could not be reached. Check the internet connection." |
| Claude declined the question | "The model declined to answer that." For the strong model Anthropic may answer with another Claude model instead |
| The answer hit its length limit | The part that arrived, and "That answer was cut off at its length limit." |

A failed request is not repeated by HELIOS. The one exception costs
nothing: when Anthropic turns a request down over the reasoning that is
sent back with it, the same question is asked once more without that
reasoning.

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
  request cannot run a second time, not even after a crash in the middle.

## Limits

- **Never run against the real API.** Everything here was tested with
  stand-ins: a stand-in for the SDK's client, and the real SDK talking to
  a stand-in service on the Mac. Whether Anthropic accepts each field of
  the request is only shown by a real call.
- The limit counts what HELIOS sends. It does not see other use of the
  same key.
- Prices are settings and go out of date. An unknown model is counted at
  the highest known price.
- When an answer breaks off in the middle, the words that were already
  shown or spoken stay shown or spoken, and the next model's answer
  follows them.
- The key is in a plain file.
- Background work (summaries, extraction) is routed to the light model by
  the rules, but nothing in HELIOS starts such work yet.

## Checks on the laptop

Run on the test instance (its own data folder, port 7127), with a key in
`.env`. A check is "Passed" only when it ran on the laptop and did what
the right column says. They cost a few cents in total.

| # | Do | Expect |
|---|---|---|
| C1 | `npm run homebase -- cloud status` without a key, then with one | "not usable: no API key is set", then "set". The key is not printed |
| C2 | `npm run homebase -- cloud check`, answer `yes` | The light model answers in one sentence. Tokens and cost are shown |
| C3 | `npm run homebase -- cloud check strong`, answer `yes` | The strong model answers. This shows that the fallback option is accepted |
| C4 | Start the core with the key in place and cloud models off. Ask: "Think hard: which of my tasks matters most?" | The local model answers. Under the answer: "the stronger model was not used: cloud models are switched off" |
| C5 | "Turn on" on the screen | The password is asked for. Then: "Cloud models on · Anthropic" |
| C6 | Ask C4's question again | Claude answers, the words appear as they are written, and the model's name is under the answer. "Cloud this month" shows a few cents |
| C7 | Ask: "Think hard about how the shop did this month." | A card asks before the money figures are sent. "No": nothing is sent |
| C8 | Put a wrong key in `.env`, restart, ask C4's question. Put the right key back | "Anthropic did not accept the API key..." and the local model answers |

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
