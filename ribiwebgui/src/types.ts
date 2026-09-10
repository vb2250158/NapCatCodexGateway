import type {
  AgentAdapterType,
  CodexPlanAssistantSession,
  CodexHookSettings,
  GatewayDefinition,
  MessageAdapterPolicies,
  MessageAdapterPolicy,
  MessageAdapterType,
  MessagePayloadKind,
  NapCatInstanceDefinition,
  NotificationScheduleDefinition,
  NotificationRuleDefinition,
  PersonaAutomationRuleDefinition,
  PipelineDefinition
} from "@shared/gatewayConfigModel";
import type { PersonaAvatarPresentation } from "@shared/personaAvatarContract";
import type { PlanAttachmentPresentation } from "@shared/planAttachmentContract";
import type { PlanFeedbackAttachment } from "@shared/planFeedbackContract";

export type {
  AgentAdapterType,
  CodexPlanAssistantSession,
  CodexHookSettings,
  GatewayDefinition,
  MessageAdapterPolicies,
  MessageAdapterPolicy,
  MessageAdapterType,
  MessagePayloadKind,
  NotificationScheduleDefinition,
  PersonaAutomationRuleDefinition,
  PipelineDefinition
} from "@shared/gatewayConfigModel";

export type { GatewayMessageAdapterType, MessageEndpointType } from "@shared/messageEndpointTypes";

export type NotificationRule = NotificationRuleDefinition;
export type NapCatInstance = NapCatInstanceDefinition;
export type OutputAdapterType = "qq" | "agent" | "file" | "console" | "tts" | "webhook" | "fennenote" | "wecom" | "weixin" | "feishu" | "none";
export type PromptOutputMode = "qq_text" | "voice_short" | "markdown" | "json" | "plain_text";
export type AgentMaturity = "verified" | "experimental" | "stub";

export type AgentScanSession = {
  id?: string;
  name: string;
  projectPath?: string;
  projectId?: string;
  updatedAt?: string;
  userNamed?: boolean;
};

export type AgentScanProject = {
  id?: string;
  label: string;
  path: string;
  exists: boolean;
};

export type AgentScanModel = {
  id: string;
  name: string;
  provider?: string;
  providerName?: string;
  description?: string;
  isDefault?: boolean;
  defaultReasoningEffort?: string;
  reasoningEfforts?: Array<{ id: string; description?: string }>;
};

export type AgentDeliveryTestResult = {
  deliveryId: string;
  gatewayId: string;
  agentAdapterType: AgentAdapterType;
  status: "delivered" | "failed";
  completedAt: string;
  error?: string;
};

export type AgentScanResult = {
  type: AgentAdapterType;
  label: string;
  maturity: AgentMaturity;
  installed: boolean;
  installCandidates?: Array<{ label: string; path?: string; url?: string }>;
  auth?: { required: boolean; loggedIn?: boolean; loginUrl?: string; message?: string };
  endpoints?: Array<{ label: string; url: string; healthy?: boolean }>;
  projects?: AgentScanProject[];
  sessions?: AgentScanSession[];
  models?: AgentScanModel[];
  sessionPage?: {
    offset: number;
    limit: number;
    returned: number;
    hasMore: boolean;
    nextOffset?: number;
  };
  plugins?: Array<{ id: string; name: string; installed: boolean; version?: string; healthy?: boolean; details?: string[] }>;
  warnings?: string[];
};

export type AdapterRequirement = {
  id: string;
  label: string;
  required?: boolean;
  ok?: boolean;
  detail?: string;
  actionLabel?: string;
  url?: string;
  path?: string;
};

export type AdapterEndpoint = {
  label: string;
  url: string;
  healthy?: boolean;
};

export type AdapterInstallCandidate = {
  label: string;
  path?: string;
  url?: string;
};

export type MessageAdapterScanResult = {
  type: MessageAdapterType;
  label: string;
  maturity: AgentMaturity;
  installed: boolean;
  scan?: {
    state: "ok" | "timeout" | "error";
    durationMs: number;
    message?: string;
  };
  health?: {
    state: "healthy" | "degraded" | "offline" | "needs_login" | "unconfigured" | "unknown" | "timeout" | "error";
    message: string;
    available?: number;
    total?: number;
  };
  installCandidates?: AdapterInstallCandidate[];
  endpoints?: AdapterEndpoint[];
  requirements?: AdapterRequirement[];
  warnings?: string[];
};

export type RoleOption = PersonaAvatarPresentation & {
  label: string;
  value: string;
  roleTitle?: string;
  rolePath?: string;
  roleContent?: string;
  roleError?: string;
  dataDir?: string;
};

export type RuntimeStatus = GatewayDefinition & {
  running?: boolean;
  pid?: number | null;
  startedAt?: string | null;
  stoppedAt?: string | null;
  lastExit?: {
    code: number | null;
    signal: string | null;
    at: string;
  } | null;
  roleInfo?: {
    rolesDir?: string;
    selectedRoleId?: string;
    selectedRolePath?: string;
    selectedRoleTitle?: string;
    selectedRoleContent?: string;
    selectedRoleError?: string;
    selectedRoleDataDir?: string;
    options?: RoleOption[];
  };
  gatewayStatus?: Record<string, any>;
  adapterLogs?: Record<string, {
    paths?: string[];
    entries?: Array<Record<string, any>>;
  }>;
  messageFiles?: Record<string, {
    paths?: string[];
    entries?: Array<Record<string, any>>;
  }>;
  agentStates?: Partial<Record<AgentAdapterType, Record<string, any>>>;
  log?: string[];
};

export type GatewayPayload = {
  code: number;
  message?: string;
  routeCatalog?: RouteCatalogVersion;
  data?: {
    config?: {
      gateways?: GatewayDefinition[];
    };
    configFiles?: Record<string, string>;
    manager?: RuntimeStatus[] | { error?: string };
  };
};

export type RouteCatalogVersion = {
  contentHash: string;
  routeConfigHash: string;
  presentationHash: string;
  revision: number;
};

export type NetworkOptions = {
  adapters: Record<string, unknown>;
  localAddresses?: Array<{ name?: string; address: string; cidr?: string }>;
  httpServers: unknown[];
  websocketClients: unknown[];
};

export type MetaPayload = {
  applicationGenerationId?: string;
  managerInstanceId?: string;
  version: string;
  githubUrl: string;
  managerPort: number;
  rabiGuid?: string;
  rabiName?: string;
  webguiLan?: {
    enabled?: boolean;
    tokenConfigured?: boolean;
    listeningOnLan?: boolean;
    restartRequired?: boolean;
  };
  rabiLinkRelay?: {
    enabled?: boolean;
    url?: string;
    token?: string;
    tokenConfigured?: boolean;
    deviceId?: string;
    claimWaitMs?: number;
    replyIdleTimeoutMs?: number;
    speechProxyEnabled?: boolean;
    speechServiceUrl?: string;
  };
  rabiLinkRelayRuntime?: {
    state?: "disabled" | "incomplete" | "connecting" | "online" | "error";
    message?: string;
    lastConnectedAt?: string;
    lastSuccessAt?: string;
    error?: string;
  };
  computerName?: string;
};

export type RolePlanStep = {
  questions?: import("@shared/planQuestions").PlanQuestion[];
  id: string;
  title: string;
  detail?: string;
  waitingFor?: string;
  isBlocked?: boolean;
  blockedBy?: string;
  startedAt?: string;
  completedAt?: string;
  approvalRequest?: RolePlanApprovalContract;
};

export type RolePlanApprovalContract = {
  approver?: string;
  request: string;
  recommendation?: string;
  alternatives?: string[];
  reason: string;
  files: Array<{
    path: string;
    action: "create" | "modify" | "delete" | "move";
    change: string;
    destination?: string;
  }>;
  commands: Array<{
    command: string;
    purpose: string;
    expectedEffect?: string;
  }>;
  changes: Array<{
    target: string;
    change: string;
    impact?: string;
  }>;
  validation: string[];
  rollback: string[];
  outOfScope: string[];
  requestedAt?: string;
  sourceMessageId?: string;
  feedbackId?: string;
  responseStatus?: "pending" | "approved" | "rejected" | "changes_requested" | "cancelled";
};

export type RolePlanStatusKey = string;

export type RolePlan = {
  id: string;
  title: string;
  focus: string;
  status: RolePlanStatusKey;
  archiveStatus: "未归档" | "已归档";
  importance?: number;
  urgency?: number;
  priority?: string;
  kind?: string;
  currentStep?: string;
  currentStepId?: string;
  currentStepPreview?: RolePlanStep;
  currentStepPosition?: number;
  stepCount?: number;
  completedStepCount?: number;
  attachmentCount?: number;
  detailLevel?: "summary" | "preview" | "full";
  nextAction?: string;
  waitingFor?: string;
  isBlocked?: boolean;
  blockedBy?: string;
  attachments: PlanAttachmentPresentation[];
  steps: RolePlanStep[];
  project?: { name?: string; path?: string };
  messageChannels?: import("@shared/agentHookAutomation").AgentHookDestination[];
  source?: { kind?: string; summary?: string };
  secretaryBinding?: {
    agentType: "codex" | "dsh";
    sessionId: string;
    sessionTitle?: string;
    workspace: string;
    baseUrl?: string;
    assignedAt?: string;
  };
  taskBinding?: {
    agentType: "codex" | "dsh";
    sessionId: string;
    sessionTitle?: string;
    workspace?: string;
    baseUrl?: string;
    completionHook?: { enabled: boolean; gatewayId?: string };
  };
  dueAt?: string;
  completedAt?: string;
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
  keywords: string[];
  presentation: {
    status: RolePlanStatusKey;
    label: string;
    labelEn: string;
    description: string;
    descriptionEn: string;
    tone: string;
    statusLevel: number;
    acceptsGuidance: boolean;
    views: Array<"current" | "plans" | "archived">;
    palette: {
      accent: string;
      background: string;
      foreground: string;
    };
    importance?: {
      level: number;
      label: string;
      labelEn: string;
      palette: {
        accent: string;
        background: string;
        foreground: string;
      };
    };
    urgency?: {
      level: number;
      label: string;
      labelEn: string;
      palette: {
        accent: string;
        background: string;
        foreground: string;
      };
    };
    approval: {
      state: "none" | "incomplete" | "ready";
      enabled: boolean;
      label: string;
      helper: string;
      stepId?: string;
      missing: string[];
      contract?: RolePlanApprovalContract;
    };
  };
  approval: {
    count: number;
    latest?: RolePlanFeedback;
    records?: RolePlanFeedback[];
  };
};

export type RolePlanHistorySnapshot = Omit<RolePlan, "presentation" | "approval">;

export type RolePlanHistoryRecord = {
  id: string;
  planId: string;
  kind: "created" | "updated" | "archived";
  recordedAt: string;
  before?: RolePlanHistorySnapshot;
  after: RolePlanHistorySnapshot;
};

export type RolePlanFeedback = {
  id: string;
  roleId: string;
  planId: string;
  planTitle: string;
  stepId?: string;
  stepTitle?: string;
  gatewayId?: string;
  kind: "guidance" | "guidance_response" | "approval_suggestion" | "approval_response";
  author: "user" | "agent" | "system";
  source: "webgui" | "tray" | "qq" | "agent" | "api";
  text: string;
  attachments: PlanFeedbackAttachment[];
  planAttachments: PlanAttachmentPresentation[];
  createdAt: string;
  updatedAt: string;
  deliveryStatus: "record_only" | "pending" | "delivered" | "failed";
  deliveryMessage?: string;
};

export type RoleMemory = {
  id: string;
  title: string;
  focus: string;
  content: string;
  source?: { kind?: string; summary?: string };
  createdAt: string;
  updatedAt: string;
  viewedAt?: string;
  recalledAt?: string;
  consolidatedAt?: string;
  consolidationRunId?: string;
  inputMemoryIds?: string[];
  keywords: string[];
  lifecycle?: {
    kind: "recent" | "consolidated";
    state: "active" | "eligible" | "trigger_due" | "consolidated_source" | "consolidated";
    activityAt: string;
    consolidationEligibleAt?: string;
    consolidationTriggerAt?: string;
    triggersNextConsolidation?: boolean;
    willEnterNextConsolidation?: boolean;
  };
};

export type RoleMemoryPayload = {
  recent: RoleMemory[];
  consolidated: RoleMemory[];
  archived?: RoleMemory[];
};
