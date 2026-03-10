/**
 * Tool mapping and ACP content conversion utilities
 */

import path from "node:path";
import type {
  ContentBlock,
  PlanEntry,
  ToolCallContent,
  ToolCallLocation,
  ToolKind,
} from "@agentclientprotocol/sdk";
import type { Logger } from "./acp-agent.js";

// Tool input type definitions (minimal subset for compilation)
export interface BashInput {
  command?: string;
  description?: string;
}

export interface FileReadInput {
  file_path?: string;
  offset?: number;
  limit?: number;
}

export interface FileWriteInput {
  file_path?: string;
  content?: string;
}

export interface FileEditInput {
  file_path?: string;
  old_string?: string;
  new_string?: string;
}

export interface GlobInput {
  pattern?: string;
  path?: string;
}

export interface GrepInput {
  pattern?: string;
  path?: string;
  glob?: string;
  type?: string;
  output_mode?: string;
  head_limit?: number;
  multiline?: boolean;
  "-i"?: boolean;
  "-n"?: boolean;
  "-A"?: number;
  "-B"?: number;
  "-C"?: number;
}

export interface WebFetchInput {
  url?: string;
  prompt?: string;
}

export interface WebSearchInput {
  query: string;
  allowed_domains?: string[];
  blocked_domains?: string[];
}

export interface AgentInput {
  description?: string;
  prompt?: string;
}

export interface TodoWriteInput {
  todos?: ClaudePlanEntry[];
}

interface ToolInfo {
  title: string;
  kind: ToolKind;
  content: ToolCallContent[];
  locations?: ToolCallLocation[];
}

interface ToolUpdate {
  title?: string;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
  _meta?: {
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
}

/**
 * Convert an absolute file path to a project-relative path for display.
 */
export function toDisplayPath(filePath: string, cwd?: string): string {
  if (!cwd) {
    return filePath;
  }
  const resolvedCwd = path.resolve(cwd);
  const resolvedFile = path.resolve(filePath);
  if (resolvedFile.startsWith(resolvedCwd + path.sep) || resolvedFile === resolvedCwd) {
    return path.relative(resolvedCwd, resolvedFile);
  }
  return filePath;
}

/**
 * Extract tool info from a tool use block for ACP display
 */
export function toolInfoFromToolUse(
  toolUse: any,
  supportsTerminalOutput: boolean = false,
  cwd?: string
): ToolInfo {
  const name = toolUse.name;

  switch (name) {
    case "Agent":
    case "Task": {
      const input = toolUse.input as AgentInput | BashInput;
      return {
        title: input?.description ? input.description : "Task",
        kind: "think",
        content:
          input && "prompt" in input && input.prompt
            ? [
                {
                  type: "content",
                  content: { type: "text", text: input.prompt },
                },
              ]
            : [],
      };
    }

    case "Bash": {
      const input = toolUse.input as BashInput;
      return {
        title: input?.command ? input.command : "Terminal",
        kind: "execute",
        content: supportsTerminalOutput
          ? [{ type: "terminal" as const, terminalId: toolUse.id }]
          : input && input.description
            ? [
                {
                  type: "content",
                  content: { type: "text", text: input.description },
                },
              ]
            : [],
      };
    }

    case "Read": {
      const input = toolUse.input as FileReadInput;
      let limit = "";
      if (input.limit && input.limit > 0) {
        limit = " (" + (input.offset ?? 1) + " - " + ((input.offset ?? 1) + input.limit - 1) + ")";
      } else if (input.offset) {
        limit = " (from line " + input.offset + ")";
      }
      const displayPath = input.file_path ? toDisplayPath(input.file_path, cwd) : "File";
      return {
        title: "Read " + displayPath + limit,
        kind: "read",
        locations: input.file_path
          ? [
              {
                path: input.file_path,
                line: input.offset ?? 1,
              },
            ]
          : [],
        content: [],
      };
    }

    case "Write": {
      const input = toolUse.input as FileWriteInput;
      let content: ToolCallContent[] = [];
      if (input && input.file_path && input.content) {
        content = [
          {
            type: "diff",
            path: input.file_path,
            oldText: null,
            newText: input.content,
          },
        ];
      } else if (input && input.content) {
        content = [
          {
            type: "content",
            content: { type: "text", text: input.content },
          },
        ];
      }
      const displayPath = input?.file_path ? toDisplayPath(input.file_path, cwd) : undefined;
      return {
        title: displayPath ? `Write ${displayPath}` : "Write",
        kind: "edit",
        content,
        locations: input?.file_path ? [{ path: input.file_path }] : [],
      };
    }

    case "Edit": {
      const input = toolUse.input as FileEditInput;
      let content: ToolCallContent[] = [];
      if (input && input.file_path && (input.old_string || input.new_string)) {
        content = [
          {
            type: "diff",
            path: input.file_path,
            oldText: input.old_string || null,
            newText: input.new_string ?? "",
          },
        ];
      }
      const displayPath = input?.file_path ? toDisplayPath(input.file_path, cwd) : undefined;
      return {
        title: displayPath ? `Edit ${displayPath}` : "Edit",
        kind: "edit",
        content,
        locations: input?.file_path ? [{ path: input.file_path }] : [],
      };
    }

    case "Glob": {
      const input = toolUse.input as GlobInput;
      let label = "Find";
      if (input.path) {
        label += ` \`${input.path}\``;
      }
      if (input.pattern) {
        label += ` \`${input.pattern}\``;
      }
      return {
        title: label,
        kind: "search",
        content: [],
        locations: input.path ? [{ path: input.path }] : [],
      };
    }

    case "Grep": {
      const input = toolUse.input as GrepInput;
      let label = "grep";

      if (input["-i"]) {
        label += " -i";
      }
      if (input["-n"]) {
        label += " -n";
      }
      if (input["-A"] !== undefined) {
        label += ` -A ${input["-A"]}`;
      }
      if (input["-B"] !== undefined) {
        label += ` -B ${input["-B"]}`;
      }
      if (input["-C"] !== undefined) {
        label += ` -C ${input["-C"]}`;
      }
      if (input.output_mode) {
        switch (input.output_mode) {
          case "files_with_matches":
            label += " -l";
            break;
          case "count":
            label += " -c";
            break;
          default:
            break;
        }
      }
      if (input.head_limit !== undefined) {
        label += ` | head -${input.head_limit}`;
      }
      if (input.glob) {
        label += ` --include="${input.glob}"`;
      }
      if (input.type) {
        label += ` --type=${input.type}`;
      }
      if (input.multiline) {
        label += " -P";
      }
      if (input.pattern) {
        label += ` "${input.pattern}"`;
      }
      if (input.path) {
        label += ` ${input.path}`;
      }

      return {
        title: label,
        kind: "search",
        content: [],
      };
    }

    case "WebFetch": {
      const input = toolUse.input as WebFetchInput;
      return {
        title: input?.url ? `Fetch ${input.url}` : "Fetch",
        kind: "fetch",
        content:
          input && input.prompt
            ? [
                {
                  type: "content",
                  content: { type: "text", text: input.prompt },
                },
              ]
            : [],
      };
    }

    case "WebSearch": {
      const input = toolUse.input as WebSearchInput;
      let label = `"${input.query}"`;

      if (input.allowed_domains && input.allowed_domains.length > 0) {
        label += ` (allowed: ${input.allowed_domains.join(", ")})`;
      }

      if (input.blocked_domains && input.blocked_domains.length > 0) {
        label += ` (blocked: ${input.blocked_domains.join(", ")})`;
      }

      return {
        title: label,
        kind: "fetch",
        content: [],
      };
    }

    case "TodoWrite": {
      const input = toolUse.input as TodoWriteInput;
      return {
        title: Array.isArray(input?.todos)
          ? `Update TODOs: ${input.todos.map((todo: any) => todo.content).join(", ")}`
          : "Update TODOs",
        kind: "think",
        content: [],
      };
    }

    case "ExitPlanMode": {
      return {
        title: "Ready to code?",
        kind: "switch_mode",
        content: [],
      };
    }

    default:
      return {
        title: name || "Unknown Tool",
        kind: "other",
        content: [],
      };
  }
}

/**
 * Convert tool result to ACP content update
 */
export function toolUpdateFromToolResult(
  toolResult: any,
  toolUse: any,
  supportsTerminalOutput: boolean = false
): ToolUpdate {
  const isError = "is_error" in toolResult && toolResult.is_error;

  if (isError && toolResult.content && toolResult.content.length > 0) {
    return toAcpContentUpdate(toolResult.content, true);
  }

  switch (toolUse?.name) {
    case "Read":
      if (Array.isArray(toolResult.content) && toolResult.content.length > 0) {
        return {
          content: toolResult.content.map((content: any) => ({
            type: "content",
            content:
              content.type === "text"
                ? {
                    type: "text",
                    text: markdownEscape(content.text),
                  }
                : toAcpContentBlock(content, false),
          })),
        };
      } else if (typeof toolResult.content === "string" && toolResult.content.length > 0) {
        return {
          content: [
            {
              type: "content",
              content: {
                type: "text",
                text: markdownEscape(toolResult.content),
              },
            },
          ],
        };
      }
      return {};

    case "Bash": {
      const result = toolResult.content;
      const terminalId = "tool_use_id" in toolResult ? String(toolResult.tool_use_id) : "";

      let output = "";
      let exitCode = isError ? 1 : 0;

      if (typeof result === "string") {
        output = result;
      } else if (
        Array.isArray(result) &&
        result.length > 0 &&
        "text" in result[0] &&
        typeof result[0].text === "string"
      ) {
        output = result.map((c: any) => c.text).join("\n");
      }

      if (supportsTerminalOutput) {
        return {
          content: [{ type: "terminal" as const, terminalId }],
          _meta: {
            terminal_info: {
              terminal_id: terminalId,
            },
            terminal_output: {
              terminal_id: terminalId,
              data: output,
            },
            terminal_exit: {
              terminal_id: terminalId,
              exit_code: exitCode,
              signal: null,
            },
          },
        };
      }

      if (output.trim()) {
        return {
          content: [
            {
              type: "content",
              content: {
                type: "text",
                text: `\`\`\`console\n${output.trimEnd()}\n\`\`\``,
              },
            },
          ],
        };
      }
      return {};
    }

    case "Edit":
    case "Write": {
      return {};
    }

    case "ExitPlanMode": {
      return { title: "Exited Plan Mode" };
    }

    default: {
      return toAcpContentUpdate(toolResult.content, isError);
    }
  }
}

function toAcpContentUpdate(content: any, isError: boolean = false): { content?: ToolCallContent[] } {
  if (Array.isArray(content) && content.length > 0) {
    return {
      content: content.map((c: any) => ({
        type: "content" as const,
        content: toAcpContentBlock(c, isError),
      })),
    };
  } else if (typeof content === "object" && content !== null && "type" in content) {
    return {
      content: [
        {
          type: "content" as const,
          content: toAcpContentBlock(content, isError),
        },
      ],
    };
  } else if (typeof content === "string" && content.length > 0) {
    return {
      content: [
        {
          type: "content",
          content: {
            type: "text",
            text: isError ? `\`\`\`\n${content}\n\`\`\`` : content,
          },
        },
      ],
    };
  }
  return {};
}

function toAcpContentBlock(content: any, isError: boolean): ContentBlock {
  const wrapText = (text: string): ContentBlock => ({
    type: "text" as const,
    text: isError ? `\`\`\`\n${text}\n\`\`\`` : text,
  });

  switch (content.type) {
    case "text":
      return {
        type: "text" as const,
        text: isError ? `\`\`\`\n${content.text}\n\`\`\`` : content.text,
      };
    case "image":
      if (content.source?.type === "base64") {
        return {
          type: "image" as const,
          data: content.source.data,
          mimeType: content.source.media_type,
        };
      }
      return wrapText("[image]");
    default:
      return wrapText(JSON.stringify(content));
  }
}

export type ClaudePlanEntry = {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
};

export function planEntries(input: { todos: ClaudePlanEntry[] }): PlanEntry[] {
  return input.todos.map((todo) => ({
    content: todo.content,
    status: todo.status,
    priority: "medium",
  }));
}

export function markdownEscape(text: string): string {
  let escape = "```";
  for (const [m] of text.matchAll(/^```+/gm)) {
    while (m.length >= escape.length) {
      escape += "`";
    }
  }
  return escape + "\n" + text + (text.endsWith("\n") ? "" : "\n") + escape;
}

/**
 * Builds diff ToolUpdate content from the structured Edit toolResponse
 */
export function toolUpdateFromEditToolResponse(toolResponse: unknown): {
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
} {
  if (!toolResponse || typeof toolResponse !== "object") {
    return {};
  }
  const response = toolResponse as { filePath?: string; structuredPatch?: any[] };
  if (!response.filePath || !Array.isArray(response.structuredPatch)) {
    return {};
  }

  const content: ToolCallContent[] = [];
  const locations: ToolCallLocation[] = [];

  for (const { lines, newStart } of response.structuredPatch) {
    const oldText: string[] = [];
    const newText: string[] = [];
    for (const line of lines) {
      if (line.startsWith("-")) {
        oldText.push(line.slice(1));
      } else if (line.startsWith("+")) {
        newText.push(line.slice(1));
      } else {
        oldText.push(line.slice(1));
        newText.push(line.slice(1));
      }
    }
    if (oldText.length > 0 || newText.length > 0) {
      locations.push({ path: response.filePath, line: newStart });
      content.push({
        type: "diff",
        path: response.filePath,
        oldText: oldText.join("\n") || null,
        newText: newText.join("\n"),
      });
    }
  }

  const result: { content?: ToolCallContent[]; locations?: ToolCallLocation[] } = {};
  if (content.length > 0) {
    result.content = content;
  }
  if (locations.length > 0) {
    result.locations = locations;
  }
  return result;
}

/* Global callbacks for tool use hooks */
const toolUseCallbacks: {
  [toolUseId: string]: {
    onPostToolUseHook?: (
      toolUseID: string,
      toolInput: unknown,
      toolResponse: unknown
    ) => Promise<void>;
  };
} = {};

export const registerHookCallback = (
  toolUseID: string,
  {
    onPostToolUseHook,
  }: {
    onPostToolUseHook?: (
      toolUseID: string,
      toolInput: unknown,
      toolResponse: unknown
    ) => Promise<void>;
  }
) => {
  toolUseCallbacks[toolUseID] = {
    onPostToolUseHook,
  };
};

/**
 * Create a PostToolUse hook callback
 */
export const createPostToolUseHook =
  (
    logger: Logger = console,
    options?: {
      onEnterPlanMode?: () => Promise<void>;
    }
  ) =>
  async (input: any, toolUseID: string | undefined): Promise<{ continue: boolean }> => {
    if (input.hook_event_name === "PostToolUse") {
      if (input.tool_name === "EnterPlanMode" && options?.onEnterPlanMode) {
        await options.onEnterPlanMode();
      }

      if (toolUseID) {
        const onPostToolUseHook = toolUseCallbacks[toolUseID]?.onPostToolUseHook;
        if (onPostToolUseHook) {
          await onPostToolUseHook(toolUseID, input.tool_input, input.tool_response);
          delete toolUseCallbacks[toolUseID];
        } else {
          logger.error(`No onPostToolUseHook found for tool use ID: ${toolUseID}`);
          delete toolUseCallbacks[toolUseID];
        }
      }
    }
    return { continue: true };
  };
