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
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";

const layer = it.layer(
  OrchestrationProjectionPipelineLive.pipe(
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "channels-pipeline-" })),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

layer("channel SQL projections", (it) => {
  it.effect("projects agents, backing-thread surface, channels, and message links", () =>
    Effect.gen(function* () {
      const events = yield* OrchestrationEventStore;
      const pipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";
      const projectId = ProjectId.make("channel-pipeline-project");
      const agentId = AgentId.make("channel-pipeline-agent");
      const threadId = ThreadId.make("channel-pipeline-thread");
      const channelId = ChannelId.make("channel-pipeline-channel");
      const messageId = MessageId.make("channel-pipeline-message");
      const replyMessageId = MessageId.make("channel-pipeline-reply");
      const assistantMessageId = MessageId.make("channel-pipeline-assistant");
      const assistantFollowupId = MessageId.make("channel-pipeline-assistant-followup");

      yield* events.append({
        type: "project.created",
        eventId: EventId.make("channel-pipeline-project-event"),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: now,
        commandId: CommandId.make("channel-pipeline-project-command"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          projectId,
          title: "Channels",
          workspaceRoot: "/tmp/channel-pipeline",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* events.append({
        type: "agent.created",
        eventId: EventId.make("channel-pipeline-agent-event"),
        aggregateKind: "agent",
        aggregateId: agentId,
        occurredAt: now,
        commandId: CommandId.make("channel-pipeline-agent-command"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          agentId,
          name: "Builder",
          role: "Implementation",
          instructions: "Build it.",
          modelSelection: {
            instanceId: ProviderInstanceId.make("piAgent"),
            model: "default",
          },
          runtimeMode: "full-access",
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* events.append({
        type: "thread.created",
        eventId: EventId.make("channel-pipeline-thread-event"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("channel-pipeline-thread-command"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          threadId,
          projectId,
          title: "#implementation",
          modelSelection: {
            instanceId: ProviderInstanceId.make("piAgent"),
            model: "default",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          surface: "channel",
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* events.append({
        type: "channel.created",
        eventId: EventId.make("channel-pipeline-channel-event"),
        aggregateKind: "channel",
        aggregateId: channelId,
        occurredAt: now,
        commandId: CommandId.make("channel-pipeline-channel-command"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          channelId,
          projectId,
          agentId,
          name: "implementation",
          threadId,
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* events.append({
        type: "thread.message-sent",
        eventId: EventId.make("channel-pipeline-message-event"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("channel-pipeline-message-command"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          threadId,
          messageId,
          role: "user",
          text: "Start work",
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
          channel: { channelId, parentMessageId: null, rootMessageId: messageId },
        },
      });
      yield* events.append({
        type: "thread.message-sent",
        eventId: EventId.make("channel-pipeline-reply-event"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("channel-pipeline-reply-command"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          threadId,
          messageId: replyMessageId,
          role: "user",
          text: "Steer the work",
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
          channel: { channelId, parentMessageId: messageId, rootMessageId: messageId },
        },
      });
      for (const [index, nextMessageId] of [assistantMessageId, assistantFollowupId].entries()) {
        yield* events.append({
          type: "thread.message-sent",
          eventId: EventId.make(`channel-pipeline-assistant-event-${index}`),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: now,
          commandId: CommandId.make(`channel-pipeline-assistant-command-${index}`),
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: {
            threadId,
            messageId: nextMessageId,
            role: "assistant",
            text: index === 0 ? "Working on the steer." : "The steer is complete.",
            turnId: TurnId.make("channel-pipeline-turn"),
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        });
      }

      yield* pipeline.bootstrap;

      const threadRows = yield* sql<{ readonly surface: string }>`
        SELECT surface FROM projection_threads WHERE thread_id = ${threadId}
      `;
      assert.deepStrictEqual(threadRows, [{ surface: "channel" }]);
      const channelRows = yield* sql<{ readonly threadId: string }>`
        SELECT technical_thread_id AS "threadId"
        FROM projection_channels
        WHERE channel_id = ${channelId}
      `;
      assert.deepStrictEqual(channelRows, [{ threadId }]);
      const messageRows = yield* sql<{
        readonly parentMessageId: string | null;
        readonly rootMessageId: string;
      }>`
        SELECT
          parent_message_id AS "parentMessageId",
          root_message_id AS "rootMessageId"
        FROM projection_channel_messages
        WHERE channel_id = ${channelId}
        ORDER BY sequence, message_id
      `;
      assert.deepStrictEqual(messageRows, [
        { parentMessageId: null, rootMessageId: messageId },
        { parentMessageId: messageId, rootMessageId: messageId },
        { parentMessageId: replyMessageId, rootMessageId: messageId },
        { parentMessageId: replyMessageId, rootMessageId: messageId },
      ]);
    }),
  );
});
