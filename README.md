# cf_ai_agentic_travel_helper

Cloudflare Agentic AI project

# Agentic Travel Planner (Cloudflare)

## 1) About / Architecture / How it meets Cloudflare’s requirements

**What it is**  
A travel-planning agent that chats with users, remembers preferences across the session, calls tools, and runs a small workflow to post a **one-time alternative itinerary ~15s** after the primary plan. It’s built **entirely on Cloudflare**.

**Architecture**

- **Frontend (Vite SPA):** Branded chat UI with quick chips, dark/light mode.
- **Agent (Durable Object via Agents SDK):**
  - Extends `AIChatAgent` (`Chat` DO) for **stateful** sessions.
  - **Memory:** Persists `profile.preferences` (dynamic JSON) + `notes`, plus workflow markers (`lastItinerary`, `itineraryCounter`, `altOfferedFor`).
  - **Tools:** `upsertPreferences` (LLM writes memory), demo scheduling tools, simple local-time tool.
  - **Workflow:** After sending a primary itinerary, the agent schedules a **single** “alt itinerary” job (~15s). Guardrails prevent duplicates per itinerary; new itineraries get their own one-time alt.
- **Workers AI:** LLM calls through `workers-ai-provider` using `@cf/meta/llama-3-8b-instruct`.
- **Routing/Streaming:** `routeAgentRequest` (Agents SDK) + streaming responses; small `/check-open-ai-key` stub for UI health in dev.

**Meets Cloudflare’s checklist**

1. **Get user input (Chat/WebSockets/Pages):** Real-time chat UI connected to the Agent.
2. **Ask AI (Workers AI):** Model hosted on Cloudflare; no external provider required.
3. **Guarantee execution (Durable Objects + Workflows):**
   - **State**: DO stores memory & workflow flags.
   - **Workflow**: `this.schedule(...)` triggers the alt-itinerary task; idempotent per itinerary.
4. **Take action (Tools):**
   - **Memory tool**: `upsertPreferences` persists preference deltas from natural language.
   - **Scheduling tools**: list/cancel tasks (demo).
   - Extensible to MCP, D1, Vectorize, etc.

---

## 2) Setup & Run Locally

> Requires Node 18+ and a Cloudflare account (Wrangler runs from dev dependencies).

```bash
# 1) Install dependencies
npm install
npm install workers-ai-provider

# 2) Start the frontend (Terminal A)
npm start

# 3) Start the Worker & Durable Objects (Terminal B)
npx wrangler dev

## 3) Using It (Features & Example Prompts)

### Features
- **Concise itineraries:** Day-by-day plans with timing hints, neighborhoods, and a simple budget band.
- **Memory (Durable Objects):** The LLM extracts durable preferences and calls `upsertPreferences`. These are summarized back into the system context on later turns.
- **One-time alternative plan (~15s later):** After a primary itinerary, the agent posts a **single** alternative for that itinerary. If you request another itinerary later, it will schedule one more (still one-per-itinerary).
- **Tooling & scheduling:** Demo scheduling tools + a simple local-time tool. Easy to extend (weather, bookings, MCP, etc.).

### Great prompts to try
- **Teach preferences:**

- **I avoid cafés, prefer walking, budget $150/day, I’m from Toronto.**

**Then ask:**

- **What preferences do you have in memory now?**

**Generate an itinerary (watch for the alt a few seconds later):**

- **Create me a 3 day trip in Tokyo, mid budget, anime + night views and I like walking alot and any type of food is ok.**

```
