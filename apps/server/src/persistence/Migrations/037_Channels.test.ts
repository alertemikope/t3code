import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("037_Channels", (it) => {
  it.effect("adds durable Channels tables and keeps historical threads ordinary", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 36 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, branch, worktree_path, latest_turn_id, created_at,
          updated_at, archived_at, settled_override, settled_at, snoozed_until,
          snoozed_at, latest_user_message_at, pending_approval_count,
          pending_user_input_count, has_actionable_proposed_plan, deleted_at
        ) VALUES (
          'historical-thread', 'project', 'Historical',
          '{"instanceId":"piAgent","model":"default"}', 'full-access',
          'default', NULL, NULL, NULL, '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z', NULL, NULL, NULL, NULL, NULL, NULL,
          0, 0, 0, NULL
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 37 });

      const rows = yield* sql<{ readonly surface: string }>`
        SELECT surface FROM projection_threads WHERE thread_id = 'historical-thread'
      `;
      assert.deepStrictEqual(rows, [{ surface: "thread" }]);

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table'
      `;
      const names = new Set(tables.map((table) => table.name));
      assert.ok(names.has("projection_agents"));
      assert.ok(names.has("projection_channels"));
      assert.ok(names.has("projection_channel_messages"));
    }),
  );
});
