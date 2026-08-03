import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;

  if (!columns.some((column) => column.name === "archived_at")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN archived_at TEXT
    `;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_projects_archive_list
    ON projection_projects(deleted_at, archived_at DESC, project_id)
  `;
});
