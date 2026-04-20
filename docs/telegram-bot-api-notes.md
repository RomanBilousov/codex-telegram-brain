# Telegram Bot API Notes for `codex-telegram-brain`

Updated: 2026-03-06

## Why this file exists
This is a curated local reference for the parts of Telegram Bot API that matter for our architecture.
We do **not** mirror the whole Telegram documentation here because a full dump goes stale quickly.
Instead, this file keeps:
- official links
- the features we actually need
- architecture implications for our bot
- what to verify again when Telegram Bot API changes

## Official Sources
- Bot API main reference: https://core.telegram.org/bots/api
- Bot API changelog: https://core.telegram.org/bots/api-changelog
- Bots FAQ: https://core.telegram.org/bots/faq
- Business bots / connected business accounts reference lives in the Bot API reference and changelog.

## What matters for our architecture

### 1. Supergroups with forum topics are a good fit
Telegram supports forum topics in supergroups.
This is the cleanest UX for the "AI office" idea:
- one supergroup
- one topic per agent
- one topic for the orchestrator
- direct communication with a specialist inside that specialist's topic

Implication for us:
- `chat_id` identifies the supergroup
- `message_thread_id` identifies the topic inside that supergroup
- our runtime should map `chat_id + message_thread_id -> agent profile + memory namespace`

### 2. `message_thread_id` is the key routing primitive
The Bot API supports sending messages into specific topics using `message_thread_id`.
That means one bot can behave like many distinct agents if it knows which topic it is operating in.

Implication for us:
- do not model the system as "one bot = one personality"
- model it as "one bot process = many agent identities"
- each topic should load:
  - agent identity
  - agent memory
  - agent permissions
  - agent automation rules

### 3. Topic events exist and are useful
Telegram emits service events for topic lifecycle, including creation, close, reopen, and edit events.
This is important because forum topics are not just UI folders; they are stateful objects.

Implication for us:
- topic creation can bootstrap a new agent namespace
- topic rename can update the human-facing agent title
- topic close/reopen can pause or resume agent activity
- we should persist topic metadata locally

### 4. Bot privacy mode matters in groups
In group contexts, Telegram privacy mode changes what the bot can see.
If privacy mode stays restrictive, the bot may miss ordinary non-command messages in the group/topic flow.

Implication for us:
- for agent topics to feel natural, privacy mode likely needs to be disabled
- otherwise the UX degrades into only commands, replies, mentions, and special cases
- this must be checked in BotFather before relying on topic chats as a real office interface

### 5. Bot commands are not topic-scoped
Telegram command scopes are defined for chat/user/admin ranges, not per forum topic.
So we should not rely on topic-specific slash command menus as the primary identity mechanism.

Implication for us:
- topic identity must be resolved in our own backend from `message_thread_id`
- one shared command set is fine
- the bot itself decides which agent handles the message based on topic mapping

### 6. `video_note` is a first-class media type
Round video messages are not the same as standard `video`.
They come through as `video_note`.
This already mattered in our implementation.

Implication for us:
- future media agents must explicitly support `video`, `video_note`, `voice`, `audio`, `document`, and likely photos separately
- Telegram media handling should be modeled as a matrix, not one generic file handler

### 7. Business / customer-facing Telegram features matter for future sales
Telegram Bot API has expanded business-related features over time, including business messages and business connection flows.
Also, newer Telegram capabilities around direct-message topics are relevant for a customer-facing operating model.

Implication for us:
- today: use a supergroup with internal agent topics as the operating console
- later: add customer-facing sales/support/marketing agents using business messaging features where appropriate
- do not bake internal-office assumptions too deeply into the runtime; keep the control plane reusable

### 8. Track the changelog, not only the reference
Telegram often ships meaningful Bot API additions through the changelog before they become part of our everyday mental model.
Examples relevant to us include forum topics, business features, and newer direct-message capabilities.

Implication for us:
- when expanding the bot, review the changelog first
- use this note as a stable local summary, but refresh it against the changelog periodically

## Recommended architecture for our "AI company"

### Telegram as UX, not as the internal bus
Best model:
- Telegram supergroup + topics = user interface
- local runtime = orchestrator / routing / memory / permissions / automations
- internal task layer = how agents coordinate with one another

Why:
- if agents talk to each other only via Telegram messages, the system becomes fragile and noisy
- topic chats should be where the human sees work, not necessarily where every internal hop happens

### One topic = one agent persona
Recommended topic map:
- `00 Orchestrator`
- `10 Marketing`
- `20 Sales`
- `30 Product`
- `40 Engineering`
- `41 Review`
- `90 Ops / Memory`

Each topic should load:
- agent card
- long-term memory namespace
- current task list
- tool permissions
- automation schedule

### Identity must be explicit, not learned from chat
Every agent should have a fixed profile, for example:
- `id`
- `title`
- `mission`
- `scope`
- `non_goals`
- `tools`
- `workspace access`
- `escalation rules`
- `tone`
- `proactive duties`

Do not rely on long-term memory alone for this.
Identity should come from config; memory should store evolving facts.

### Memory should be layered
We should keep 4 layers:
- `company memory`
- `user memory`
- `agent identity`
- `working memory`

Practical mapping:
- company memory: shared across all agents
- user memory: shared but filtered by relevance
- agent identity: fixed per agent
- working memory: per topic / per task stream

### Proactive agents need automations
For a proactive marketer, direct chat is not enough.
We need recurring or event-driven behavior such as:
- daily check-in
- weekly GTM hypotheses
- funnel review reminders
- content backlog suggestions
- lead-quality or conversion alerts

This should be implemented as runtime automations that can post into the relevant topic.

## What this means for the next build phase

### Phase 1
- support Telegram supergroup topics explicitly
- persist topic mapping locally
- define agent cards in config
- keep orchestrator topic + specialist topics

### Phase 2
- shared company memory
- per-agent identity + per-topic working memory
- direct specialist communication without going through orchestrator every time

### Phase 3
- proactive agents via automations
- marketer first
- later sales / support / customer success patterns

## Current implementation implications for `codex-telegram-brain`
Right now the bot already has:
- local per-chat memory
- multi-agent routing
- direct media handling

What it does **not** yet have:
- topic-aware routing via `message_thread_id`
- per-agent identity config
- per-topic memory namespaces
- agent-to-agent task layer
- proactive scheduled messages per agent topic

## Suggested next implementation order
1. Add topic awareness and map each topic to an agent.
2. Add explicit agent cards.
3. Split memory into shared/company + per-agent + per-topic.
4. Make `Marketing` the first proactive specialist.
5. Only then add more specialists.

## Refresh policy
When we touch Telegram architecture again, review these official pages first:
- Bot API reference
- Bot API changelog
- Bots FAQ

If Telegram ships a meaningful forum/business update, revise this file instead of trying to mirror all docs.
