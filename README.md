# codebuddy-agent-acp

An ACP (Agent Client Protocol) compatible coding agent powered by CodeBuddy Agent SDK.

## Overview

This package provides a bridge between the ACP protocol and CodeBuddy Agent SDK, enabling CodeBuddy to work with ACP-compatible clients like Zed editor.

It currently supports ACP session management, prompt streaming, tool call/result conversion, and permission mode synchronization on top of the CodeBuddy Agent SDK.

## Installation

```bash
npm install
npm run build
```

## Usage

### ACP Mode (Default)

Run as an ACP server, communicating via stdin/stdout:

```bash
node dist/index.js
# or
npm start
```

### CLI Mode

Launch the CodeBuddy CLI directly:

```bash
node dist/index.js --cli
```

### Zed Editor Integration

Add to your Zed settings (`~/.config/zed/settings.json`):

```json
{
  "agent_servers": {
    "CodeBuddy": {
      "command": "node",
      "args": ["/path/to/codebuddy-agent-acp/dist/index.js"],
      "env": {}
    }
  }
}
```

## Project Structure

```
src/
├── index.ts        # CLI entry point
├── acp-agent.ts    # Core ACP Agent implementation
├── tools.ts        # Tool mapping and ACP content conversion
├── settings.ts     # Multi-level settings management
├── utils.ts        # Utility functions (Pushable, stream bridges)
└── lib.ts          # Public API exports
```

## Configuration

Settings are loaded from (in order of increasing precedence):

1. User settings: `~/.codebuddy/settings.json`
2. Project settings: `<cwd>/.codebuddy/settings.json`
3. Local project settings: `<cwd>/.codebuddy/settings.local.json`
4. Enterprise managed settings: platform-specific path

## Runtime Notes

- Assistant text and thinking output stream incrementally from `content_block_delta` events, with fallback to completed assistant messages when no deltas are available.
- `tool_use` blocks are still surfaced early during streaming so ACP clients can render tool calls without waiting for the final assistant message.
- Runtime switching to `dontAsk` is currently handled as an ACP-layer compatibility workaround because the current headless CodeBuddy CLI rejects `set_permission_mode: dontAsk`.
- The CLI is spawned with the `--acp` flag alongside `--print` to ensure interactive permission prompts remain available. Without `--acp`, the CLI sets `shouldAvoidPermissionPrompts = true` and silently denies any tool that requires user confirmation.

## Current Status

This is an initial implementation with the following capabilities:

### Implemented

- ACP protocol handler (initialize, newSession, prompt, cancel, session mode/model updates)
- Incremental prompt streaming for assistant text/thinking chunks, with fallback to completed assistant messages
- Tool call/result mapping for common tools (Bash, Read, Write, Edit, Glob, Grep, etc.)
- Settings management with hot-reload support
- Permission mode handling for `default`, `acceptEdits`, `plan`, and `bypassPermissions`, plus ACP-side compatibility handling for runtime `dontAsk` switches
- `AskUserQuestion` interaction: single-select and multi-select questions are forwarded to the ACP client via `requestPermission`, and the user's answers are written back into the tool input before the tool executes
- Regression tests covering prompt streaming, session mode switching, and `AskUserQuestion` interaction (single-select, multi-select, cancel, signal abort)

### TODO

- Session history replay
- Session listing
- Complete tool result mapping for all tool types
- Full backend synchronization for runtime `dontAsk` once the upstream headless CLI supports it

## License

Apache-2.0
