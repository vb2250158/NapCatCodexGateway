/** Wire values shared by the Manager and all NapCat presentation clients. */
export const NapcatState = {
  Ready: "ready",
  Unbound: "unbound",
  StopFailed: "stop-failed",
  LoggedIn: "logged-in",
  Offline: "offline",
  LoginRequired: "login-required",
  Unreachable: "unreachable",
  AccountMismatch: "account-mismatch",
  AccountOnlineElsewhere: "account-online-elsewhere",
  QuickLoginAvailable: "quick-login-available",
  QuickLoginInvalid: "quick-login-invalid",
  QrLoginRequired: "qr-login-required",
  LoginConflict: "login-conflict",
  ManualLogin: "manual-login",
  StartFailed: "start-failed",
  StartTimeout: "start-timeout",
  OnebotNotReady: "onebot-not-ready",
  AlreadyRunning: "already-running",
  AlreadyStarting: "already-starting",
  ProcessOrPortAlreadyPresent: "process-or-port-already-present"
} as const;

export type NapcatState = typeof NapcatState[keyof typeof NapcatState];

export class NapcatLifecycleError extends Error {
  constructor(readonly state: NapcatState, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NapcatLifecycleError";
  }
}

/** Authentication and transport readiness are separate facts. */
export type NapcatPanelState = typeof NapcatState.LoggedIn | typeof NapcatState.Offline
  | typeof NapcatState.LoginRequired | typeof NapcatState.AccountMismatch | typeof NapcatState.Unreachable;

export type NapcatLoginInfo = {
  userId?: string | number;
  nickname?: string;
  online?: boolean;
  source?: "onebot-http" | "webui";
  status?: NapcatState;
  message?: string;
};

export type NapcatHealthSnapshot = {
  state?: NapcatState;
  loginState?: NapcatState;
  ok?: boolean;
  needsUserAction?: boolean;
  accountOwner?: {
    userId?: string; nickname?: string; httpUrl?: string; webuiUrl?: string;
    workingDir?: string; instanceName?: string; routesToGateway?: boolean;
  };
  fixAvailable?: boolean;
  diagnostics?: string[];
  onebot?: { configPath?: string | null; currentUserId?: string | number; currentNickname?: string };
  loginInfo?: NapcatLoginInfo | null;
  http?: { ok?: boolean; status?: number; message?: string; userId?: string | number; nickname?: string; online?: boolean; good?: boolean };
  webui?: {
    url?: string; reachable?: boolean; found?: boolean; tokenFound?: boolean;
    tokenLength?: number; configPath?: string; source?: "provided" | "config";
    message?: string; loginInfo?: NapcatLoginInfo | null;
  };
  process?: { inspectionSkipped?: boolean; found?: boolean; candidates?: Array<{ name: string; pid: string }> };
  gatewayPort?: number;
  wsUrl?: string;
  message?: string;
};

export type NapcatLoginPanelData = {
  ok: boolean;
  state: NapcatPanelState;
  health: NapcatHealthSnapshot;
  managementAvailable: boolean;
  loggedIn: boolean;
  offline?: boolean;
  expectedUserId: string;
  currentAccount: { userId: string; nickname?: string; online?: boolean; avatarUrl?: string } | null;
  quickAccounts: Array<{ userId: string; nickname?: string; avatarUrl?: string; savedLogin?: boolean; quickLoginAvailable?: boolean }>;
  qrCodeDataUrl: string;
  loginError?: string;
  warnings: string[];
  message?: string;
};
