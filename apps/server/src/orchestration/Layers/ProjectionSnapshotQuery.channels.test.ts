import * as NodeServices from "@effect/platform-node/NodeServices";
import { ChannelId, MessageId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const layer = it.layer(
  OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

layer("channel projection snapshots", (it) => {
  it.effect("keeps backing threads out of the shell and returns linked channel messages", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const query = yield* ProjectionSnapshotQuery;

      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json, scripts_json,
          created_at, updated_at, deleted_at
        ) VALUES (
          'channel-project', 'Channel project', '/tmp/channel-project', NULL, '[]',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
          branch, worktree_path, surface, created_at, updated_at, deleted_at
        ) VALUES
          (
            'visible-thread', 'channel-project', 'Visible',
            '{"instanceId":"piAgent","model":"default"}', 'full-access', 'default',
            NULL, NULL, 'thread', '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:00:00.000Z', NULL
          ),
          (
            'channel-thread', 'channel-project', 'Hidden backing thread',
            '{"instanceId":"piAgent","model":"default"}', 'full-access', 'default',
            NULL, NULL, 'channel', '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:00:00.000Z', NULL
          )
      `;
      yield* sql`
        INSERT INTO projection_agents (
          agent_id, name, role, instructions, model_selection_json, runtime_mode,
          created_at, updated_at, deleted_at
        ) VALUES (
          'channel-agent', 'Builder', 'Implementation', 'Make verified changes.',
          '{"instanceId":"piAgent","model":"default"}', 'full-access',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_channels (
          channel_id, project_id, agent_id, name, technical_thread_id,
          created_at, updated_at, deleted_at
        ) VALUES (
          'implementation', 'channel-project', 'channel-agent', 'implementation',
          'channel-thread', '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
        ) VALUES (
          'channel-message', 'channel-thread', NULL, 'user', 'Build the feature', 0,
          '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:01.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_channel_messages (
          message_id, channel_id, technical_message_id, role, parent_message_id,
          root_message_id, sequence, created_at
        ) VALUES (
          'channel-message', 'implementation', 'channel-message', 'user', NULL,
          'channel-message', 1, '2026-01-01T00:00:01.000Z'
        )
      `;

      const shell = yield* query.getShellSnapshot();
      assert.deepStrictEqual(
        shell.threads.map((thread) => thread.id),
        ["visible-thread"],
      );
      const backingThreadShell = yield* query.getThreadShellById(ThreadId.make("channel-thread"));
      assert.equal(backingThreadShell._tag, "None");

      const getChannelsSnapshot = query.getChannelsSnapshot;
      assert.ok(getChannelsSnapshot);
      const channelList = yield* getChannelsSnapshot();
      assert.equal(channelList.channels.length, 1);
      assert.equal(channelList.messages.length, 0);
      const channels = yield* getChannelsSnapshot(ChannelId.make("implementation"));
      assert.equal(channels.agents[0]?.name, "Builder");
      assert.equal(channels.channels[0]?.threadId, "channel-thread");
      assert.deepStrictEqual(channels.messages[0], {
        id: MessageId.make("channel-message"),
        channelId: ChannelId.make("implementation"),
        threadMessageId: MessageId.make("channel-message"),
        role: "user",
        text: "Build the feature",
        parentMessageId: null,
        rootMessageId: MessageId.make("channel-message"),
        sequence: 1,
        createdAt: "2026-01-01T00:00:01.000Z",
      });

      yield* sql`
        UPDATE projection_projects
        SET archived_at = '2026-01-01T00:00:02.000Z'
        WHERE project_id = 'channel-project'
      `;
      const archivedProjectChannels = yield* getChannelsSnapshot(ChannelId.make("implementation"));
      assert.equal(archivedProjectChannels.channels.length, 0);
      assert.equal(archivedProjectChannels.messages.length, 0);
    }),
  );
});
