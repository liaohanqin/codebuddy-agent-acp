/**
 * CodeBuddy Agent ACP - Library Exports
 *
 * This module exports the public API for library usage.
 */

// Export the main agent class and utilities
export {
  CodeBuddyAcpAgent,
  runAcp,
  toAcpNotifications,
  streamEventToAcpNotifications,
  promptToCodeBuddy,
  codebuddyCliPath,
  resolvePermissionMode,
  type ToolUpdateMeta,
  type NewSessionMeta,
  type Logger,
  type ToolUseCache,
} from "./acp-agent.js";

// Export utility functions
export {
  loadManagedSettings,
  applyEnvironmentSettings,
  nodeToWebReadable,
  nodeToWebWritable,
  Pushable,
  unreachable,
  sleep,
} from "./utils.js";

// Export tool utilities
export {
  toolInfoFromToolUse,
  toDisplayPath,
  planEntries,
  toolUpdateFromToolResult,
  toolUpdateFromEditToolResponse,
  markdownEscape,
  registerHookCallback,
  createPostToolUseHook,
  type ClaudePlanEntry,
  type BashInput,
  type FileReadInput,
  type FileWriteInput,
  type FileEditInput,
  type GlobInput,
  type GrepInput,
  type WebFetchInput,
  type WebSearchInput,
  type AgentInput,
  type TodoWriteInput,
} from "./tools.js";

// Export settings management
export {
  SettingsManager,
  getManagedSettingsPath,
  CODEBUDDY_CONFIG_DIR,
  type CodeBuddySettings,
  type PermissionSettings,
  type SettingsManagerOptions,
} from "./settings.js";
