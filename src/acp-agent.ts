/**
 * CodeBuddy ACP Agent Implementation
 *
 * This module implements the ACP (Agent Client Protocol) interface for CodeBuddy,
 * bridging between the ACP protocol and the CodeBuddy Agent SDK.
 */

import {
  Agent,
  AgentSideConnection,
  AuthenticateRequest,
  AuthMethod,
  AvailableCommand,
  CancelNotification,
  ClientCapabilities,
  ForkSessionRequest,
  ForkSessionResponse,
  InitializeRequest,
  InitializeResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  ndJsonStream,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  RequestError,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SessionConfigOption,
  SessionModelState,
  SessionModeState,
  SessionNotification,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModelRequest,
  SetSessionModelResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  unstable_v2_createSession as sdkCreateSession,
  unstable_v2_resumeSession as sdkResumeSession,
  type Session as SDKSession,
  type SessionOptions as SDKSessionOptions,
  type CanUseTool,
  type PermissionMode as SDKPermissionMode,
  type McpServerConfig,
  type UserMessage as SDKUserMessage,
  type ModelInfo,
  type SlashCommand,
  type AskUserQuestionInput,
} from "@tencent-ai/agent-sdk";
import { SettingsManager, CODEBUDDY_CONFIG_DIR } from "./settings.js";
import {
  ClaudePlanEntry,
  createPostToolUseHook,
  planEntries,
  registerHookCallback,
  toolInfoFromToolUse,
  toolUpdateFromEditToolResponse,
  toolUpdateFromToolResult,
} from "./tools.js";
import { nodeToWebReadable, nodeToWebWritable, Pushable, unreachable } from "./utils.js";

// Package info (would normally be imported from package.json)
const PACKAGE_NAME = "@anthropic-ai/codebuddy-agent-acp";
const PACKAGE_VERSION = "0.1.0";

const MAX_TITLE_LENGTH = 256;

function sanitizeTitle(text: string): string {
  const sanitized = text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (sanitized.length <= MAX_TITLE_LENGTH) {
    return sanitized;
  }
  return sanitized.slice(0, MAX_TITLE_LENGTH - 1) + "…";
}

/**
 * Logger interface for customizing logging output
 */
export interface Logger {
  log: (...args: any[]) => void;
  error: (...args: any[]) => void;
}

// Permission mode type (compatible with SDK)
type PermissionMode = SDKPermissionMode;

type AccumulatedUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
};

type Session = {
  sdkSession: SDKSession;
  cancelled: boolean;
  cwd: string;
  permissionMode: PermissionMode;
  settingsManager: SettingsManager;
  accumulatedUsage: AccumulatedUsage;
  configOptions: SessionConfigOption[];
  promptRunning: boolean;
  pendingMessages: Map<string, { resolve: (cancelled: boolean) => void; order: number }>;
  nextPendingOrder: number;
  streamedContentBlockIndexes: Set<number>;
  toolUseCache: ToolUseCache;
};

/**
 * Extra metadata that can be given when creating a new session.
 */
export type NewSessionMeta = {
  codebuddy?: {
    options?: any;
  };
};

/**
 * Extra metadata for 'gateway' authentication requests.
 */
type GatewayAuthMeta = {
  gateway: {
    baseUrl: string;
    headers: Record<string, string>;
  };
};

/**
 * Extra metadata that the agent provides for each tool_call / tool_update update.
 */
export type ToolUpdateMeta = {
  codebuddy?: {
    toolName: string;
    toolResponse?: unknown;
  };
  terminal_info?: {
    terminal_id: string;
  };
  terminal_output?: {
    terminal_id: string;
    data: string;
  };
  terminal_exit?: {
    terminal_id: string;
    exit_code: number;
    signal: string | null;
  };
};

export type ToolUseCache = {
  [key: string]: {
    type: "tool_use" | "server_tool_use" | "mcp_tool_use";
    id: string;
    name: string;
    input: unknown;
  };
};

function shouldHideAuth(): boolean {
  return process.argv.includes("--hide-auth");
}

// Bypass Permissions doesn't work if we are a root/sudo user
const IS_ROOT = (process.geteuid?.() ?? process.getuid?.()) === 0;
const ALLOW_BYPASS = !IS_ROOT || !!process.env.IS_SANDBOX;

const PERMISSION_MODE_ALIASES: Record<string, PermissionMode> = {
  default: "default",
  acceptedits: "acceptEdits",
  dontask: "dontAsk",
  plan: "plan",
  bypasspermissions: "bypassPermissions",
  bypass: "bypassPermissions",
};

export function resolvePermissionMode(defaultMode?: unknown): PermissionMode {
  if (defaultMode === undefined) {
    return "default";
  }

  if (typeof defaultMode !== "string") {
    throw new Error("Invalid permissions.defaultMode: expected a string.");
  }

  const normalized = defaultMode.trim().toLowerCase();
  if (normalized === "") {
    throw new Error("Invalid permissions.defaultMode: expected a non-empty string.");
  }

  const mapped = PERMISSION_MODE_ALIASES[normalized];
  if (!mapped) {
    throw new Error(`Invalid permissions.defaultMode: ${defaultMode}.`);
  }

  if (mapped === "bypassPermissions" && !ALLOW_BYPASS) {
    throw new Error(
      "Invalid permissions.defaultMode: bypassPermissions is not available when running as root."
    );
  }

  return mapped;
}

/**
 * Get the path to the CodeBuddy CLI
 */
export async function codebuddyCliPath(): Promise<string> {
  // TODO: Implement proper CLI path resolution for CodeBuddy
  // This should find the codebuddy CLI executable
  return "codebuddy";
}

/**
 * Main CodeBuddy ACP Agent class implementing the Agent interface
 */
export class CodeBuddyAcpAgent implements Agent {
  sessions: { [key: string]: Session };
  client: AgentSideConnection;
  clientCapabilities?: ClientCapabilities;
  logger: Logger;
  gatewayAuthMeta?: GatewayAuthMeta;

  constructor(client: AgentSideConnection, logger?: Logger) {
    this.sessions = {};
    this.client = client;
    this.logger = logger ?? console;
  }

  async initialize(request: InitializeRequest): Promise<InitializeResponse> {
    this.clientCapabilities = request.clientCapabilities;

    const supportsGatewayAuth = request.clientCapabilities?.auth?._meta?.gateway === true;

    const gatewayAuthMethod: AuthMethod = {
      id: "gateway",
      name: "Custom model gateway",
      description: "Use a custom gateway to authenticate and access models",
      _meta: {
        gateway: {
          protocol: "anthropic",
        },
      },
    };

    const terminalAuthMethod: any = {
      description: "Run `codebuddy /login` in the terminal",
      name: "Log in with CodeBuddy",
      id: "codebuddy-login",
      type: "terminal",
      args: ["--cli"],
    };
    const supportsTerminalAuth = request.clientCapabilities?.auth?.terminal === true;

    const supportsMetaTerminalAuth = request.clientCapabilities?._meta?.["terminal-auth"] === true;
    if (supportsMetaTerminalAuth) {
      terminalAuthMethod._meta = {
        "terminal-auth": {
          command: process.execPath,
          args: [...process.argv.slice(1), "--cli"],
          label: "CodeBuddy Login",
        },
      };
    }

    return {
      protocolVersion: 1,
      agentCapabilities: {
        _meta: {
          codebuddy: {
            promptQueueing: true,
          },
        },
        promptCapabilities: {
          image: true,
          embeddedContext: true,
        },
        mcpCapabilities: {
          http: true,
          sse: true,
        },
        loadSession: true,
        sessionCapabilities: {
          fork: {},
          list: {},
          resume: {},
        },
      },
      agentInfo: {
        name: PACKAGE_NAME,
        title: "CodeBuddy Agent",
        version: PACKAGE_VERSION,
      },
      authMethods: [
        ...(!shouldHideAuth() && (supportsTerminalAuth || supportsMetaTerminalAuth)
          ? [terminalAuthMethod]
          : []),
        ...(supportsGatewayAuth ? [gatewayAuthMethod] : []),
      ],
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    if (
      !this.gatewayAuthMeta &&
      fs.existsSync(path.resolve(os.homedir(), ".codebuddy.json.backup")) &&
      !fs.existsSync(path.resolve(os.homedir(), ".codebuddy.json"))
    ) {
      throw RequestError.authRequired();
    }

    const response = await this.createSession(params, {
      resume: (params._meta as NewSessionMeta | undefined)?.codebuddy?.options?.resume,
    });

    setTimeout(() => {
      this.sendAvailableCommandsUpdate(response.sessionId);
    }, 0);

    return response;
  }

  async unstable_forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse> {
    const response = await this.createSession(
      {
        cwd: params.cwd,
        mcpServers: params.mcpServers ?? [],
        _meta: params._meta,
      },
      {
        resume: params.sessionId,
        forkSession: true,
      }
    );

    setTimeout(() => {
      this.sendAvailableCommandsUpdate(response.sessionId);
    }, 0);

    return response;
  }

  async unstable_resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    const response = await this.createSession(
      {
        cwd: params.cwd,
        mcpServers: params.mcpServers ?? [],
        _meta: params._meta,
      },
      {
        resume: params.sessionId,
      }
    );

    setTimeout(() => {
      this.sendAvailableCommandsUpdate(response.sessionId);
    }, 0);

    return response;
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const response = await this.createSession(
      {
        cwd: params.cwd,
        mcpServers: params.mcpServers ?? [],
        _meta: params._meta,
      },
      {
        resume: params.sessionId,
      }
    );

    // TODO: Replay session history
    // await this.replaySessionHistory(params.sessionId);

    setTimeout(() => {
      this.sendAvailableCommandsUpdate(params.sessionId);
    }, 0);

    return {
      modes: response.modes,
      models: response.models,
      configOptions: response.configOptions,
    };
  }

  async unstable_listSessions(_params: ListSessionsRequest): Promise<ListSessionsResponse> {
    // TODO: Implement session listing using CodeBuddy SDK
    return {
      sessions: [],
    };
  }

  async authenticate(_params: AuthenticateRequest): Promise<void> {
    if (_params.methodId === "gateway") {
      this.gatewayAuthMeta = _params._meta as GatewayAuthMeta | undefined;
      return;
    }
    throw new Error("Method not implemented.");
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions[params.sessionId];
    if (!session) {
      throw new Error("Session not found");
    }

    session.cancelled = false;
    session.accumulatedUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cachedReadTokens: 0,
      cachedWriteTokens: 0,
    };

    if (session.promptRunning) {
      throw new Error("Concurrent prompts are not supported yet");
    }

    session.streamedContentBlockIndexes.clear();
    session.toolUseCache = {};

    const userMessage = promptToCodeBuddy(params);
    session.promptRunning = true;

    try {
      await session.sdkSession.send(userMessage);

      for await (const message of session.sdkSession.stream()) {
        if (!message) {
          continue;
        }

        switch (message.type) {
          case "system":
          case "tool_progress":
          case "error":
          case "topic":
          case "file-history-snapshot":
            break;

          case "result": {
            if (session.cancelled) {
              return { stopReason: "cancelled" };
            }

            session.accumulatedUsage.inputTokens += message.usage.input_tokens;
            session.accumulatedUsage.outputTokens += message.usage.output_tokens;
            session.accumulatedUsage.cachedReadTokens += message.usage.cache_read_input_tokens ?? 0;
            session.accumulatedUsage.cachedWriteTokens += message.usage.cache_creation_input_tokens ?? 0;

            const usage: PromptResponse["usage"] = {
              inputTokens: session.accumulatedUsage.inputTokens,
              outputTokens: session.accumulatedUsage.outputTokens,
              cachedReadTokens: session.accumulatedUsage.cachedReadTokens,
              cachedWriteTokens: session.accumulatedUsage.cachedWriteTokens,
              totalTokens:
                session.accumulatedUsage.inputTokens +
                session.accumulatedUsage.outputTokens +
                session.accumulatedUsage.cachedReadTokens +
                session.accumulatedUsage.cachedWriteTokens,
            };

            switch (message.subtype) {
              case "success":
                return { stopReason: "end_turn", usage };
              case "error_max_turns":
              case "error_max_budget_usd":
                return { stopReason: "max_turn_requests", usage };
              case "error_during_execution":
                if (message.is_error) {
                  throw RequestError.internalError(
                    undefined,
                    message.errors?.join(", ") || message.subtype
                  );
                }
                return { stopReason: "end_turn", usage };
              default:
                return { stopReason: "end_turn", usage };
            }
          }

          case "stream_event": {
            // 增量 text/thinking delta 直接发送；完整 assistant 消息仅补充未流式发送的内容
            // message_delta 仍然忽略，非文本的 content_block_start（例如 tool_use）继续尽早展示
            const event = message.event;
            if (
              event?.type === "content_block_delta" &&
              typeof event.index === "number" &&
              ["text_delta", "thinking_delta"].includes(event.delta?.type)
            ) {
              session.streamedContentBlockIndexes.add(event.index);
            }
            if (event?.type !== "message_delta") {
              for (const notification of streamEventToAcpNotifications(
                message,
                params.sessionId,
                session.toolUseCache,
                this.client,
                this.logger,
                {
                  clientCapabilities: this.clientCapabilities,
                  cwd: session.cwd,
                }
              )) {
                await this.client.sessionUpdate(notification);
              }
            }
            break;
          }

          case "user":
          case "assistant": {
            if (session.cancelled) {
              break;
            }

            const content =
              message.type === "assistant"
                ? message.message.content.filter(
                    (item: any, index: number) =>
                      !(
                        ["text", "thinking"].includes(item.type) &&
                        session.streamedContentBlockIndexes.has(index)
                      )
                  )
                : message.message.content;

            for (const notification of toAcpNotifications(
              content,
              message.message.role,
              params.sessionId,
              session.toolUseCache,
              this.client,
              this.logger,
              {
                clientCapabilities: this.clientCapabilities,
                parentToolUseId: message.parent_tool_use_id,
                cwd: session.cwd,
              }
            )) {
              await this.client.sessionUpdate(notification);
            }
            if (message.type === "assistant") {
              session.streamedContentBlockIndexes.clear();
            }
            break;
          }

          default:
            this.logger.log(`Unknown message type: ${(message as any).type}`);
            break;
        }
      }

      throw new Error("Session did not end in result");
    } catch (error) {
      if (error instanceof RequestError || !(error instanceof Error)) {
        throw error;
      }
      throw error;
    } finally {
      session.promptRunning = false;
    }
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions[params.sessionId];
    if (!session) {
      throw new Error("Session not found");
    }
    session.cancelled = true;
    for (const [, pending] of session.pendingMessages) {
      pending.resolve(true);
    }
    session.pendingMessages.clear();
    await session.sdkSession.interrupt();
  }

  async unstable_setSessionModel(
    params: SetSessionModelRequest
  ): Promise<SetSessionModelResponse | void> {
    if (!this.sessions[params.sessionId]) {
      throw new Error("Session not found");
    }
    await this.sessions[params.sessionId].sdkSession.setModel(params.modelId);
    await this.updateConfigOption(params.sessionId, "model", params.modelId);
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    if (!this.sessions[params.sessionId]) {
      throw new Error("Session not found");
    }

    await this.applySessionMode(params.sessionId, params.modeId);
    await this.updateConfigOption(params.sessionId, "mode", params.modeId);
    return {};
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest
  ): Promise<SetSessionConfigOptionResponse> {
    const session = this.sessions[params.sessionId];
    if (!session) {
      throw new Error("Session not found");
    }

    const option = session.configOptions.find((o) => o.id === params.configId);
    if (!option) {
      throw new Error(`Unknown config option: ${params.configId}`);
    }

    const allValues =
      "options" in option && Array.isArray(option.options)
        ? option.options.flatMap((o) => ("options" in o ? o.options : [o]))
        : [];
    const validValue = allValues.find((o) => o.value === params.value);
    if (!validValue) {
      throw new Error(`Invalid value for config option ${params.configId}: ${params.value}`);
    }

    if (params.configId === "mode") {
      await this.applySessionMode(params.sessionId, params.value);
      await this.client.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "current_mode_update",
          currentModeId: params.value,
        },
      });
    } else if (params.configId === "model") {
      await this.sessions[params.sessionId].sdkSession.setModel(params.value);
    }

    session.configOptions = session.configOptions.map((o) =>
      o.id === params.configId ? { ...o, currentValue: params.value } : o
    );

    return { configOptions: session.configOptions };
  }

  private async applySessionMode(sessionId: string, modeId: string): Promise<void> {
    switch (modeId) {
      case "default":
      case "acceptEdits":
      case "bypassPermissions":
      case "dontAsk":
      case "plan":
        break;
      default:
        throw new Error("Invalid Mode");
    }
    this.sessions[sessionId].permissionMode = modeId;

    // 底层 CLI 当前会拒绝 dontAsk；ACP 层先保留该模式状态，避免切换时报错。
    if (modeId === "dontAsk") {
      return;
    }

    try {
      await this.sessions[sessionId].sdkSession.setPermissionMode(modeId);
    } catch (error) {
      if (error instanceof Error) {
        if (!error.message) {
          error.message = "Invalid Mode";
        }
        throw error;
      } else {
        throw new Error("Invalid Mode");
      }
    }
  }

  async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    const response = await this.client.readTextFile(params);
    return response;
  }

  async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    const response = await this.client.writeTextFile(params);
    return response;
  }

  private async sendAvailableCommandsUpdate(sessionId: string): Promise<void> {
    const session = this.sessions[sessionId];
    if (!session) {
      return;
    }

    try {
      const commands = await session.sdkSession.getAvailableCommands();
      await this.client.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: commands,
        },
      });
    } catch (error) {
      this.logger.error("Failed to get supported commands:", error);
    }
  }

  private async updateConfigOption(
    sessionId: string,
    configId: string,
    value: string
  ): Promise<void> {
    const session = this.sessions[sessionId];
    if (!session) {
      return;
    }

    session.configOptions = session.configOptions.map((o) =>
      o.id === configId ? { ...o, currentValue: value } : o
    );

    await this.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "config_option_update",
        configOptions: session.configOptions,
      },
    });
  }

  private async createSession(
    params: NewSessionRequest,
    creationOpts: { resume?: string; forkSession?: boolean } = {}
  ): Promise<NewSessionResponse> {
    let sessionId;
    if (creationOpts.forkSession) {
      sessionId = randomUUID();
    } else if (creationOpts.resume) {
      sessionId = creationOpts.resume;
    } else {
      sessionId = randomUUID();
    }

    const settingsManager = new SettingsManager(params.cwd, {
      logger: this.logger,
    });
    await settingsManager.initialize();

    // Build MCP servers config from ACP params
    const mcpServers: Record<string, McpServerConfig> = {};
    if (Array.isArray(params.mcpServers)) {
      for (const server of params.mcpServers) {
        if ("type" in server && (server.type === "sse" || server.type === "http")) {
          mcpServers[server.name] = {
            type: server.type,
            url: server.url,
            headers: server.headers
              ? Object.fromEntries(server.headers.map((e) => [e.name, e.value]))
              : undefined,
          };
        } else {
          mcpServers[server.name] = {
            type: "stdio",
            command: (server as any).command,
            args: (server as any).args,
            env: (server as any).env
              ? Object.fromEntries((server as any).env.map((e: any) => [e.name, e.value]))
              : undefined,
          };
        }
      }
    }

    const permissionMode = resolvePermissionMode(
      settingsManager.getSettings().permissions?.defaultMode
    );

    // Extract user-provided options from _meta
    const userProvidedOptions = (params._meta as NewSessionMeta | undefined)?.codebuddy?.options;

    // Build canUseTool callback for permission handling
    const canUseTool: CanUseTool = async (toolName, toolInput, options) => {
      const supportsTerminalOutput = this.clientCapabilities?._meta?.["terminal_output"] === true;
      const session = this.sessions[sessionId];
      if (!session) {
        return {
          behavior: "deny",
          message: "Session not found",
          interrupt: true,
        };
      }

      // Handle ExitPlanMode specially
      if (toolName === "ExitPlanMode") {
        const response = await this.client.requestPermission({
          options: [
            {
              kind: "allow_always",
              name: "Yes, and auto-accept edits",
              optionId: "acceptEdits",
            },
            { kind: "allow_once", name: "Yes, and manually approve edits", optionId: "default" },
            { kind: "reject_once", name: "No, keep planning", optionId: "plan" },
          ],
          sessionId,
          toolCall: {
            toolCallId: options.toolUseID,
            rawInput: toolInput,
            ...toolInfoFromToolUse(
              { name: toolName, input: toolInput, id: options.toolUseID },
              supportsTerminalOutput,
              session?.cwd
            ),
          },
        });

        if (options.signal.aborted || response.outcome?.outcome === "cancelled") {
          throw new Error("Tool use aborted");
        }
        if (
          response.outcome?.outcome === "selected" &&
          (response.outcome.optionId === "default" || response.outcome.optionId === "acceptEdits")
        ) {
          session.permissionMode = response.outcome.optionId as PermissionMode;
          await this.client.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "current_mode_update",
              currentModeId: response.outcome.optionId,
            },
          });
          await this.updateConfigOption(sessionId, "mode", response.outcome.optionId);

          return {
            behavior: "allow",
            updatedInput: toolInput,
            updatedPermissions: options.suggestions ?? [
              { type: "setMode", mode: response.outcome.optionId as PermissionMode, destination: "session" },
            ],
          };
        } else {
          return {
            behavior: "deny",
            message: "User rejected request to exit plan mode.",
            interrupt: true,
          };
        }
      }

      // Handle AskUserQuestion via requestPermission
      if (toolName === "AskUserQuestion") {
        const input = toolInput as AskUserQuestionInput;
        const questions = input?.questions ?? [];
        const answers: Record<string, string> = {};

        for (const question of questions) {
          if (question.multiSelect) {
            // 多选：循环收集，直到用户选择"完成选择"
            const selected: string[] = [];
            while (true) {
              const response = await this.client.requestPermission({
                options: [
                  ...question.options.map((opt) => ({
                    kind: "allow_once" as const,
                    name: opt.label,
                    optionId: opt.label,
                    _meta: { description: opt.description },
                  })),
                  { kind: "allow_always" as const, name: "完成选择", optionId: "__done__" },
                ],
                sessionId,
                toolCall: {
                  toolCallId: options.toolUseID,
                  rawInput: toolInput,
                  title: question.question,
                  kind: "other",
                },
              });
              if (options.signal.aborted || response.outcome?.outcome === "cancelled") {
                return { behavior: "deny", message: "User cancelled question", interrupt: true };
              }
              const chosen = (response.outcome as any)?.optionId;
              if (chosen === "__done__") break;
              if (chosen && !selected.includes(chosen)) selected.push(chosen);
            }
            answers[question.header] = selected.join(",");
          } else {
            // 单选
            const response = await this.client.requestPermission({
              options: question.options.map((opt) => ({
                kind: "allow_once" as const,
                name: opt.label,
                optionId: opt.label,
                _meta: { description: opt.description },
              })),
              sessionId,
              toolCall: {
                toolCallId: options.toolUseID,
                rawInput: toolInput,
                title: question.question,
                kind: "other",
              },
            });
            if (options.signal.aborted || response.outcome?.outcome === "cancelled") {
              return { behavior: "deny", message: "User cancelled question", interrupt: true };
            }
            const chosen = (response.outcome as any)?.optionId;
            if (chosen) answers[question.header] = chosen;
          }
        }

        return {
          behavior: "allow",
          updatedInput: { ...toolInput, answers },
        };
      }

      // Bypass permissions mode
      if (session.permissionMode === "bypassPermissions") {
        return {
          behavior: "allow",
          updatedInput: toolInput,
          updatedPermissions: options.suggestions ?? [
            { type: "addRules", rules: [{ toolName }], behavior: "allow", destination: "session" },
          ],
        };
      }

      // Request permission from client
      const response = await this.client.requestPermission({
        options: [
          {
            kind: "allow_always",
            name: "Always Allow",
            optionId: "allow_always",
          },
          { kind: "allow_once", name: "Allow", optionId: "allow" },
          { kind: "reject_once", name: "Reject", optionId: "reject" },
        ],
        sessionId,
        toolCall: {
          toolCallId: options.toolUseID,
          rawInput: toolInput,
          ...toolInfoFromToolUse(
            { name: toolName, input: toolInput, id: options.toolUseID },
            supportsTerminalOutput,
            session?.cwd
          ),
        },
      });

      if (options.signal.aborted || response.outcome?.outcome === "cancelled") {
        throw new Error("Tool use aborted");
      }
      if (
        response.outcome?.outcome === "selected" &&
        (response.outcome.optionId === "allow" || response.outcome.optionId === "allow_always")
      ) {
        if (response.outcome.optionId === "allow_always") {
          return {
            behavior: "allow",
            updatedInput: toolInput,
            updatedPermissions: options.suggestions ?? [
              {
                type: "addRules",
                rules: [{ toolName }],
                behavior: "allow",
                destination: "session",
              },
            ],
          };
        }
        return {
          behavior: "allow",
          updatedInput: toolInput,
        };
      } else {
        return {
          behavior: "deny",
          message: "User refused permission to run tool",
          interrupt: true,
        };
      }
    };

    // AskUserQuestion is handled via requestPermission in canUseTool
    const disallowedTools: string[] = [];

    // Build SDK options
    const sdkOptions: SDKSessionOptions = {
      cwd: params.cwd,
      settingSources: ["user", "project", "local"],
      includePartialMessages: true,
      model: settingsManager.getSettings().model,
      mcpServers: { ...(userProvidedOptions?.mcpServers || {}), ...mcpServers },
      permissionMode,
      canUseTool,
      disallowedTools: [...(userProvidedOptions?.disallowedTools || []), ...disallowedTools],
      // Pass --acp to the CLI so it does not set shouldAvoidPermissionPrompts=true.
      // Without this flag, the CLI treats --print mode as non-interactive and denies
      // any tool that requires a permission prompt.
      extraArgs: { acp: null },
      env: {
        ...process.env,
        ...userProvidedOptions?.env,
        ...createEnvForGateway(this.gatewayAuthMeta),
      },
      hooks: {
        ...userProvidedOptions?.hooks,
        PostToolUse: [
          ...(userProvidedOptions?.hooks?.PostToolUse || []),
          {
            hooks: [
              createPostToolUseHook(this.logger, {
                onEnterPlanMode: async () => {
                  const session = this.sessions[sessionId];
                  if (session) {
                    session.permissionMode = "plan";
                  }
                  await this.client.sessionUpdate({
                    sessionId,
                    update: {
                      sessionUpdate: "current_mode_update",
                      currentModeId: "plan",
                    },
                  });
                  await this.updateConfigOption(sessionId, "mode", "plan");
                },
              }),
            ],
          },
        ],
      },
      ...userProvidedOptions,
    };

    // Always set the session ID
    sdkOptions.sessionId = sessionId;

    // Always include --acp flag regardless of userProvidedOptions (which may override extraArgs)
    sdkOptions.extraArgs = { ...sdkOptions.extraArgs, acp: null };

    // Create the SDK session
    const sdkSession: SDKSession = creationOpts.resume && !creationOpts.forkSession
      ? sdkResumeSession(creationOpts.resume, sdkOptions)
      : sdkCreateSession(sdkOptions);

    // Wait for initialization and connect session
    await sdkSession.connect();

    // Get available models
    let normalizedModels: Array<{ modelId: string; name: string; description?: string }> = [];
    try {
      normalizedModels = await sdkSession.getAvailableModels();
    } catch (error) {
      this.logger.error("Failed to get supported models:", error);
      // Fallback models
      normalizedModels = [{ modelId: "default", name: "Default", description: "Default model" }];
    }

    const availableModes = [
      {
        id: "default",
        name: "Default",
        description: "Standard behavior, prompts for dangerous operations",
      },
      {
        id: "acceptEdits",
        name: "Accept Edits",
        description: "Auto-accept file edit operations",
      },
      {
        id: "plan",
        name: "Plan Mode",
        description: "Planning mode, no actual tool execution",
      },
      {
        id: "dontAsk",
        name: "Don't Ask",
        description: "Don't prompt for permissions, deny if not pre-approved",
      },
    ];

    if (ALLOW_BYPASS) {
      availableModes.push({
        id: "bypassPermissions",
        name: "Bypass Permissions",
        description: "Bypass all permission checks",
      });
    }

    const modes: SessionModeState = {
      currentModeId: permissionMode,
      availableModes,
    };

    // Build models state from SDK models
    const currentModel = settingsManager.getSettings().model;
    const modelState: SessionModelState = {
      availableModels:
        normalizedModels.length > 0
          ? normalizedModels
          : [
              {
                modelId: "default",
                name: "Default",
                description: "Fallback model",
              },
            ],
      currentModelId:
        currentModel || normalizedModels[0]?.modelId || settingsManager.getSettings().model || "default",
    };

    const configOptions = buildConfigOptions(modes, modelState);

    this.sessions[sessionId] = {
      sdkSession,
      cancelled: false,
      cwd: params.cwd,
      permissionMode,
      settingsManager,
      accumulatedUsage: {
        inputTokens: 0,
        outputTokens: 0,
        cachedReadTokens: 0,
        cachedWriteTokens: 0,
      },
      configOptions,
      promptRunning: false,
      pendingMessages: new Map(),
      nextPendingOrder: 0,
      streamedContentBlockIndexes: new Set(),
      toolUseCache: {},
    };

    return {
      sessionId,
      models: modelState,
      modes,
      configOptions,
    };
  }
}

function createEnvForGateway(gatewayMeta?: GatewayAuthMeta) {
  if (!gatewayMeta) {
    return {};
  }
  return {
    CODEBUDDY_BASE_URL: gatewayMeta.gateway.baseUrl,
    CODEBUDDY_CUSTOM_HEADERS: Object.entries(gatewayMeta.gateway.headers)
      .map(([key, value]) => `${key}: ${value}`)
      .join("\n"),
    CODEBUDDY_AUTH_TOKEN: "",
  };
}

function normalizeSdkModel(
  model: ModelInfo | Record<string, unknown>
): { modelId: string; name: string; description?: string } | null {
  const modelId =
    (typeof (model as any).modelId === "string" && (model as any).modelId) ||
    (typeof (model as any).id === "string" && (model as any).id) ||
    (typeof (model as any).value === "string" && (model as any).value);

  const name =
    (typeof (model as any).displayName === "string" && (model as any).displayName) ||
    (typeof (model as any).name === "string" && (model as any).name) ||
    modelId;

  const description =
    (typeof (model as any).description === "string" && (model as any).description) ||
    (typeof (model as any).descriptionZh === "string" && (model as any).descriptionZh) ||
    (typeof (model as any).descriptionEn === "string" && (model as any).descriptionEn) ||
    undefined;

  if (!modelId || !name) {
    return null;
  }

  return {
    modelId,
    name,
    description,
  };
}

function buildConfigOptions(
  modes: SessionModeState,
  models: SessionModelState
): SessionConfigOption[] {
  return [
    {
      id: "mode",
      name: "Mode",
      description: "Session permission mode",
      category: "mode",
      type: "select",
      currentValue: modes.currentModeId,
      options: modes.availableModes.map((m) => ({
        value: m.id,
        name: m.name,
        description: m.description,
      })),
    },
    {
      id: "model",
      name: "Model",
      description: "AI model to use",
      category: "model",
      type: "select",
      currentValue: models.currentModelId,
      options: models.availableModels.map((m) => ({
        value: m.modelId,
        name: m.name,
        description: m.description ?? undefined,
      })),
    },
  ];
}

function getAvailableSlashCommands(commands: SlashCommand[]): AvailableCommand[] {
  const UNSUPPORTED_COMMANDS = [
    "cost",
    "keybindings-help",
    "login",
    "logout",
    "output-style:new",
    "release-notes",
    "todos",
  ];

  return commands
    .map((command) => {
      const input = command.argumentHint
        ? {
            hint: Array.isArray(command.argumentHint)
              ? command.argumentHint.join(" ")
              : command.argumentHint,
          }
        : null;
      // Normalize command name: remove leading "/" if present
      let name = command.name;
      if (name.startsWith("/")) {
        name = name.slice(1);
      }
      if (name.endsWith(" (MCP)")) {
        name = `mcp:${name.replace(" (MCP)", "")}`;
      }
      return {
        name,
        description: command.description || "",
        input,
      };
    })
    .filter((command: AvailableCommand) => !UNSUPPORTED_COMMANDS.includes(command.name));
}

/**
 * Convert an ACP PromptRequest to CodeBuddy SDK user message
 */
export function promptToCodeBuddy(prompt: PromptRequest): SDKUserMessage {
  const content: any[] = [];
  const context: any[] = [];

  for (const chunk of prompt.prompt) {
    switch (chunk.type) {
      case "text": {
        let text = chunk.text;
        const mcpMatch = text.match(/^\/mcp:([^:\s]+):(\S+)(\s+.*)?$/);
        if (mcpMatch) {
          const [, server, command, args] = mcpMatch;
          text = `/${server}:${command} (MCP)${args || ""}`;
        }
        content.push({ type: "text", text });
        break;
      }
      case "resource_link": {
        content.push({
          type: "text",
          text: chunk.uri,
        });
        break;
      }
      case "resource": {
        if ("text" in chunk.resource) {
          content.push({
            type: "text",
            text: chunk.resource.uri,
          });
          context.push({
            type: "text",
            text: `\n<context ref="${chunk.resource.uri}">\n${chunk.resource.text}\n</context>`,
          });
        }
        break;
      }
      case "image":
        if (chunk.data) {
          content.push({
            type: "image",
            source: {
              type: "base64",
              data: chunk.data,
              media_type: chunk.mimeType,
            },
          });
        } else if (chunk.uri && chunk.uri.startsWith("http")) {
          content.push({
            type: "image",
            source: {
              type: "url",
              url: chunk.uri,
            },
          });
        }
        break;
      default:
        break;
    }
  }

  content.push(...context);

  return {
    type: "user",
    message: {
      role: "user",
      content: content,
    },
    session_id: prompt.sessionId,
    parent_tool_use_id: null,
  };
}

/**
 * Convert SDK messages to ACP SessionNotifications
 */
export function toAcpNotifications(
  content: string | any[],
  role: "assistant" | "user",
  sessionId: string,
  toolUseCache: ToolUseCache,
  client: AgentSideConnection,
  logger: Logger,
  options?: {
    registerHooks?: boolean;
    clientCapabilities?: ClientCapabilities;
    parentToolUseId?: string | null;
    cwd?: string;
  }
): SessionNotification[] {
  const registerHooks = options?.registerHooks !== false;
  const supportsTerminalOutput = options?.clientCapabilities?._meta?.["terminal_output"] === true;

  if (typeof content === "string") {
    const update: SessionNotification["update"] = {
      sessionUpdate: role === "assistant" ? "agent_message_chunk" : "user_message_chunk",
      content: {
        type: "text",
        text: content,
      },
    };

    if (options?.parentToolUseId) {
      update._meta = {
        ...update._meta,
        codebuddy: {
          ...(update._meta?.codebuddy || {}),
          parentToolUseId: options.parentToolUseId,
        },
      };
    }

    return [{ sessionId, update }];
  }

  const output: SessionNotification[] = [];

  for (const chunk of content) {
    let update: SessionNotification["update"] | null = null;

    switch (chunk.type) {
      case "text":
      case "text_delta":
        if (chunk.text) {
          update = {
            sessionUpdate: role === "assistant" ? "agent_message_chunk" : "user_message_chunk",
            content: {
              type: "text",
              text: chunk.text,
            },
          };
        }
        break;

      case "image":
        update = {
          sessionUpdate: role === "assistant" ? "agent_message_chunk" : "user_message_chunk",
          content: {
            type: "image",
            data: chunk.source?.type === "base64" ? chunk.source.data : "",
            mimeType: chunk.source?.type === "base64" ? chunk.source.media_type : "",
            uri: chunk.source?.type === "url" ? chunk.source.url : undefined,
          },
        };
        break;

      case "thinking":
      case "thinking_delta":
        if (chunk.thinking) {
          update = {
            sessionUpdate: "agent_thought_chunk",
            content: {
              type: "text",
              text: chunk.thinking,
            },
          };
        }
        break;

      case "tool_use":
      case "server_tool_use":
      case "mcp_tool_use": {
        const alreadyCached = chunk.id in toolUseCache;
        toolUseCache[chunk.id] = chunk;

        if (chunk.name === "TodoWrite") {
          if (Array.isArray(chunk.input?.todos)) {
            update = {
              sessionUpdate: "plan",
              entries: planEntries(chunk.input as { todos: ClaudePlanEntry[] }),
            };
          }
        } else {
          if (registerHooks && !alreadyCached) {
            registerHookCallback(chunk.id, {
              onPostToolUseHook: async (toolUseId, _toolInput, toolResponse) => {
                const toolUse = toolUseCache[toolUseId];
                if (toolUse) {
                  const editDiff =
                    toolUse.name === "Edit" ? toolUpdateFromEditToolResponse(toolResponse) : {};
                  const updateNotif: SessionNotification["update"] = {
                    _meta: {
                      codebuddy: {
                        toolResponse,
                        toolName: toolUse.name,
                      },
                    } satisfies ToolUpdateMeta,
                    toolCallId: toolUseId,
                    sessionUpdate: "tool_call_update",
                    ...editDiff,
                  };
                  await client.sessionUpdate({
                    sessionId,
                    update: updateNotif,
                  });
                } else {
                  logger.error(
                    `[codebuddy-agent-acp] Got a tool response for tool use that wasn't tracked: ${toolUseId}`
                  );
                }
              },
            });
          }

          let rawInput;
          try {
            rawInput = JSON.parse(JSON.stringify(chunk.input));
          } catch {
            // ignore
          }

          if (alreadyCached) {
            update = {
              _meta: {
                codebuddy: {
                  toolName: chunk.name,
                },
              } satisfies ToolUpdateMeta,
              toolCallId: chunk.id,
              sessionUpdate: "tool_call_update",
              rawInput,
              ...toolInfoFromToolUse(chunk, supportsTerminalOutput, options?.cwd),
            };
          } else {
            update = {
              _meta: {
                codebuddy: {
                  toolName: chunk.name,
                },
                ...(chunk.name === "Bash" && supportsTerminalOutput
                  ? { terminal_info: { terminal_id: chunk.id } }
                  : {}),
              } satisfies ToolUpdateMeta,
              toolCallId: chunk.id,
              sessionUpdate: "tool_call",
              rawInput,
              status: "pending",
              ...toolInfoFromToolUse(chunk, supportsTerminalOutput, options?.cwd),
            };
          }
        }
        break;
      }

      case "tool_result":
      case "mcp_tool_result": {
        const toolUse = toolUseCache[chunk.tool_use_id];
        if (!toolUse) {
          logger.error(
            `[codebuddy-agent-acp] Got a tool result for tool use that wasn't tracked: ${chunk.tool_use_id}`
          );
          break;
        }

        if (toolUse.name !== "TodoWrite") {
          const { _meta: toolMeta, ...toolUpdate } = toolUpdateFromToolResult(
            chunk,
            toolUseCache[chunk.tool_use_id],
            supportsTerminalOutput
          );

          if (toolMeta?.terminal_output) {
            output.push({
              sessionId,
              update: {
                _meta: {
                  terminal_output: toolMeta.terminal_output,
                  ...(options?.parentToolUseId
                    ? { codebuddy: { parentToolUseId: options.parentToolUseId } }
                    : {}),
                },
                toolCallId: chunk.tool_use_id,
                sessionUpdate: "tool_call_update" as const,
              },
            });
          }

          update = {
            _meta: {
              codebuddy: {
                toolName: toolUse.name,
              },
              ...(toolMeta?.terminal_exit ? { terminal_exit: toolMeta.terminal_exit } : {}),
            } satisfies ToolUpdateMeta,
            toolCallId: chunk.tool_use_id,
            sessionUpdate: "tool_call_update",
            status: "is_error" in chunk && chunk.is_error ? "failed" : "completed",
            rawOutput: chunk.content,
            ...toolUpdate,
          };
        }
        break;
      }

      default:
        break;
    }

    if (update) {
      if (options?.parentToolUseId) {
        update._meta = {
          ...update._meta,
          codebuddy: {
            ...(update._meta?.codebuddy || {}),
            parentToolUseId: options.parentToolUseId,
          },
        };
      }
      output.push({ sessionId, update });
    }
  }

  return output;
}

/**
 * Convert stream events to ACP notifications
 */
export function streamEventToAcpNotifications(
  message: any,
  sessionId: string,
  toolUseCache: ToolUseCache,
  client: AgentSideConnection,
  logger: Logger,
  options?: {
    clientCapabilities?: ClientCapabilities;
    cwd?: string;
  }
): SessionNotification[] {
  const event = message.event;
  switch (event?.type) {
    case "content_block_start":
      if (event.content_block?.type === "text" || event.content_block?.type === "thinking") {
        return [];
      }
      return toAcpNotifications(
        [event.content_block],
        "assistant",
        sessionId,
        toolUseCache,
        client,
        logger,
        {
          clientCapabilities: options?.clientCapabilities,
          parentToolUseId: message.parent_tool_use_id,
          cwd: options?.cwd,
        }
      );
    case "content_block_delta":
      return toAcpNotifications(
        [event.delta],
        "assistant",
        sessionId,
        toolUseCache,
        client,
        logger,
        {
          clientCapabilities: options?.clientCapabilities,
          parentToolUseId: message.parent_tool_use_id,
          cwd: options?.cwd,
        }
      );
    case "message_start":
    case "message_delta":
    case "message_stop":
    case "content_block_stop":
      return [];
    default:
      return [];
  }
}

/**
 * Run the ACP agent, reading from stdin and writing to stdout
 */
export function runAcp() {
  const input = nodeToWebWritable(process.stdout);
  const output = nodeToWebReadable(process.stdin);

  const stream = ndJsonStream(input, output);
  new AgentSideConnection((client) => new CodeBuddyAcpAgent(client), stream);
}
