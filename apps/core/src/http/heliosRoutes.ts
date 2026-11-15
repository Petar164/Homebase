import type { Approval, ConversationMessage, ConversationSummary, CoreEvent, HeliosStatus, TurnResult } from "@homebase/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Helios } from "../ai/helios.ts";
import { AppError } from "../errors.ts";
import type { EventBus } from "../events.ts";

const idParams = z.object({ id: z.string().regex(/^[\w-]{1,64}$/) });
const messageSchema = z.object({
  text: z.string().trim().min(1, "Say something first.").max(4000),
  conversationId: z.string().regex(/^[\w-]{1,64}$/).optional(),
});
const decisionSchema = z.object({ decision: z.enum(["approve", "deny"]) });

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError(400, result.error.issues[0]?.message ?? "That input is not valid.");
  return result.data;
}

export function registerHeliosRoutes(app: FastifyInstance, helios: Helios, bus: EventBus): void {
  app.get("/api/helios/status", async (): Promise<HeliosStatus> => helios.status());

  // The event stream: one long-lived response over which the core pushes
  // state changes, new messages and approval requests to the screen
  // (Server-Sent Events). It passes the same host and session checks as
  // every other route before it gets here.
  app.get("/api/stream", (request, reply) => {
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      ...(reply.getHeaders() as Record<string, string>),
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    const send = (event: CoreEvent) => response.write(`data: ${JSON.stringify(event)}\n\n`);
    send({ type: "state", state: helios.currentState });
    const unsubscribe = bus.subscribe(send);
    // A comment line now and then keeps idle connections from being dropped.
    const heartbeat = setInterval(() => response.write(": still here\n\n"), 25_000);
    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.get("/api/conversations", async (): Promise<ConversationSummary[]> => helios.listConversations());

  app.get("/api/conversations/:id/messages", async (request): Promise<ConversationMessage[]> => helios.messages(parse(idParams, request.params).id));

  app.post("/api/helios/message", async (request): Promise<TurnResult> => {
    const input = parse(messageSchema, request.body);
    return helios.handleMessage(input.text, { conversationId: input.conversationId, channel: "text" });
  });

  app.get("/api/approvals", async (): Promise<Approval[]> => helios.pendingApprovals());

  app.post("/api/approvals/:id/decide", async (request) => {
    const { id } = parse(idParams, request.params);
    const { decision } = parse(decisionSchema, request.body);
    return helios.decide(id, decision, request.session);
  });
}
