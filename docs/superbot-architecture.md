# Superbot Architecture

## Decision

For `v1`, the best operating model is:

- one Telegram bot;
- one shared company context;
- one orchestrator as the default interface;
- direct access to specialists inside the same chat;
- internal delegation in the runtime, not via separate Telegram chats.

This is better than `supergroup + topics` for now because it gives faster UX, lower complexity, and less coordination overhead.

## Recommended Shape

### Core

- `Superbot Orchestrator`
  - default interface
  - understands the company context
  - decides when to answer directly and when to hand work to a specialist

### Specialists

- `Marketing`
  - positioning
  - GTM
  - offers
  - funnel
  - sales direction
- `Planner`
  - architecture
  - decomposition
  - strategy
  - roadmap
- `Coder`
  - implementation
  - debugging
  - file changes
- `Reviewer`
  - risks
  - regressions
  - testing gaps
- `Video`
  - transcript
  - keyframes
  - direct response to short user videos

## Memory Model

The runtime should use four layers:

- `agent identity`
  - fixed cards
  - who the agent is
  - what the agent does
  - what the agent should not do
- `company memory`
  - shared across the office
  - goals, constraints, style, project context
- `chat memory`
  - local working memory of the current Telegram chat
- `thread memory`
  - persistent Codex thread for the general assistant flow

Identity should come from config. Memory should store evolving facts.

## UX

### Default

Write normally and talk to the orchestrator.

### Direct specialist access

- `@marketing ...`
- `@planner ...`
- `@coder ...`
- `@reviewer ...`
- `/agent marketing`
- `/agent orchestrator`
- `/delegate coder <task>`

## Why not a web app first

A web app is useful, but not as the first interaction layer.

Telegram is better for `v1` because:

- the user already lives there;
- lower friction;
- instant mobile access;
- easier habit formation.

## Best `v2`

The best upgrade path is:

- keep Telegram as the main conversational surface;
- add a lightweight web control plane for:
  - office state
  - memory inspection
  - agent inbox
  - task queue
  - approvals
  - dashboards

That gives:

- fast daily communication in Telegram;
- better visibility and operations in the browser.

## Decision Matrix

### Option A: Telegram Superbot

Pros:

- fastest to ship
- simplest UX
- lowest operational complexity

Cons:

- all agents share one bot identity
- limited admin/control UI

### Option B: Supergroup with topics

Pros:

- separate visible spaces per role
- clearer human mental model

Cons:

- more setup friction
- more Telegram-specific edge cases
- noisier coordination

### Option C: Web app first

Pros:

- full control over UX
- best visibility for state and tasks

Cons:

- slower to bootstrap
- higher surface area
- less convenient for quick daily interaction

## Recommendation

Ship `Telegram Superbot v1`.

Then add `Web Control Plane v2`.
