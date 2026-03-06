import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

type ToolContent = CallToolResult['content'][number];

function safeStringify(value: unknown, maxLen?: number): string {
  try {
    const seen = new WeakSet();
    const text = JSON.stringify(
      value,
      (_key, val) => {
        if (typeof val === 'object' && val !== null) {
          if (seen.has(val)) return '[Circular]';
          seen.add(val);
        }
        return val;
      },
      2
    );
    if (typeof maxLen === 'number' && maxLen > 0 && text.length > maxLen) {
      return text.slice(0, maxLen) + '...';
    }
    return text;
  } catch {
    return String(value ?? '');
  }
}

export function isCallToolResult(value: unknown): value is CallToolResult {
  if (!value || typeof value !== 'object') return false;
  const v = value as CallToolResult;
  return Array.isArray(v.content);
}

export function toTextResult(value: unknown, opts?: { isError?: boolean }): CallToolResult {
  const text = typeof value === 'string' ? value : safeStringify(value);
  const content: ToolContent[] = [{ type: 'text', text }];
  if (opts?.isError) return { content, isError: true };
  return { content };
}

export function toErrorResult(value: unknown): CallToolResult {
  return toTextResult(value, { isError: true });
}

export function ensureCallToolResult(value: unknown): CallToolResult {
  if (isCallToolResult(value)) return value;
  return toTextResult(value);
}
