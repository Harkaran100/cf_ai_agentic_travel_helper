# PROMPTS.md

Prompts issued to AI (ChatGPT) while building **cf_ai_agentic_travel_helper**.  
These guided UI/branding, dynamic preference memory (Durable Objects), tools and scheduling/workflows.

---

## 1) UI / Branding

- “Tighten the chat UI and make it feel branded. Keep the structure; upgrade the background and card styling.”
- “Add branded quick chips above the textarea. Point me to the exact spot to render them.”
- “Intensify the radial/stripe background. Keep the palette; don’t change layout.”
- “Make the message card less transparent—not fully solid—touch only the card styles, nothing else.”

## 2) Model Output / Token/Step Controls

- “The itinerary is truncating. Analyze likely causes (tokens/steps/stream) and propose the minimal fix without changing the system prompt.”
- “Use `stepCountIs` (or equivalent) to increase reasoning depth; show where to apply it.”

## 3) Memory / Durable Objects

- “Design dynamic preference memory using a flexible schema (not a boolean per preference). Have the LLM infer a compact JSON delta and persist it.”
- “Explain how the model will decide when to call the tool, how the state is summarized back into the system context each turn, and how we avoid overwriting unrelated keys.”

## 4) Tools

- “Add an `upsertPreferences` tool. Input is a JSON delta + optional notes. Merge into stored state (deep merge), persist, and return a brief acknowledgment.”
- “Return a copy-pasteable implementation. Fix any SDK nuances (no-arg `getState`, typed `setState`).”

## 5) Server / Agent Wiring

- “Update `onChatMessage` to: (1) read memory from Durable Objects, (2) inject a concise MEMORY line into the system prompt, (3) expose our tools, (4) keep human-in-the-loop processing, and (5) stream responses. Provide a drop-in block.”

## 6) Workflow: One-Time Alternative Itinerary

- “Implement a workflow that, after emitting a primary itinerary, schedules a **single** alternative ~15 seconds later. Allow one alt per itinerary, but support multiple itineraries in the same conversation.”
- “Use a lightweight detection heuristic for itineraries and persist an `altOfferedFor` map to enforce ‘once per itinerary.’”
- “If alt generation fails, retry once with a short backoff.”

---
