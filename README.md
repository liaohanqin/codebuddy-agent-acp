# codebuddy-agent-acp

An ACP (Agent Client Protocol) compatible coding agent powered by CodeBuddy Agent SDK.

## Overview

This package provides a bridge between the ACP protocol and CodeBuddy Agent SDK, enabling CodeBuddy to work with ACP-compatible clients like Zed editor.

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

## Current Status

This is an initial implementation with the following capabilities:

### Implemented

- ACP protocol handler (initialize, newSession, prompt, cancel)
- Session management (create, mode switching, model switching)
- Tool result mapping for common tools (Bash, Read, Write, Edit, Glob, Grep, etc.)
- Settings management with hot-reload support
- Permission mode handling (default, acceptEdits, plan, bypassPermissions)

### TODO

- Full CodeBuddy SDK integration (currently using mock query)
- Session history replay
- Session listing
- Complete tool result mapping for all tool types
- Unit tests

## License

Apache-2.0
