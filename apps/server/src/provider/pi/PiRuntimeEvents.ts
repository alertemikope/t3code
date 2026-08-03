import {
  type EventId,
  type ProviderApprovalDecision,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  RuntimeItemId,
  type RuntimeRequestId,
  type ThreadId,
  type TurnId,
  type ToolLifecycleItemType,
} from "@t3tools/contracts";

export interface PiEventStamp {
  readonly eventId: EventId;
  readonly createdAt: string;
}

export interface PiEventIdentity {
  readonly provider: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
}

function canonicalToolItemType(toolName: string): ToolLifecycleItemType {
  switch (toolName) {
    case "bash":
    case "exec_command":
      return "command_execution";
    case "edit":
    case "write":
    case "apply_patch":
      return "file_change";
    case "web_search":
    case "fetch":
      return "web_search";
    case "view_image":
      return "image_view";
    default:
      return "dynamic_tool_call";
  }
}

function canonicalRequestType(toolName: string) {
  switch (toolName) {
    case "bash":
    case "exec_command":
      return "exec_command_approval" as const;
    case "read":
    case "grep":
    case "find":
    case "ls":
      return "file_read_approval" as const;
    case "edit":
    case "write":
    case "apply_patch":
      return "file_change_approval" as const;
    default:
      return "dynamic_tool_call" as const;
  }
}

export function makePiItemEvent(input: {
  readonly stamp: PiEventStamp;
  readonly identity: PiEventIdentity;
  readonly lifecycle: "item.started" | "item.updated" | "item.completed";
  readonly itemId: string;
  readonly itemType: "assistant_message" | "reasoning" | "context_compaction";
  readonly status?: "inProgress" | "completed" | "failed";
  readonly data?: unknown;
}): ProviderRuntimeEvent {
  return {
    type: input.lifecycle,
    ...input.stamp,
    ...input.identity,
    itemId: RuntimeItemId.make(input.itemId),
    payload: {
      itemType: input.itemType,
      status: input.status ?? (input.lifecycle === "item.completed" ? "completed" : "inProgress"),
      ...(input.data === undefined ? {} : { data: input.data }),
    },
  };
}

export function makePiContentDeltaEvent(input: {
  readonly stamp: PiEventStamp;
  readonly identity: PiEventIdentity;
  readonly itemId?: string;
  readonly streamKind: "user_text" | "assistant_text" | "reasoning_text";
  readonly delta: string;
  readonly contentIndex?: number;
  readonly rawPayload: unknown;
}): ProviderRuntimeEvent {
  return {
    type: "content.delta",
    ...input.stamp,
    ...input.identity,
    ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
    payload: {
      streamKind: input.streamKind,
      delta: input.delta,
      ...(input.contentIndex === undefined ? {} : { contentIndex: input.contentIndex }),
    },
    raw: {
      source: "pi.sdk",
      method: "message_update",
      payload: input.rawPayload,
    },
  };
}

export function makePiToolEvent(input: {
  readonly stamp: PiEventStamp;
  readonly identity: PiEventIdentity;
  readonly lifecycle: "item.started" | "item.updated" | "item.completed";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly result?: unknown;
  readonly isError?: boolean;
}): ProviderRuntimeEvent {
  const status =
    input.lifecycle === "item.completed" ? (input.isError ? "failed" : "completed") : "inProgress";
  return {
    type: input.lifecycle,
    ...input.stamp,
    ...input.identity,
    itemId: RuntimeItemId.make(input.toolCallId),
    payload: {
      itemType: canonicalToolItemType(input.toolName),
      status,
      title: input.toolName,
      data: {
        toolName: input.toolName,
        args: input.args,
        ...(input.result === undefined ? {} : { result: input.result }),
      },
    },
    raw: {
      source: "pi.sdk",
      method:
        input.lifecycle === "item.started"
          ? "tool_execution_start"
          : input.lifecycle === "item.updated"
            ? "tool_execution_update"
            : "tool_execution_end",
      payload: {
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        args: input.args,
        ...(input.result === undefined ? {} : { result: input.result }),
        ...(input.isError === undefined ? {} : { isError: input.isError }),
      },
    },
  };
}

export function makePiRequestOpenedEvent(input: {
  readonly stamp: PiEventStamp;
  readonly identity: PiEventIdentity;
  readonly requestId: RuntimeRequestId;
  readonly toolName: string;
  readonly args: unknown;
}): ProviderRuntimeEvent {
  return {
    type: "request.opened",
    ...input.stamp,
    ...input.identity,
    requestId: input.requestId,
    payload: {
      requestType: canonicalRequestType(input.toolName),
      detail: `Pi requests permission to run ${input.toolName}.`,
      args: input.args,
    },
    raw: {
      source: "pi.sdk",
      method: "tool_call",
      payload: { toolName: input.toolName, args: input.args },
    },
  };
}

export function makePiRequestResolvedEvent(input: {
  readonly stamp: PiEventStamp;
  readonly identity: PiEventIdentity;
  readonly requestId: RuntimeRequestId;
  readonly toolName: string;
  readonly decision: ProviderApprovalDecision;
}): ProviderRuntimeEvent {
  return {
    type: "request.resolved",
    ...input.stamp,
    ...input.identity,
    requestId: input.requestId,
    payload: {
      requestType: canonicalRequestType(input.toolName),
      decision: input.decision,
    },
  };
}
