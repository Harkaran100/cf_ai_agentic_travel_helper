import { routeAgentRequest, type Schedule } from "agents";
import { getSchedulePrompt } from "agents/schedule";
import { AIChatAgent } from "agents/ai-chat-agent";
import {
  generateId,
  streamText,
  type StreamTextOnFinishCallback,
  stepCountIs,
  createUIMessageStream,
  convertToModelMessages,
  createUIMessageStreamResponse,
  type ToolSet
} from "ai";
// ⬇️ use Workers AI instead of OpenAI
import { createWorkersAI } from "workers-ai-provider";

import { processToolCalls, cleanupMessages } from "./utils";
import { tools, executions } from "./tools";

// NOTE: Ensure your wrangler.jsonc has:
// "ai": { "binding": "AI" }
// and that your Env type includes: AI: Ai

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
    // Tip: `npx wrangler ai models`
    const model = workersai("@cf/meta/llama-3-8b-instruct");

    const allTools = {
      ...tools,
      ...this.mcp.getAITools()
    };

    // ---- Read memory from Durable Object state (if any) ----
    const state = (this.state as {
      profile?: { preferences?: Record<string, unknown>; notes?: string };
    }) || {};
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
      return `Apply saved user preferences when relevant. ${p ? `Prefs: ${p}.` : ""}${notes ? ` Notes: ${notes}` : ""}`;
    })();

    // ---- Build final system prompt (adds MEMORY line + hint to call upsertPreferences) ----
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
      "If the user reveals a durable preference (budget, dislikes, mobility, origin, interests, time constraints), call the `upsertPreferences` tool with a minimal structured delta and optional notes."
    ]
      .filter(Boolean)
      .join("\n");

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

        const result = streamText({
          system: systemPrompt,
          messages: convertToModelMessages(processedMessages),
          model,
          tools: allTools,
          onFinish: onFinish as unknown as StreamTextOnFinishCallback<typeof allTools>,
          stopWhen: stepCountIs(10)
        });

        writer.merge(result.toUIMessageStream());
      }
    });

    return createUIMessageStreamResponse({ stream });
  }

  async executeTask(description: string, _task: Schedule<string>) {
    await this.saveMessages([
      ...this.messages,
      {
        id: generateId(),
        role: "user",
        parts: [{ type: "text", text: `Running scheduled task: ${description}` }],
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

    // 🔧 Stub for the starter UI's health check
    if (url.pathname === "/check-open-ai-key") {
      return Response.json({ success: true });
    }

    // Route the request to our agent or return 404 if not found
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
