import { ChildProcess } from 'child_process';

/** Server multiplexing mode */
export type ServerMode = 'stateless' | 'stateful';

/** Original server config from claude.json */
export interface StdioServerConfig {
  type: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Non-stdio server config (passthrough, never rewritten) */
export interface HttpServerConfig {
  type: 'http' | 'sse';
  url: string;
  [key: string]: unknown;
}

export type ServerConfig = StdioServerConfig | HttpServerConfig;

/** Resolved command for direct execution (bypassing npx) */
export interface ResolvedCommand {
  /** Absolute path to the executable */
  command: string;
  /** Arguments to pass */
  args: string[];
  /** Environment variables */
  env: Record<string, string>;
}

/** A managed child process */
export interface ManagedChild {
  /** Server name (e.g., "tavily") */
  name: string;
  /** Child process handle */
  process: ChildProcess;
  /** MCP session that owns this child (null for stateless shared children) */
  sessionId: string | null;
  /** Whether the child is ready (received first stdout) */
  ready: boolean;
  /** Pending requests waiting for responses, keyed by JSON-RPC id */
  pending: Map<string | number, PendingRequest>;
  /** Buffered stdout data (partial JSON-RPC messages) */
  stdoutBuffer: string;
  /** When child was spawned */
  spawnedAt: number;
  /** Number of requests served */
  requestCount: number;
  /** Timestamp of last request or notification (for idle reaping) */
  lastActivityAt: number;
  /**
   * MCP initialization gate. Resolves after notifications/initialized
   * has been sent and the child has had time to process it.
   * Requests wait on this before being forwarded, preventing the race
   * where a tool call arrives before the server finishes initializing.
   */
  initGate: Promise<void>;
  /** Resolve function for initGate (called after notifications/initialized is forwarded) */
  resolveInitGate: () => void;
}

/** A pending JSON-RPC request waiting for a response */
export interface PendingRequest {
  resolve: (response: JsonRpcResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
  sentAt: number;
}

/** JSON-RPC 2.0 request */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: unknown;
}

/** JSON-RPC 2.0 response */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/** JSON-RPC 2.0 notification (no id) */
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

/** Known AI coding tool identifiers */
export type AiToolId =
  | 'claude'
  | 'cursor'
  | 'windsurf'
  | 'cline'
  | 'copilot'
  | 'codex'
  | 'gemini'
  | 'opencode'
  | 'aider'
  | 'custom';

/** A registered AI client with its config path */
export interface AiClientEntry {
  /** AI tool identifier */
  tool: AiToolId;
  /** Absolute path to the tool's MCP config file */
  configPath: string;
  /** When this client was registered */
  registeredAt: number;
  /** Number of servers rewritten for this client */
  serverCount: number;
}

/** Per-tool call statistics (in-memory, resets on restart) */
export interface ToolStats {
  /** Total successful calls */
  calls: number;
  /** Total errors */
  errors: number;
  /** Total elapsed milliseconds (for computing avg) */
  totalMs: number;
  /** Average latency in milliseconds */
  avgMs: number;
  /** P99 latency in milliseconds */
  p99Ms: number;
  /** Error rate: errors / (calls + errors) */
  errorRate: number;
  /** Last call timestamp */
  lastCalledAt: number;
  /** MCP server that provides this tool */
  server?: string;
}

/** A single minute bucket of activity for the timeline chart */
export interface MinuteBucket {
  /** Unix timestamp floored to minute boundary */
  minuteTs: number;
  /** Total requests in this minute */
  requests: number;
  /** Total errors in this minute */
  errors: number;
  /** Total latency in ms */
  totalMs: number;
  /** Per-server request counts */
  perServer: Record<string, number>;
}

/** Detailed server info for the dashboard */
export interface ServerDetail {
  name: string;
  mode: ServerMode;
  activeChildren: number;
  totalRequests: number;
  status: 'running' | 'idle' | 'error';
  enabled: boolean;
  command: string;
  lastActivityAt: number;
  /** Where this server was registered from */
  source: 'global' | 'project';
  /** Config file path (project path for project servers, empty for global) */
  configPath: string;
}

/** Active session info for the dashboard */
export interface SessionInfo {
  sessionId: string;
  clientPid: number | null;
  servers: string[];
  lastActivityAt: number;
  childCount: number;
}

/** Aggregated gateway stats returned by GET /api/health/stats */
export interface GatewayStats {
  uptimeSeconds: number;
  totalRequests: number;
  totalErrors: number;
  toolStats: Record<string, ToolStats>;
  activeConnections: number;
  memoryServiceHealthy: boolean;
  servers: ServerDetail[];
  sessions: SessionInfo[];
  clients: AiClientEntry[];
  timeline: MinuteBucket[];
  gatewayEnabled: boolean;
  memoryMB: number;
}

/** Gateway runtime state persisted to state.json */
export interface GatewayState {
  pid: number;
  port: number;
  startedAt: number;
  servers: string[];
  /** Registered AI clients (multi-AI support) */
  clients?: AiClientEntry[];
}

/** Backup entry for config restoration */
export interface ConfigBackup {
  /** Timestamp when backup was taken */
  backedAt: number;
  /** Original mcpServers entries (only stdio ones that were rewritten) */
  servers: Record<string, StdioServerConfig>;
}

/** Project config backup */
export interface ProjectConfigBackup {
  /** Absolute path to the .mcp.json file */
  configPath: string;
  /** Project hash for identification */
  projectHash: string;
  /** Timestamp when backup was taken */
  backedAt: number;
  /** Original mcpServers entries */
  servers: Record<string, StdioServerConfig>;
}

/** NPX cache entry */
export interface NpxCacheEntry {
  /** Original command (e.g., "npx") */
  originalCommand: string;
  /** Original args (e.g., ["-y", "@upstash/context7-mcp"]) */
  originalArgs: string[];
  /** Resolved absolute path to the executable */
  resolvedPath: string;
  /** Resolved args for direct execution */
  resolvedArgs: string[];
  /** When this was resolved */
  resolvedAt: number;
}

/** Health response */
export interface HealthInfo {
  status: 'ok' | 'degraded' | 'starting' | 'error';
  version: string;
  uptime: number;
  port: number;
  servers: {
    name: string;
    mode: ServerMode;
    activeChildren: number;
    totalRequests: number;
  }[];
  totalChildren: number;
  memoryMB: number;
  /** Registered AI clients */
  clients?: AiClientEntry[];
}

/** Server classification entry */
export interface ClassificationEntry {
  mode: ServerMode;
  /** Optional timeout for requests in ms (default: 120000) */
  requestTimeout?: number;
}

/** Gateway configuration */
export interface GatewayConfig {
  port: number;
  configPath: string;
  stateDir: string;
  logFile: string;
  /** Whether to run in foreground (for debugging) */
  foreground?: boolean;
}

/** Logger interface */
export interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug: (msg: string) => void;
}
