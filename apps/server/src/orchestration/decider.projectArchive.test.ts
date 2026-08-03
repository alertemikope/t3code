import {
  CommandId,
  EventId,
  ProjectId,
  type OrchestrationCommand,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const projectId = ProjectId.make("project-archive");
const createdAt = "2026-01-01T00:00:00.000Z";

const seedProject = projectEvent(createEmptyReadModel(createdAt), {
  sequence: 1,
  eventId: EventId.make("event-project-create"),
  aggregateKind: "project",
  aggregateId: projectId,
  type: "project.created",
  occurredAt: createdAt,
  commandId: CommandId.make("command-project-create"),
  causationEventId: null,
  correlationId: CommandId.make("command-project-create"),
  metadata: {},
  payload: {
    projectId,
    title: "Archive me",
    workspaceRoot: "/tmp/project-archive",
    defaultModelSelection: null,
    scripts: [],
    createdAt,
    updatedAt: createdAt,
  },
});

function asSingleEvent(
  result:
    | Omit<OrchestrationEvent, "sequence">
    | ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
) {
  if (Array.isArray(result)) {
    const event = result[0];
    if (!event) throw new Error("Expected one orchestration event.");
    return event;
  }
  return result as Omit<OrchestrationEvent, "sequence">;
}

it.layer(NodeServices.layer)("project archive decider", (it) => {
  it.effect("archives and restores a project without changing its identity", () =>
    Effect.gen(function* () {
      const initial = yield* seedProject;
      const archiveCommand: Extract<OrchestrationCommand, { type: "project.archive" }> = {
        type: "project.archive",
        commandId: CommandId.make("command-project-archive"),
        projectId,
      };
      const archivedEvent = asSingleEvent(
        yield* decideOrchestrationCommand({ command: archiveCommand, readModel: initial }),
      );
      expect(archivedEvent.type).toBe("project.archived");

      const archived = yield* projectEvent(initial, { ...archivedEvent, sequence: 2 });
      expect(archived.projects[0]?.id).toBe(projectId);
      expect(archived.projects[0]?.archivedAt).not.toBeNull();

      const duplicateError = yield* Effect.flip(
        decideOrchestrationCommand({ command: archiveCommand, readModel: archived }),
      );
      expect(duplicateError.message).toContain("already archived");

      const unarchivedEvent = asSingleEvent(
        yield* decideOrchestrationCommand({
          command: {
            type: "project.unarchive",
            commandId: CommandId.make("command-project-unarchive"),
            projectId,
          },
          readModel: archived,
        }),
      );
      expect(unarchivedEvent.type).toBe("project.unarchived");

      const restored = yield* projectEvent(archived, { ...unarchivedEvent, sequence: 3 });
      expect(restored.projects[0]?.id).toBe(projectId);
      expect(restored.projects[0]?.archivedAt).toBeNull();
    }),
  );
});
