import { describe, expect, it, vi } from "vitest";
import {
  CodeBuddyAcpAgent,
  streamEventToAcpNotifications,
  toAcpNotifications,
} from "./src/acp-agent.js";

function createPromptSession(sdkSession: any) {
  return {
    sdkSession,
    cancelled: false,
    cwd: process.cwd(),
    permissionMode: "default" as any,
    settingsManager: {} as any,
    accumulatedUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedReadTokens: 0,
      cachedWriteTokens: 0,
    },
    configOptions: [],
    promptRunning: false,
    pendingMessages: new Map(),
    nextPendingOrder: 0,
    streamedContentBlockIndexes: new Set<number>(),
    toolUseCache: {} as any,
  };
}

describe("CodeBuddyAcpAgent.prompt", () => {
  it("falls back to completed assistant messages when no deltas were streamed", async () => {
    const sessionUpdate = vi.fn().mockResolvedValue(undefined);
    const client = { sessionUpdate } as any;
    const logger = { log: vi.fn(), error: vi.fn() };
    const agent = new CodeBuddyAcpAgent(client, logger);

    const sdkSession = {
      send: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn().mockResolvedValue(undefined),
      stream: async function* () {
        yield {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "思考中" },
              { type: "text", text: "最终回复" },
            ],
          },
        };
        yield {
          type: "result",
          subtype: "success",
          usage: {
            input_tokens: 1,
            output_tokens: 2,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        };
      },
    };

    agent.sessions["s1"] = createPromptSession(sdkSession as any);

    const response = await agent.prompt({
      sessionId: "s1",
      prompt: [{ type: "text", text: "hello" }],
    } as any);

    expect(response).toMatchObject({ stopReason: "end_turn" });
    expect(sessionUpdate).toHaveBeenCalledTimes(2);
    expect(sessionUpdate.mock.calls[0][0]).toMatchObject({
      sessionId: "s1",
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "思考中" },
      },
    });
    expect(sessionUpdate.mock.calls[1][0]).toMatchObject({
      sessionId: "s1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "最终回复" },
      },
    });
  });

  it("streams deltas immediately and does not duplicate them in the completed assistant message", async () => {
    const sessionUpdate = vi.fn().mockResolvedValue(undefined);
    const client = { sessionUpdate } as any;
    const logger = { log: vi.fn(), error: vi.fn() };
    const agent = new CodeBuddyAcpAgent(client, logger);

    const sdkSession = {
      send: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn().mockResolvedValue(undefined),
      stream: async function* () {
        yield {
          type: "stream_event",
          parent_tool_use_id: null,
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "思考增量" },
          },
        };
        yield {
          type: "stream_event",
          parent_tool_use_id: null,
          event: {
            type: "content_block_delta",
            index: 1,
            delta: { type: "text_delta", text: "回复增量" },
          },
        };
        yield {
          type: "assistant",
          parent_tool_use_id: null,
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "思考增量" },
              { type: "text", text: "回复增量" },
              {
                type: "tool_use",
                id: "tool-1",
                name: "Read",
                input: { file_path: "/tmp/demo.txt" },
              },
            ],
          },
        };
        yield {
          type: "result",
          subtype: "success",
          usage: {
            input_tokens: 1,
            output_tokens: 2,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        };
      },
    };

    agent.sessions["s1"] = createPromptSession(sdkSession as any);

    const response = await agent.prompt({
      sessionId: "s1",
      prompt: [{ type: "text", text: "hello" }],
    } as any);

    expect(response).toMatchObject({ stopReason: "end_turn" });
    expect(sessionUpdate).toHaveBeenCalledTimes(3);
    expect(sessionUpdate.mock.calls[0][0]).toMatchObject({
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "思考增量" },
      },
    });
    expect(sessionUpdate.mock.calls[1][0]).toMatchObject({
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "回复增量" },
      },
    });
    expect(sessionUpdate.mock.calls[2][0]).toMatchObject({
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        status: "pending",
      },
    });
  });
});

describe("session mode handling", () => {
  it("keeps dontAsk at the ACP layer without calling the SDK permission setter", async () => {
    const sessionUpdate = vi.fn().mockResolvedValue(undefined);
    const client = { sessionUpdate } as any;
    const logger = { log: vi.fn(), error: vi.fn() };
    const agent = new CodeBuddyAcpAgent(client, logger);

    const sdkSession = {
      setPermissionMode: vi.fn().mockResolvedValue(undefined),
    };

    agent.sessions["s1"] = createPromptSession(sdkSession as any);

    const response = await agent.setSessionMode({
      sessionId: "s1",
      modeId: "dontAsk",
    } as any);

    expect(response).toEqual({});
    expect(agent.sessions["s1"].permissionMode).toBe("dontAsk");
    expect(sdkSession.setPermissionMode).not.toHaveBeenCalled();
    expect(agent.sessions["s1"].configOptions).toEqual([]);
  });

  it("still forwards supported modes to the SDK permission setter", async () => {
    const sessionUpdate = vi.fn().mockResolvedValue(undefined);
    const client = { sessionUpdate } as any;
    const logger = { log: vi.fn(), error: vi.fn() };
    const agent = new CodeBuddyAcpAgent(client, logger);

    const sdkSession = {
      setPermissionMode: vi.fn().mockResolvedValue(undefined),
    };

    agent.sessions["s1"] = createPromptSession(sdkSession as any);

    await agent.setSessionMode({
      sessionId: "s1",
      modeId: "plan",
    } as any);

    expect(agent.sessions["s1"].permissionMode).toBe("plan");
    expect(sdkSession.setPermissionMode).toHaveBeenCalledWith("plan");
  });
});

describe("streaming edge cases", () => {
  it("converts text and thinking delta events into incremental chunks", () => {
    const logger = { log: vi.fn(), error: vi.fn() };

    const textDelta = streamEventToAcpNotifications(
      {
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "hello" },
        },
      },
      "s1",
      {},
      {} as any,
      logger as any
    );
    const thinkingDelta = streamEventToAcpNotifications(
      {
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 1,
          delta: { type: "thinking_delta", thinking: "world" },
        },
      },
      "s1",
      {},
      {} as any,
      logger as any
    );

    expect(textDelta).toMatchObject([
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello" },
        },
      },
    ]);
    expect(thinkingDelta).toMatchObject([
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "world" },
        },
      },
    ]);
  });

  it("ignores text and thinking content_block_start events to avoid duplicate chunks", () => {
    const logger = { log: vi.fn(), error: vi.fn() };

    const textStart = streamEventToAcpNotifications(
      {
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          content_block: { type: "text", text: "" },
        },
      },
      "s1",
      {},
      {} as any,
      logger as any
    );
    const thinkingStart = streamEventToAcpNotifications(
      {
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          content_block: { type: "thinking", thinking: "" },
        },
      },
      "s1",
      {},
      {} as any,
      logger as any
    );

    expect(textStart).toEqual([]);
    expect(thinkingStart).toEqual([]);
  });

  it("still emits tool calls from content_block_start events", () => {
    const logger = { log: vi.fn(), error: vi.fn() };
    const toolUseCache = {};

    const notifications = streamEventToAcpNotifications(
      {
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          content_block: {
            type: "tool_use",
            id: "tool-1",
            name: "Read",
            input: { file_path: "/tmp/demo.txt" },
          },
        },
      },
      "s1",
      toolUseCache,
      {} as any,
      logger as any
    );

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        status: "pending",
      },
    });
  });

  it("drops empty text and thinking chunks", () => {
    const notifications = toAcpNotifications(
      [
        { type: "text", text: "" },
        { type: "thinking", thinking: "" },
        { type: "text", text: "hello" },
        { type: "thinking", thinking: "world" },
      ],
      "assistant",
      "s1",
      {},
      {} as any,
      { log: vi.fn(), error: vi.fn() }
    );

    expect(notifications).toHaveLength(2);
    expect(notifications[0]).toMatchObject({
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
      },
    });
    expect(notifications[1]).toMatchObject({
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "world" },
      },
    });
  });
});
