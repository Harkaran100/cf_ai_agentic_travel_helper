import { routeAgentRequest, type Schedule } from "agents";
import { getSchedulePrompt } from "agents/schedule";
import { AIChatAgent } from "agents/ai-chat-agent";
import {
  generateId,
  streamText,
  generateText, 
  type StreamTextOnFinishCallback,
  stepCountIs,
  createUIMessageStream,
  convertToModelMessages,
  createUIMessageStreamResponse,
  type ToolSet
} from "ai";
// ⬇️ Workers AI provider
import { createWorkersAI } from "workers-ai-provider";

import { processToolCalls, cleanupMessages } from "./utils";
import { tools, executions } from "./tools";

/**
 * Shape we persist in Durable Object state.
 */
type AgentState = {
  profile?: { preferences?: Record<string, unknown>; notes?: string };
  itineraryCounter?: number; // kept for possible future use
  altOfferedFor?: Record<string, boolean>; // itineraryId -> offered
  lastItinerary?: { id: string; text: string; createdAt: string };
};

/**
 * Chat Agent implementation that handles real-time AI chat interactions
 */
export class Chat extends AIChatAgent<Env> {
  /**
   * Handles incoming chat messages and manages the response stream
   */
  async onChatMessage(
    onFinish: StreamTextOnFinishCallback<ToolSet>,
    _options?: { abortSignal?: AbortSignal }
  ) {
    // Set up Workers AI provider using the bound AI service
    const workersai = createWorkersAI({ binding: this.env.AI });
    const model = workersai("@cf/meta/llama-3-8b-instruct");

    const allTools = {
      ...tools,
      ...this.mcp.getAITools()
    };

    // ---- Read memory from Durable Object state (if any) ----
    const state = (this.state as AgentState) || {};
    const profile = state.profile || {};
    const prefs = (profile.preferences || {}) as Record<string, unknown>;
    const notes = profile.notes;

    const summarizePrefs = (obj: Record<string, unknown>) => {
      const entries = Object.entries(obj);
      if (!entries.length) return "";
      const parts = entries.map(([k, v]) => {
        if (Array.isArray(v)) return `${k}=${(v as unknown[]).join(", ")}`;
        if (typeof v === "object" && v) return `${k}=[…]`;
        return `${k}=${String(v)}`;
      });
      return parts.slice(0, 8).join("; ");
    };

    const memoryLine = (() => {
      const p = summarizePrefs(prefs);
      if (!p && !notes) return "";
      return `Apply saved user preferences when relevant. ${
        p ? `Prefs: ${p}.` : ""
      }${notes ? ` Notes: ${notes}` : ""}`;
    })();

    // ---- Build final system prompt ----
    const systemPrompt = [
      "You are TravelPlanner, a concise, friendly agent that builds lightweight travel itineraries.",
      "Goals:",
      "- Ask brief clarifying questions only when needed (dates, budget/day, interests, origin city).",
      "- Produce a day-by-day plan (activities, neighborhoods, rough timing, transit mode hints).",
      "- Include a simple budget band per day (cheap / mid / premium) and flag constraints if unrealistic.",
      "- Prefer walking/public transit where reasonable; avoid red-eye flights unless user opts in.",
      "- Keep answers grounded and clearly “suggested” (no guarantees). Encourage users to verify details.",
      "- Use tools if available (e.g., schedule tool) but never over-ask for confirmation.",
      "",
      memoryLine ? `MEMORY: ${memoryLine}` : "",
      "",
      getSchedulePrompt({ date: new Date() }),
      "",
      "If the user asks to schedule a task, use the schedule tool to schedule the task.",
      "If the user reveals a durable preference (budget, dislikes, mobility, origin, interests, time constraints), call the `upsertPreferences` tool with a minimal structured delta and optional notes.",
      "",
      // Nudge: one-time alternative per itinerary (but allow multiple itineraries in the same conversation)
      "After you produce a primary itinerary, the system may schedule a one-time alternative plan for that itinerary. Do not attempt to repeatedly schedule alternatives yourself."
    ]
      .filter(Boolean)
      .join("\n");

    // ---- Helpers to detect and key an itinerary request from the *user* text ----
    const lastUserText = (() => {
      const last = [...this.messages].reverse().find((m) => m.role === "user");
      const part = last?.parts?.find((p) => p.type === "text") as
        | { type: "text"; text: string }
        | undefined;
      return (part?.text || "").trim();
    })();

    const looksLikeItineraryRequest = (t: string) => {
      const lower = t.toLowerCase();
      return (
        /\b(\d+)\s*day(s)?\b/.test(lower) || // "3 days", "7 day"
        /\bweek(end)?\b/.test(lower) || // "weekend"
        /\bitinerary\b/.test(lower) || // "itinerary"
        /\btrip\b/.test(lower) // "trip"
      );
    };

    const itineraryIdFrom = (t: string) => {
      let h = 0;
      for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
      return `itn-${h.toString(16)}`;
    };

    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        const cleanedMessages = cleanupMessages(this.messages);

        // Handle any pending tool calls (human-in-the-loop)
        const processedMessages = await processToolCalls({
          messages: cleanedMessages,
          dataStream: writer,
          tools: allTools,
          executions
        });

        // Wrap onFinish so we can schedule the alternative off the *user* request
        const wrappedOnFinish: StreamTextOnFinishCallback<
          typeof allTools
        > = async (final) => {
          // First let the framework persist the message, etc.
          await (onFinish as unknown as StreamTextOnFinishCallback<
            typeof allTools
          >)(final);

          try {
            if (!lastUserText || !looksLikeItineraryRequest(lastUserText)) return;

            const s = (this.state as AgentState) || {};
            const itineraryId = itineraryIdFrom(lastUserText);

            // Guard: only once per itineraryId
            const already = s.altOfferedFor?.[itineraryId];
            if (already) return;

            // Save the latest itinerary text (optional but nice to have)
            const updated: AgentState = {
              ...s,
              lastItinerary: {
                id: itineraryId,
                text: final?.text ?? "",
                createdAt: new Date().toISOString()
              },
              altOfferedFor: { ...(s.altOfferedFor ?? {}), [itineraryId]: false }
            };
            await this.setState(updated);

            // Schedule a one-time alt in ~15s
            await this.schedule(
              15,
              "executeTask",
              JSON.stringify({ kind: "altItinerary", itineraryId })
            );
          } catch (err) {
            console.error("Scheduling altItinerary failed:", err);
          }
        };

        const result = streamText({
          system: systemPrompt,
          messages: convertToModelMessages(processedMessages),
          model,
          tools: allTools,
          onFinish: wrappedOnFinish,
          // bump if you need more thinking steps; 10–15 is fine for chat
          stopWhen: stepCountIs(15)
        });

        writer.merge(result.toUIMessageStream());
      }
    });

    return createUIMessageStreamResponse({ stream });
  }

  /**
   * Handles scheduled tasks. We pass JSON string payloads via this.schedule(...).
   */
  async executeTask(description: string, _task: Schedule<string>) {
    // Try to parse payload (we pass JSON strings); fallback to simple string mode
    let payload: { kind?: string; itineraryId?: string; retry?: number } = {};
    try {
      payload = JSON.parse(description);
    } catch {
      // keep payload empty; description might be a plain label
    }

    if (payload.kind === "altItinerary" && payload.itineraryId) {
      const itineraryId = payload.itineraryId;

      // Guard: ensure we only post ONE alternative per itinerary
      const s = (this.state as AgentState) || {};
      const offeredMap = s.altOfferedFor ?? {};
      if (offeredMap[itineraryId]) {
        return; // already offered
      }

      const base = s.lastItinerary;
      if (!base || base.id !== itineraryId) {
        // Nothing to base on or mismatch; abort silently
        return;
      }

      // Read preferences to guide the variant
      const prefs = (s.profile?.preferences ?? {}) as Record<string, unknown>;
      const notes = s.profile?.notes;

      // Prepare a short refinement/variant prompt
      const workersai = createWorkersAI({ binding: this.env.AI });
      const model = workersai("@cf/meta/llama-3-8b-instruct");

      const altPrompt = [
        "You are TravelPlanner. Generate a MATERIAL alternative itinerary for the same city and duration as the base plan below.",
        "Constraints:",
        "- Keep the same overall budget band and user preferences.",
        "- Change at least half of the neighborhood clustering or daily sequence.",
        "- Introduce a different organizing principle (e.g., transit-first vs walk-first, sunset-viewpoints focus, or different neighborhoods).",
        "- Keep it concise but complete (Day 1..N).",
        "",
        prefs && Object.keys(prefs).length
          ? `User Preferences (apply consistently): ${JSON.stringify(prefs)}`
          : "User Preferences: none provided",
        notes ? `Notes: ${notes}` : "",
        "",
        "BASE ITINERARY:",
        base.text
      ]
        .filter(Boolean)
        .join("\n");

      try {
        // Generate alternative
        const { text: altText } = await generateText({
          system:
            "You are an efficient travel-planning writer. Output only the alternative itinerary in a clean Day 1..N format; no preamble.",
          prompt: altPrompt,
          model
        });

        const finalAlt = altText?.trim();
        if (!finalAlt) {
          throw new Error("Empty alternative text");
        }

        // Persist that we've offered the alt for this itinerary ID
        await this.setState({
          ...s,
          altOfferedFor: { ...offeredMap, [itineraryId]: true }
        });

        // Post the alternative into the chat
        await this.saveMessages([
          ...this.messages,
          {
            id: generateId(),
            role: "assistant",
            parts: [
              {
                type: "text",
                text: `**Alternative itinerary (${itineraryId})**\n\n${finalAlt}`
              }
            ],
            metadata: { createdAt: new Date() }
          }
        ]);
        return;
      } catch (err) {
        console.error("altItinerary generation failed:", err);
        // Optional: retry once with small backoff
        const retry = (payload.retry ?? 0) + 1;
        if (retry <= 1) {
          await this.schedule(
            10,
            "executeTask",
            JSON.stringify({ kind: "altItinerary", itineraryId, retry })
          );
        }
        return;
      }
    }

    // Default behavior (kept from starter)
    await this.saveMessages([
      ...this.messages,
      {
        id: generateId(),
        role: "user",
        parts: [
          { type: "text", text: `Running scheduled task: ${description}` }
        ],
        metadata: { createdAt: new Date() }
      }
    ]);
  }
}

/**
 * Worker entry point that routes incoming requests to the appropriate handler
 */
export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    const url = new URL(request.url);

    // health check for starter UI
    if (url.pathname === "/check-open-ai-key") {
      return Response.json({ success: true });
    }

    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
