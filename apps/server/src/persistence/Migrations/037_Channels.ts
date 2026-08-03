import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!threadColumns.some((column) => column.name === "surface")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN surface TEXT NOT NULL DEFAULT 'thread'
    `;
  }

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_agents (
      agent_id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      instructions TEXT NOT NULL,
      model_selection_json TEXT NOT NULL,
      runtime_mode TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_channels (
      channel_id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      name TEXT NOT NULL,
      technical_thread_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_channel_messages (
      message_id TEXT PRIMARY KEY NOT NULL,
      channel_id TEXT NOT NULL,
      technical_message_id TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL,
      parent_message_id TEXT,
      root_message_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_surface
    ON projection_threads(surface, deleted_at, archived_at, updated_at DESC)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_channels_project
    ON projection_channels(project_id, deleted_at, created_at, channel_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_channel_messages_channel
    ON projection_channel_messages(channel_id, sequence, message_id)
  `;
});
