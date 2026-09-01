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
  | "auth_required"
  | "invalid_client"
  | "workspace_denied"
  | "conversation_missing"
  | "cloudflare_login_required"
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
      connectorName: string;
      endpoint: string | null;
    }
  | { type: "authorize_oauth"; reason: DoctorReason; page: string; pairingExpiresAt?: number }
  | { type: "chatgpt_login"; reason: DoctorReason; page: string }
  | { type: "open_conversation"; reason: DoctorReason; page?: string }
  | { type: "create_conversation"; reason: DoctorReason; page?: string }
  | { type: "administrator_approval"; reason: DoctorReason; page?: string }
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

export interface DoctorResult {
  version: typeof DOCTOR_CONTRACT_VERSION;
  outcome: DoctorOutcome;
  reason: DoctorReason;
  repairs: string[];
  safeRetry: boolean;
  nextAction: DoctorNextAction;
  /** Kept for existing doctor JSON consumers while they move to the versioned fields. */
  report: Record<string, DoctorCheck>;
  chatgptRepair: DoctorChatgptRepair;
  namedRepair: DoctorNamedRepair;
}

export const DOCTOR_EXIT_STATUS: Readonly<Record<DoctorOutcome, 0 | 1 | 2>> = {
  healthy: 0,
  repaired: 0,
  busy: 2,
  user_action_required: 2,
  blocked: 1,
  unknown: 1,
};

export function createDoctorResult(input: {
  report: Record<string, DoctorCheck>;
  repairs: string[];
  chatgptRepair: DoctorChatgptRepair;
  namedRepair: DoctorNamedRepair;
  bridgeStopped: boolean;
  bridgeUnknown: boolean;
}): DoctorResult {
  const base = {
    version: DOCTOR_CONTRACT_VERSION,
    repairs: input.repairs,
    report: input.report,
    chatgptRepair: input.chatgptRepair,
    namedRepair: input.namedRepair,
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
    return {
      ...base,
      outcome: "user_action_required",
      reason: "endpoint_changed",
      safeRetry: false,
      nextAction: {
        type: "replace_connector",
        reason: "endpoint_changed",
        page: input.chatgptRepair.pages.createConnector,
        connectorName: input.chatgptRepair.connectorName,
        endpoint: input.chatgptRepair.mcpUrl,
      },
    };
  }
  if (Object.values(input.report).every((check) => check.ok)) {
    const repaired = input.repairs.length > 0;
    return {
      ...base,
      outcome: repaired ? "repaired" : "healthy",
      reason: repaired ? "local_repairs_completed" : "all_checks_passed",
      safeRetry: true,
      nextAction: { type: "none" },
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
