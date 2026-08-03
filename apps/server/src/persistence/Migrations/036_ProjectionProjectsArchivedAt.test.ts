import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("036_ProjectionProjectsArchivedAt", (it) => {
  it.effect("adds nullable project archive state and its listing index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 35 });
      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'historical-project',
          'Historical project',
          '/tmp/historical-project',
          NULL,
          '[]',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          NULL
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 36 });

      const rows = yield* sql<{ readonly archivedAt: string | null }>`
        SELECT archived_at AS "archivedAt"
        FROM projection_projects
        WHERE project_id = 'historical-project'
      `;
      assert.deepStrictEqual(rows, [{ archivedAt: null }]);

      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_projects)
      `;
      assert.ok(indexes.some((index) => index.name === "idx_projection_projects_archive_list"));

      const indexColumns = yield* sql<{ readonly name: string }>`
        PRAGMA index_info('idx_projection_projects_archive_list')
      `;
      assert.deepStrictEqual(
        indexColumns.map((column) => column.name),
        ["deleted_at", "archived_at", "project_id"],
      );
    }),
  );
});
