import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AgentId,
  ChannelId,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("channels-project");
const agentId = AgentId.make("channels-agent");
const channelId = ChannelId.make("channels-channel");
const threadId = ThreadId.make("channels-backing-thread");

function applyPlanned(
  readModel: OrchestrationReadModel,
  planned:
    | Omit<OrchestrationEvent, "sequence">
    | ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
) {
  return Effect.gen(function* () {
    let model = readModel;
    for (const event of Array.isArray(planned) ? planned : [planned]) {
      model = yield* projectEvent(model, {
        ...event,
        sequence: model.snapshotSequence + 1,
      });
    }
    return model;
  });
}

const seedProject = projectEvent(createEmptyReadModel(now), {
  sequence: 1,
  eventId: EventId.make("channels-project-created"),
  aggregateKind: "project",
  aggregateId: projectId,
  type: "project.created",
  occurredAt: now,
  commandId: CommandId.make("channels-project-create"),
  causationEventId: null,
  correlationId: CommandId.make("channels-project-create"),
  metadata: {},
  payload: {
    projectId,
    title: "Channels",
    workspaceRoot: "/tmp/channels",
    defaultModelSelection: null,
    scripts: [],
    createdAt: now,
    updatedAt: now,
  },
});

it.layer(NodeServices.layer)("channel decider", (it) => {
  it.effect("creates a hidden backing thread and preserves parent/root message links", () =>
    Effect.gen(function* () {
      let readModel = yield* seedProject;
      const agentCreated = yield* decideOrchestrationCommand({
        readModel,
        command: {
          type: "agent.create",
          commandId: CommandId.make("agent-create"),
          agentId,
          name: "Builder",
          role: "Implementation agent",
          instructions: "Prefer small verified changes.",
          modelSelection: { instanceId: ProviderInstanceId.make("piAgent"), model: "default" },
          runtimeMode: "full-access",
          createdAt: now,
        },
      });
      readModel = yield* applyPlanned(readModel, agentCreated);

      const channelCreated = yield* decideOrchestrationCommand({
        readModel,
        command: {
          type: "channel.create",
          commandId: CommandId.make("channel-create"),
          channelId,
          projectId,
          threadId,
          agentId,
          name: "implementation",
          createdAt: now,
        },
      });
      expect(Array.isArray(channelCreated)).toBe(true);
      const channelEvents = Array.isArray(channelCreated) ? channelCreated : [channelCreated];
      expect(channelEvents.map((event) => event.type)).toEqual([
        "thread.created",
        "channel.created",
      ]);
      expect(channelEvents[0]?.type === "thread.created" && channelEvents[0].payload.surface).toBe(
        "channel",
      );
      readModel = yield* applyPlanned(readModel, channelEvents);

      const rootMessageId = MessageId.make("channel-message-root");
      const firstMessage = yield* decideOrchestrationCommand({
        readModel,
        command: {
          type: "channel.message.send",
          commandId: CommandId.make("channel-message-root-command"),
          channelId,
          message: { messageId: rootMessageId, role: "user", text: "Start", attachments: [] },
          createdAt: now,
        },
      });
      const firstMessageEvents = Array.isArray(firstMessage) ? firstMessage : [firstMessage];
      expect(firstMessageEvents.map((event) => event.type)).toEqual([
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);
      expect(
        firstMessageEvents[1]?.type === "thread.turn-start-requested"
          ? firstMessageEvents[1].payload
          : null,
      ).toMatchObject({
        modelSelection: { instanceId: "piAgent", model: "default" },
        runtimeMode: "full-access",
        instructions: "Role: Implementation agent\n\nPrefer small verified changes.",
      });
      readModel = yield* applyPlanned(readModel, firstMessage);
      expect(readModel.channelMessages?.[0]).toMatchObject({
        id: rootMessageId,
        parentMessageId: null,
        rootMessageId,
      });

      const replyMessageId = MessageId.make("channel-message-reply");
      const reply = yield* decideOrchestrationCommand({
        readModel,
        command: {
          type: "channel.message.send",
          commandId: CommandId.make("channel-message-reply-command"),
          channelId,
          message: {
            messageId: replyMessageId,
            role: "user",
            text: "Steer",
            attachments: [],
            parentMessageId: rootMessageId,
          },
          createdAt: now,
        },
      });
      const replyEvents = Array.isArray(reply) ? reply : [reply];
      expect(
        replyEvents[1]?.type === "thread.turn-start-requested"
          ? replyEvents[1].payload.instructions
          : null,
      ).toContain("Reply context:\nStart");
      readModel = yield* applyPlanned(readModel, reply);
      expect(readModel.channelMessages?.[1]).toMatchObject({
        id: replyMessageId,
        parentMessageId: rootMessageId,
        rootMessageId,
      });

      const assistantMessageId = MessageId.make("channel-message-assistant");
      readModel = yield* projectEvent(readModel, {
        sequence: readModel.snapshotSequence + 1,
        eventId: EventId.make("channel-message-assistant-event"),
        aggregateKind: "thread",
        aggregateId: threadId,
        type: "thread.message-sent",
        occurredAt: now,
        commandId: CommandId.make("channel-message-assistant-command"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          threadId,
          messageId: assistantMessageId,
          role: "assistant",
          text: "Working on the steer.",
          turnId: TurnId.make("channel-turn"),
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });
      expect(readModel.channelMessages?.[2]).toMatchObject({
        id: assistantMessageId,
        parentMessageId: replyMessageId,
        rootMessageId,
      });

      const renamed = yield* decideOrchestrationCommand({
        readModel,
        command: {
          type: "channel.update",
          commandId: CommandId.make("channel-rename-command"),
          channelId,
          name: "delivery",
        },
      });
      readModel = yield* applyPlanned(readModel, renamed);
      expect(readModel.channels?.[0]?.name).toBe("delivery");

      const deleted = yield* decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.delete",
          commandId: CommandId.make("channel-backing-thread-delete-command"),
          threadId,
        },
      });
      const deletedEvents = Array.isArray(deleted) ? deleted : [deleted];
      expect(deletedEvents.map((event) => event.type)).toEqual([
        "thread.deleted",
        "channel.deleted",
      ]);
      readModel = yield* applyPlanned(readModel, deletedEvents);
      expect(readModel.channels?.[0]?.deletedAt).not.toBeNull();
      expect(readModel.threads[0]?.deletedAt).toBe(readModel.channels?.[0]?.deletedAt);

      const agentDeleted = yield* decideOrchestrationCommand({
        readModel,
        command: {
          type: "agent.delete",
          commandId: CommandId.make("agent-delete-command"),
          agentId,
        },
      });
      readModel = yield* applyPlanned(readModel, agentDeleted);
      expect(readModel.agents?.[0]?.deletedAt).not.toBeNull();
    }),
  );

  it.effect("deletes channels and their backing threads when a project is removed", () =>
    Effect.gen(function* () {
      let readModel = yield* seedProject;
      const agentCreated = yield* decideOrchestrationCommand({
        readModel,
        command: {
          type: "agent.create",
          commandId: CommandId.make("cascade-agent-create"),
          agentId,
          name: "Builder",
          role: "Implementation agent",
          instructions: "Prefer small verified changes.",
          modelSelection: { instanceId: ProviderInstanceId.make("piAgent"), model: "default" },
          runtimeMode: "full-access",
          createdAt: now,
        },
      });
      readModel = yield* applyPlanned(readModel, agentCreated);

      const channelCreated = yield* decideOrchestrationCommand({
        readModel,
        command: {
          type: "channel.create",
          commandId: CommandId.make("cascade-channel-create"),
          channelId,
          projectId,
          threadId,
          agentId,
          name: "implementation",
          createdAt: now,
        },
      });
      readModel = yield* applyPlanned(readModel, channelCreated);

      const projectDeleted = yield* decideOrchestrationCommand({
        readModel,
        command: {
          type: "project.delete",
          commandId: CommandId.make("cascade-project-delete"),
          projectId,
          force: true,
        },
      });
      const events = Array.isArray(projectDeleted) ? projectDeleted : [projectDeleted];
      expect(events.map((event) => event.type)).toEqual([
        "thread.deleted",
        "channel.deleted",
        "project.deleted",
      ]);

      readModel = yield* applyPlanned(readModel, events);
      expect(readModel.channels?.[0]?.deletedAt).not.toBeNull();
      expect(readModel.threads[0]?.deletedAt).not.toBeNull();
      expect(readModel.projects[0]?.deletedAt).not.toBeNull();
    }),
  );
});
