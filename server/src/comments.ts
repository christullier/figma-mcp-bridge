/**
 * Figma comments live outside the plugin sandbox — the Plugin API exposes no
 * comment surface at all, so these tools talk to the Figma REST API directly
 * instead of going through the WebSocket bridge. The only thing the bridge
 * contributes is fileKey resolution (see resolveFileKey in tools.ts).
 *
 * Auth is a Figma personal access token in FIGMA_TOKEN (FIGMA_ACCESS_TOKEN and
 * FIGMA_PERSONAL_ACCESS_TOKEN are accepted as aliases). Comment tools are the
 * only part of this server that needs one.
 */

const FIGMA_API_BASE = "https://api.figma.com/v1";
const REQUEST_TIMEOUT_MS = 15_000;

const TOKEN_ENV_VARS = [
  "FIGMA_TOKEN",
  "FIGMA_ACCESS_TOKEN",
  "FIGMA_PERSONAL_ACCESS_TOKEN",
] as const;

export interface CommentAnchor {
  nodeId?: string;
  x?: number;
  y?: number;
}

export interface RawComment {
  id: string;
  parent_id?: string;
  message: string;
  created_at: string;
  resolved_at?: string | null;
  user?: { handle?: string; email?: string };
  client_meta?: unknown;
  order_id?: string | null;
}

export interface ThreadedComment {
  id: string;
  message: string;
  author: string;
  createdAt: string;
  resolvedAt: string | null;
  anchor: unknown;
  replies: Array<{
    id: string;
    message: string;
    author: string;
    createdAt: string;
  }>;
}

/**
 * Reads the Figma personal access token from the environment.
 * @returns The token string.
 * @throws If no token env var is set.
 */
function requireToken(): string {
  for (const name of TOKEN_ENV_VARS) {
    const value = process.env[name];
    if (value && value.trim()) return value.trim();
  }
  throw new Error(
    `Figma comments require a personal access token. Set FIGMA_TOKEN in the MCP server env ` +
      `(create one at Figma → Settings → Security → Personal access tokens, with the "File comments" scope).`
  );
}

/**
 * Calls the Figma REST API with auth, a timeout, and readable error messages.
 * @param method - HTTP method.
 * @param path - API path below /v1, e.g. "/files/abc/comments".
 * @param body - Optional JSON body.
 * @returns The parsed JSON response.
 */
async function figmaFetch(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown
): Promise<unknown> {
  const token = requireToken();
  const headers: Record<string, string> = { "X-Figma-Token": token };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetch(`${FIGMA_API_BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(describeApiError(response.status, text));
  }

  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Figma API returned non-JSON response: ${text.slice(0, 200)}`);
  }
}

/**
 * Turns a Figma API failure into a message that says what to do about it.
 * @param status - HTTP status code.
 * @param text - Raw response body.
 * @returns A human-readable error message.
 */
function describeApiError(status: number, text: string): string {
  let detail = text.slice(0, 300);
  try {
    const parsed = JSON.parse(text) as { err?: string; message?: string };
    detail = parsed.err ?? parsed.message ?? detail;
  } catch {
    // keep the raw body
  }

  if (status === 403) {
    return `Figma API 403: ${detail}. The token needs the "File comments" scope (write access too, for posting) and access to this file.`;
  }
  if (status === 404) {
    return `Figma API 404: ${detail}. The fileKey may be wrong, or the token's account cannot see that file.`;
  }
  if (status === 429) {
    return `Figma API 429 (rate limited): ${detail}. Wait a moment and retry.`;
  }
  return `Figma API ${status}: ${detail}`;
}

/**
 * Fetches a file's comments and nests replies under their parent thread.
 * @param fileKey - The Figma file key.
 * @param includeResolved - Whether to keep threads that have been resolved.
 * @returns Top-level comment threads, oldest first.
 */
export async function getComments(
  fileKey: string,
  includeResolved: boolean
): Promise<ThreadedComment[]> {
  const payload = (await figmaFetch(
    "GET",
    `/files/${encodeURIComponent(fileKey)}/comments?as_md=true`
  )) as { comments?: RawComment[] };

  const comments = payload.comments ?? [];
  const threads = new Map<string, ThreadedComment>();

  for (const c of comments) {
    if (c.parent_id) continue;
    threads.set(c.id, {
      id: c.id,
      message: c.message,
      author: c.user?.handle ?? "unknown",
      createdAt: c.created_at,
      resolvedAt: c.resolved_at ?? null,
      anchor: c.client_meta ?? null,
      replies: [],
    });
  }

  for (const c of comments) {
    if (!c.parent_id) continue;
    const thread = threads.get(c.parent_id);
    if (!thread) continue;
    thread.replies.push({
      id: c.id,
      message: c.message,
      author: c.user?.handle ?? "unknown",
      createdAt: c.created_at,
    });
  }

  const result = [...threads.values()].filter(
    (t) => includeResolved || t.resolvedAt === null
  );

  for (const thread of result) {
    thread.replies.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  result.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return result;
}

/**
 * Posts a new comment thread or a reply to an existing one.
 * @param fileKey - The Figma file key.
 * @param message - Comment body (Figma renders it as plain text).
 * @param replyToCommentId - When set, posts as a reply instead of a new thread.
 * @param anchor - Optional pin position; a node ID pins to that node, x/y pins to the canvas.
 * @returns The created comment as returned by Figma.
 */
export async function postComment(
  fileKey: string,
  message: string,
  replyToCommentId?: string,
  anchor?: CommentAnchor
): Promise<unknown> {
  const body: Record<string, unknown> = { message };
  if (replyToCommentId) body.comment_id = replyToCommentId;

  // client_meta and comment_id are mutually exclusive: replies inherit the
  // parent thread's pin, so Figma rejects an anchor on a reply.
  if (anchor && !replyToCommentId) {
    const clientMeta = buildClientMeta(anchor);
    if (clientMeta) body.client_meta = clientMeta;
  }

  return figmaFetch(
    "POST",
    `/files/${encodeURIComponent(fileKey)}/comments`,
    body
  );
}

/**
 * Builds the client_meta pin payload for a new comment.
 * @param anchor - Node and/or canvas coordinates.
 * @returns A client_meta object, or undefined when nothing was specified.
 */
function buildClientMeta(anchor: CommentAnchor): Record<string, unknown> | undefined {
  if (anchor.nodeId) {
    return {
      node_id: anchor.nodeId,
      node_offset: { x: anchor.x ?? 0, y: anchor.y ?? 0 },
    };
  }
  if (anchor.x !== undefined && anchor.y !== undefined) {
    return { x: anchor.x, y: anchor.y };
  }
  return undefined;
}

/**
 * Deletes a comment. Deleting a thread's root removes its replies too.
 * @param fileKey - The Figma file key.
 * @param commentId - The comment to delete.
 */
export async function deleteComment(
  fileKey: string,
  commentId: string
): Promise<void> {
  await figmaFetch(
    "DELETE",
    `/files/${encodeURIComponent(fileKey)}/comments/${encodeURIComponent(commentId)}`
  );
}

/**
 * Adds or removes an emoji reaction on a comment.
 * @param fileKey - The Figma file key.
 * @param commentId - The comment to react to.
 * @param emoji - The emoji shortcode, e.g. ":eyes:".
 * @param remove - When true, removes the reaction instead of adding it.
 */
export async function reactToComment(
  fileKey: string,
  commentId: string,
  emoji: string,
  remove: boolean
): Promise<unknown> {
  const path = `/files/${encodeURIComponent(fileKey)}/comments/${encodeURIComponent(
    commentId
  )}/reactions`;
  if (remove) {
    return figmaFetch("DELETE", `${path}?emoji=${encodeURIComponent(emoji)}`);
  }
  return figmaFetch("POST", path, { emoji });
}
