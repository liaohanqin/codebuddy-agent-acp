#!/usr/bin/env node

/**
 * CodeBuddy Agent ACP - CLI Entry Point
 *
 * This is the main entry point for the CodeBuddy Agent ACP executable.
 * It supports two modes:
 * - ACP mode (default): Runs as an ACP server, communicating via stdin/stdout
 * - CLI mode (--cli): Launches the CodeBuddy CLI directly
 */

import { loadManagedSettings, applyEnvironmentSettings } from "./utils.js";
import { codebuddyCliPath, runAcp } from "./acp-agent.js";

async function main() {
  if (process.argv.includes("--cli")) {
    // Remove --cli from argv and launch CodeBuddy CLI
    process.argv = process.argv.filter((arg) => arg !== "--cli");
    const cliPath = await codebuddyCliPath();
    await import(cliPath);
  } else {
    // Load managed settings and apply environment variables
    const managedSettings = loadManagedSettings();
    if (managedSettings) {
      applyEnvironmentSettings(managedSettings);
    }

    // stdout is used to send messages to the client
    // we redirect everything else to stderr to make sure it doesn't interfere with ACP
    console.log = console.error;
    console.info = console.error;
    console.warn = console.error;
    console.debug = console.error;

    process.on("unhandledRejection", (reason, promise) => {
      console.error("Unhandled Rejection at:", promise, "reason:", reason);
    });

    // Start ACP server
    runAcp();

    // Keep process alive
    process.stdin.resume();
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
