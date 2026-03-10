/**
 * Utility classes and functions for codebuddy-agent-acp
 */

import { Readable, Writable } from "node:stream";
import { WritableStream, ReadableStream } from "node:stream/web";
import { readFileSync } from "node:fs";
import type { Logger } from "./acp-agent.js";
import { CodeBuddySettings, getManagedSettingsPath } from "./settings.js";

/**
 * A pushable async iterable: allows you to push items and consume them with for-await.
 * Useful for bridging push-based and async-iterator-based code.
 */
export class Pushable<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private resolvers: ((value: IteratorResult<T>) => void)[] = [];
  private done = false;

  push(item: T) {
    if (this.resolvers.length > 0) {
      const resolve = this.resolvers.shift()!;
      resolve({ value: item, done: false });
    } else {
      this.queue.push(item);
    }
  }

  end() {
    this.done = true;
    while (this.resolvers.length > 0) {
      const resolve = this.resolvers.shift()!;
      resolve({ value: undefined as any, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.queue.length > 0) {
          const value = this.queue.shift()!;
          return Promise.resolve({ value, done: false });
        }
        if (this.done) {
          return Promise.resolve({ value: undefined as any, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.resolvers.push(resolve);
        });
      },
    };
  }
}

/**
 * Convert a Node.js Writable stream to a Web WritableStream
 */
export function nodeToWebWritable(nodeStream: Writable): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        nodeStream.write(Buffer.from(chunk), (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    },
  });
}

/**
 * Convert a Node.js Readable stream to a Web ReadableStream
 */
export function nodeToWebReadable(nodeStream: Readable): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on("data", (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk));
      });
      nodeStream.on("end", () => controller.close());
      nodeStream.on("error", (err) => controller.error(err));
    },
  });
}

/**
 * Type-safe exhaustive check helper
 */
export function unreachable(value: never, logger: Logger = console) {
  let valueAsString;
  try {
    valueAsString = JSON.stringify(value);
  } catch {
    valueAsString = value;
  }
  logger.error(`Unexpected case: ${valueAsString}`);
}

/**
 * Sleep for a given number of milliseconds
 */
export function sleep(time: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, time));
}

/**
 * Load managed settings from the system-wide path
 */
export function loadManagedSettings(): CodeBuddySettings | null {
  try {
    return JSON.parse(readFileSync(getManagedSettingsPath(), "utf8")) as CodeBuddySettings;
  } catch {
    return null;
  }
}

/**
 * Apply environment variables from settings
 */
export function applyEnvironmentSettings(settings: CodeBuddySettings): void {
  if (settings.env) {
    for (const [key, value] of Object.entries(settings.env)) {
      process.env[key] = value;
    }
  }
}
