import type { ConversationView } from "../session/state.js";
import type { AuthorizationStatus } from "../auth/store.js";
import type { LegacyMigrationResult } from "../config/legacy-migration.js";
import { DEFAULT_CONNECTOR_NAME, normalizePublicUrl } from "../config/endpoint.js";

export const DOCTOR_CONTRACT_VERSION = 1 as const;

export type DoctorOutcome =
  | "healthy"
  | "repaired"
  | "busy"
  | "user_action_required"
  | "blocked"
  | "unknown";

export type DoctorReason =
  | "all_checks_passed"
  | "local_repairs_completed"
  | "recovery_in_progress"
  | "bridge_stopped"
  | "transport_down"
  | "endpoint_changed"
  | "connector_missing"
  | "auth_required"
  | "auth_refresh_required"
  | "invalid_client"
  | "workspace_denied"
  | "conversation_missing"
  | "legacy_session_ambiguous"
  | "cloudflare_login_required"
  | "chatgpt_login_required"
  | "administrator_approval_required"
  | "cloudflared_missing"
  | "probe_inconclusive"
  | "checks_failed";

export type DoctorNextAction =
  | { type: "none" }
  | { type: "retry_wait"; reason: DoctorReason }
  | { type: "cloudflare_login"; reason: DoctorReason }
  | {
      type: "replace_connector";
      reason: DoctorReason;
      page: string;
      createPage: string;
      connectorName: string;
      endpoint: string | null;
    }
  | { type: "authorize_oauth"; reason: DoctorReason; page: string }
  | { type: "chatgpt_login"; reason: DoctorReason; page: string }
  | { type: "open_conversation"; reason: DoctorReason; page?: string }
  | { type: "create_conversation"; reason: DoctorReason; page?: string }
  | { type: "administrator_approval"; reason: DoctorReason; page: string }
  | { type: "manual_recovery"; reason: DoctorReason };

export interface DoctorCheck {
  ok: boolean;
  detail?: string;
}

export interface DoctorChatgptRepair {
  needed: boolean;
  reason?: string;
  connectorAction: "none" | "create" | "update";
  connectorName: string;
  userMessage?: string;
  mcpUrl: string | null;
  previousMcpUrl: string | null;
  pages: {
    developerMode: string;
    plugins: string;
    createConnector: string;
  };
}

export interface DoctorNamedRepair {
  needed: boolean;
  userMessage?: string;
}

export interface DoctorEndpointIdentity {
  changed: boolean;
  previousFingerprint: string | null;
  currentFingerprint: string | null;
}

export interface DoctorTunnelResult {
  provider: string | null;
  component: "available" | "missing" | "unknown";
  cloudflareLogin: "ready" | "required" | "not_applicable" | "not_checked";
  publicHealth: "passed" | "failed" | "unknown" | "not_checked";
}

export interface DoctorWorkspaceIdentity {
  id: string | null;
  name: string | null;
}

export interface DoctorRequestedWorkspaceIdentity extends DoctorWorkspaceIdentity {
  reference: string;
}

export interface DoctorBridgeObservation {
  state: "healthy" | "stopped" | "unknown" | "not_checked";
  reason: "runtime_missing" | "pid_missing" | "probe_failed" | "pid_unknown" | "workspace_mismatch" | null;
}

export type DoctorAuthorizationResult =
  | AuthorizationStatus
  | {
      state: "not_configured" | "unreachable";
      clientId: null;
      proof: null;
      recoverable: false;
    };

export function authorizationDisposition(
  authorization: DoctorAuthorizationResult
): "usable" | "retry" | "authorize" {
  if (authorization.state === "healthy" || authorization.state === "not_configured") {
    return "usable";
  }
  if (
    authorization.state === "unreachable" ||
    authorization.state === "unverified" ||
    (authorization.state === "expired" && authorization.recoverable)
  ) {
    return "retry";
  }
  return "authorize";
}

export interface DoctorResult {
  version: typeof DOCTOR_CONTRACT_VERSION;
  outcome: DoctorOutcome;
  reason: DoctorReason;
  repairs: string[];
  safeRetry: boolean;
  nextAction: DoctorNextAction;
  requestedWorkspace: DoctorRequestedWorkspaceIdentity;
  activeWorkspace: DoctorWorkspaceIdentity | null;
  bridgeObservation: DoctorBridgeObservation;
  conversation: DoctorConversationDisposition | null;
  endpointIdentity: DoctorEndpointIdentity;
  tunnel: DoctorTunnelResult;
  authorization: DoctorAuthorizationResult;
  migration: LegacyMigrationResult | null;
  /** Kept for existing doctor JSON consumers while they move to the versioned fields. */
  report: Record<string, DoctorCheck>;
  chatgptRepair: DoctorChatgptRepair;
  namedRepair: DoctorNamedRepair;
}

export interface DoctorConversationDisposition extends ConversationView {
  workspaceId: string;
}

export const DOCTOR_EXIT_STATUS: Readonly<Record<DoctorOutcome, 0 | 1 | 2>> = {
  healthy: 0,
  repaired: 0,
  busy: 2,
  user_action_required: 2,
  blocked: 1,
  unknown: 1,
};

export function createRecoveryLeaseDoctorResult(
  status: "busy" | "unknown",
  detail: string,
  pages: DoctorChatgptRepair["pages"],
  requestedWorkspace: DoctorRequestedWorkspaceIdentity
): DoctorResult {
  const reason: DoctorReason = status === "busy" ? "recovery_in_progress" : "probe_inconclusive";
  return {
    version: DOCTOR_CONTRACT_VERSION,
    outcome: status,
    reason,
    repairs: [],
    safeRetry: true,
    nextAction: { type: "retry_wait", reason },
    requestedWorkspace,
    activeWorkspace: null,
    bridgeObservation: { state: "not_checked", reason: null },
    conversation: null,
    endpointIdentity: {
      changed: false,
      previousFingerprint: null,
      currentFingerprint: null,
    },
    tunnel: {
      provider: null,
      component: "unknown",
      cloudflareLogin: "not_checked",
      publicHealth: "not_checked",
    },
    authorization: {
      state: "unreachable",
      clientId: null,
      proof: null,
      recoverable: false,
    },
    migration: null,
    report: { recoveryLease: { ok: false, detail } },
    chatgptRepair: {
      needed: false,
      connectorAction: "none",
      connectorName: DEFAULT_CONNECTOR_NAME,
      mcpUrl: null,
      previousMcpUrl: null,
      pages,
    },
    namedRepair: { needed: false },
  };
}

export function createDoctorResult(input: {
  report: Record<string, DoctorCheck>;
  repairs: string[];
  chatgptRepair: DoctorChatgptRepair;
  namedRepair: DoctorNamedRepair;
  conversation: DoctorConversationDisposition | null;
  endpointIdentity: DoctorEndpointIdentity;
  tunnel: DoctorTunnelResult;
  authorization: DoctorAuthorizationResult;
  migration: LegacyMigrationResult | null;
  authorizationPage: string;
  direct?: boolean;
  legacySessionAmbiguous?: boolean;
  tunnelFailure?: "cloudflared_missing" | "transport_down" | "probe_inconclusive";
  bridgeStopped: boolean;
  bridgeUnknown: boolean;
  requestedWorkspace: DoctorRequestedWorkspaceIdentity;
  activeWorkspace: DoctorWorkspaceIdentity | null;
  bridgeObservation: DoctorBridgeObservation;
}): DoctorResult {
  const base = {
    version: DOCTOR_CONTRACT_VERSION,
    repairs: input.repairs,
    report: input.report,
    chatgptRepair: input.chatgptRepair,
    namedRepair: input.namedRepair,
    requestedWorkspace: input.requestedWorkspace,
    activeWorkspace: input.activeWorkspace,
    bridgeObservation: input.bridgeObservation,
    conversation: null,
    endpointIdentity: input.endpointIdentity,
    tunnel: input.tunnel,
    authorization: input.authorization,
    migration: input.migration,
  } as const;

  if (input.bridgeUnknown) {
    return {
      ...base,
      outcome: "unknown",
      reason: "probe_inconclusive",
      safeRetry: true,
      nextAction: { type: "retry_wait", reason: "probe_inconclusive" },
    };
  }
  if (input.bridgeStopped) {
    return {
      ...base,
      outcome: "blocked",
      reason: "bridge_stopped",
      safeRetry: true,
      nextAction: { type: "manual_recovery", reason: "bridge_stopped" },
    };
  }
  if (input.tunnelFailure) {
    const unknown = input.tunnelFailure === "probe_inconclusive";
    return {
      ...base,
      outcome: unknown ? "unknown" : "blocked",
      reason: input.tunnelFailure,
      safeRetry: true,
      nextAction: unknown
        ? { type: "retry_wait", reason: input.tunnelFailure }
        : { type: "manual_recovery", reason: input.tunnelFailure },
    };
  }
  if (input.namedRepair.needed) {
    return {
      ...base,
      outcome: "user_action_required",
      reason: "cloudflare_login_required",
      safeRetry: false,
      nextAction: { type: "cloudflare_login", reason: "cloudflare_login_required" },
    };
  }
  if (input.chatgptRepair.needed) {
    const reason: DoctorReason = input.chatgptRepair.connectorAction === "create"
      ? "connector_missing"
      : "endpoint_changed";
    return {
      ...base,
      outcome: "user_action_required",
      reason,
      safeRetry: false,
      nextAction: {
        type: "replace_connector",
        reason,
        page: input.chatgptRepair.pages.plugins,
        createPage: input.chatgptRepair.pages.createConnector,
        connectorName: input.chatgptRepair.connectorName,
        endpoint: input.chatgptRepair.mcpUrl,
      },
    };
  }
  const authorization = authorizationDisposition(input.authorization);
  if (input.authorization.state === "expired" && input.authorization.recoverable) {
    const conversation = input.conversation;
    const page = conversation?.mode === "project" ? conversation.projectUrl : conversation?.chatUrl;
    return {
      ...base,
      outcome: "unknown",
      reason: "auth_refresh_required",
      safeRetry: true,
      nextAction: page
        ? { type: "open_conversation", reason: "auth_refresh_required", page }
        : { type: "create_conversation", reason: "conversation_missing" },
      conversation,
    };
  }
  if (authorization === "retry") {
    return {
      ...base,
      outcome: "unknown",
      reason: "probe_inconclusive",
      safeRetry: true,
      nextAction: { type: "retry_wait", reason: "probe_inconclusive" },
    };
  }
  if (authorization === "authorize") {
    const reason = input.authorization.state === "invalid_client" ? "invalid_client" : "auth_required";
    return {
      ...base,
      outcome: "user_action_required",
      reason,
      safeRetry: false,
      nextAction: {
        type: "authorize_oauth",
        reason,
        page: input.authorizationPage,
      },
    };
  }
  if (Object.values(input.report).every((check) => check.ok)) {
    const repaired = input.repairs.length > 0;
    const reason = repaired ? "local_repairs_completed" : "all_checks_passed";
    if (input.direct) {
      return {
        ...base,
        outcome: repaired ? "repaired" : "healthy",
        reason,
        safeRetry: true,
        nextAction: { type: "none" },
      };
    }
    if (input.legacySessionAmbiguous) {
      return {
        ...base,
        outcome: "user_action_required",
        reason: "legacy_session_ambiguous",
        safeRetry: false,
        nextAction: { type: "manual_recovery", reason: "legacy_session_ambiguous" },
      };
    }
    const conversation = input.conversation;
    if (!conversation) {
      return {
        ...base,
        outcome: "blocked",
        reason: "checks_failed",
        safeRetry: false,
        nextAction: { type: "manual_recovery", reason: "checks_failed" },
      };
    }
    const page = conversation.mode === "project" ? conversation.projectUrl : conversation.chatUrl;
    const missing = !conversation.chatUrl;
    return {
      ...base,
      outcome: repaired ? "repaired" : "healthy",
      reason,
      safeRetry: true,
      nextAction: page
        ? { type: "open_conversation", reason: missing ? "conversation_missing" : reason, page }
        : { type: "create_conversation", reason: "conversation_missing" },
      conversation,
    };
  }
  return {
    ...base,
    outcome: "blocked",
    reason: "checks_failed",
    safeRetry: false,
    nextAction: { type: "manual_recovery", reason: "checks_failed" },
  };
}

export type DoctorBrowserGate =
  | "chatgpt_login"
  | "administrator_approval"
  | "connector_replaced";

function safeChatgptPage(page?: string): string | undefined {
  if (!page) return undefined;
  try {
    const url = new URL(page);
    if (url.protocol !== "https:") return undefined;
    if (url.hostname !== "chatgpt.com" && !url.hostname.endsWith(".chatgpt.com")) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

export function observedConnectorReplacement(
  gate?: DoctorBrowserGate,
  page?: string,
  observedEndpoint?: string,
  currentEndpoint?: string | null
): boolean {
  const safePage = safeChatgptPage(page);
  if (
    gate !== "connector_replaced" ||
    !safePage ||
    new URL(safePage).pathname !== "/plugins" ||
    !observedEndpoint ||
    !currentEndpoint
  ) return false;
  return normalizePublicUrl(observedEndpoint) === normalizePublicUrl(currentEndpoint);
}

/** Convert an observed ChatGPT browser interruption into the same one-action doctor contract. */
export function applyDoctorBrowserGate(
  result: DoctorResult,
  gate?: DoctorBrowserGate,
  page?: string
): DoctorResult {
  if (!gate) return result;
  if (
    result.nextAction.type === "retry_wait" ||
    result.nextAction.type === "manual_recovery" ||
    result.nextAction.type === "cloudflare_login"
  ) {
    return result;
  }
  const safePage = safeChatgptPage(page);
  if (
    !safePage ||
    (gate === "connector_replaced" && new URL(safePage).pathname !== "/plugins")
  ) {
    return {
      ...result,
      outcome: "blocked",
      reason: "checks_failed",
      safeRetry: false,
      nextAction: { type: "manual_recovery", reason: "checks_failed" },
    };
  }
  if (gate === "connector_replaced") return result;
  if (gate === "chatgpt_login") {
    const reason = "chatgpt_login_required";
    return {
      ...result,
      outcome: "user_action_required",
      reason,
      safeRetry: false,
      nextAction: { type: "chatgpt_login", reason, page: safePage },
    };
  }
  const reason = "administrator_approval_required";
  return {
    ...result,
    outcome: "user_action_required",
    reason,
    safeRetry: false,
    nextAction: { type: "administrator_approval", reason, page: safePage },
  };
}

export function renderDoctorResult(
  result: DoctorResult,
  productName: string,
  labels: Readonly<Record<string, string>>
): string {
  const lines = [`${productName} Doctor`, ""];
  for (const [key, value] of Object.entries(result.report)) {
    const label = labels[key] ?? key;
    lines.push(`${value.ok ? "✓" : "✗"} ${label}${value.detail ? `${value.ok ? "（" : "："}${value.detail}${value.ok ? "）" : ""}` : ""}`);
  }
  for (const repair of result.repairs) lines.push(`· ${repair}`);
  if (result.nextAction.type === "cloudflare_login" && result.namedRepair.userMessage) {
    lines.push("", result.namedRepair.userMessage);
  }
  if (result.nextAction.type === "replace_connector" && result.chatgptRepair.userMessage) {
    lines.push("", result.chatgptRepair.userMessage);
    if (result.chatgptRepair.mcpUrl) lines.push(`新的连接地址：${result.chatgptRepair.mcpUrl}`);
  }
  lines.push("", `Outcome: ${result.outcome} (${result.reason})`);
  if (result.nextAction.type !== "none") lines.push(`Next action: ${result.nextAction.type}`);
  return lines.join("\n");
}
