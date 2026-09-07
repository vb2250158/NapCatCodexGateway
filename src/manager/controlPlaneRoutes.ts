import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { NapcatLifecycleOwner, validateNapcatBindings, type NapcatBinding } from "./napcatLifecycleOwner.js";
import { createNapcatProcessDriver } from "./napcatProcessDriver.js";
import {
  buildAgentDeliveryTestEnvelope,
  parseAgentDeliveryTestResult,
  type AgentDeliveryTestResult
} from "../agentDeliveryTest.js";
import { normalizeAgentAdapters, parseAgentAdapterType, type AgentAdapterType } from "../agentAdapters/types.js";
import { agentAdapterManifest } from "../shared/agentAdapterCapabilities.js";
import { agentThreadRequestFailureData, handleAgentThreadRequest, type AgentThreadRequest, type AgentThreadRequestOptions } from "../agentThreads.js";
import { agentIdentityForMessageSource, type RabiAgentMessageSource, type RabiDeliveryEnvelope, type RabiMessageSource } from "../shared/rabiMessage.js";
import { AgentRequestStore, type AgentRequestRecord } from "../agentRequests/store.js";
import { agentRequestStatePath } from "../agentRequests/persistence.js";
import { projectDirectoryLayout } from "../shared/projectDirectoryLayout.js";
import { resolveRuntimeLayout } from "../shared/runtimeLayout.js";
import { listCodexDesktopThreads, readCodexDesktopThread } from "../codexDesktopBridge.js";
import { isDshSessionId } from "../dshSessionBridge.js";
import { sameCodexWorkspace } from "../codexTaskIdentity.js";
import { selectAgentThreadRouteId } from "./agentThreadRouteSelection.js";
import { agentStateReportDecision } from "../agentAdapters/stateReportOrder.js";
import {
  getCopilotStatus,
  openMarvis,
  testAstrbotLogin as testAstrbotLoginEndpoint,
  type AgentManagerApiContext
} from "../agentAdapters/managerApi.js";
import type { MessageAdapterType } from "../adapters/messageAdapter.js";
import { getMessage } from "../napcat.js";
import type { ForwardRouteKind } from "../forwarding.js";
import { appendAdapterLogToDir } from "../history.js";
import {
  messageAgentPoolStatePath,
  readCurrentMessageAgentWorkers,
  replacePersistedMessageAgentWorker,
  resolveCurrentMessageAgentWorker
} from "../messageAgentPool.js";
import {
  resolveDeliveredMessageProcessingTarget,
  resolveMessageProcessingDeliveryTarget,
  type MessageProcessingDeliveryTarget
} from "./messageProcessingDeliveryTarget.js";
import { listDeliveryReplayAttempts } from "../deliveryReplayLedger.js";
import type { DeliveryReplayRequest } from "../deliveryReplay.js";
import {
  autoLoginNapcatInstancesOnRabiStart,
  configureNapcatOneBot,
  ensureNapcatInstanceReady,
  launchNapcatInstance as launchNapcatInstanceEndpoint,
  launchNapcatProcess as launchManagedNapcatProcess,
  nextFreeLocalPort,
  prepareManagedNapcatInstance,
  readNapcatLoginPanel,
  requestNapcatBotExit,
  restartNapcatInstance as restartNapcatInstanceEndpoint,
  runNapcatLoginAction,
  scanNapcatEndpoint,
  stopNapcatInstance as stopNapcatInstanceEndpoint,
  testNapcatHealth as testNapcatHealthEndpoint,
  type NapcatLaunchPlan,
  type NapcatLaunchRequest as ManagedNapcatLaunchRequest
} from "../messageEndpoints/napcatManager.js";
import {
  scanNapcatHealthReadOnly,
  type NapcatHealthScanPayload
} from "../messageEndpoints/napcatHealthScan.js";
import { RemoteAgentHub, type RemoteAgentTask, type RemoteAgentTaskEvent, type RemoteAgentTaskRequest } from "../messageEndpoints/remoteAgentManager.js";
import { appendMessageContextToDir } from "../messageContextStore.js";
import { SpeechIngressStore } from "../speechIngressStore.js";
import { managerRuntimeDiagnosticsSummary } from "../managerRuntimeDiagnostics.js";
import { createManagerOperationalLog, installOperationalMutationAuditSink, managerOperationalError } from "./operationalLog.js";
import { PerformanceMonitoringService } from "./performanceMonitoring.js";
import { PerformanceApi } from "./performanceRoutes.js";
import { measureSyncPerformanceOperation } from "../performance/performanceInstrumentation.js";
import { PERFORMANCE_OPERATIONS } from "../shared/performanceOperations.js";
import {
  createOperationContext,
  recordDataMutationAudit,
  runWithOperationContext
} from "../observability/dataMutationAudit.js";
import { readJsonlTail } from "./jsonlTail.js";
import { requestWeixinLogin } from "../weixinLoginRequest.js";
import { PersonaSyncService } from "../personaSync.js";
import { PersonaSyncCoordinator } from "../personaSyncCoordinator.js";
import { PersonaSyncAutoReconciler } from "../personaSyncAutoReconciler.js";
import {
  findPersonaVoiceIdentity,
  listPersonaVoiceIdentities,
  updatePersonaVoiceIdentity,
  type PersonaVoiceIdentityPatch
} from "../personaVoiceIdentities.js";
import {
  listIdentityEndpointAccounts,
  listIdentityParticipants,
  listIdentityRelationCards,
  recordIdentityCandidateObservation,
  resolveIdentityRelationContext,
  updateIdentityRelation,
  type IdentityCandidateObservation,
  type IdentityRelationPatch
} from "../identityRelations.js";
import { listConversationSituations } from "../conversationSituationStore.js";
import { AgentCompletionDeliveryService, completionTaskContextFromPlans, deliverCompletionToEndpoint } from "./agentCompletionDelivery.js";
import type { ReviewedReplySourceEvidence } from "../replyImageDescriptions.js";
import {
  handleAgentSend,
  inspectAgentSendDelivery,
  prepareAgentSendRequest,
  validateAgentSendReplyImageDescriptions,
  type AgentSendRequest,
  type AgentSendResult
} from "../agentSend.js";
import type {
  AgentPlanFeedbackSubmitRequest,
  AgentPlanFeedbackSubmitResult
} from "../outbox.js";
import { evaluateAgentSendLanguageStyle } from "../agentSendLanguageStyle.js";
import { agentSendRequestTemplateForSource } from "../agentSendTemplate.js";
import { assertAgentSendPermission } from "./agentSendPermission.js";
import {
  MessageProcessingBoardStore,
  type KnowledgeRecallMatch,
  type MessageProcessingRequirement,
  type MessageProcessingWorkerRuntimeObservation,
  type MessageProcessingWorkerRuntimeStatus,
  type RegisterMessageGroupRequirementInput
} from "../messageProcessing/board.js";
import {
  CoalescingMessageProcessingBoardPersistence,
  messageProcessingBoardStatePath
} from "../messageProcessing/persistence.js";
import { MessageProcessingSendContextReview } from "../messageProcessing/sendContextReview.js";
import {
  loadMessageProcessingContext,
  recoverReviewedMessageProcessingSourceRecord
} from "../messageProcessing/sourceContextRecovery.js";
import { normalizeCodexMemoryConsolidationAgentModel } from "../shared/codexMemoryConsolidationAgent.js";
import {
  agentSendReceiptResponse,
  executeIdempotentAgentSend,
  findAgentSendTraces,
  readAgentSendReceipt
} from "./agentSendIdempotency.js";
import { normalizePipelineDefinition, type PipelineDefinition } from "../pipelines.js";
import {
  normalizeRolePanelAttachments,
  type RolePanelAttachment,
  type RolePanelTimelineAppendResult,
  type RolePanelTimelineMessage
} from "../rolePanelTimeline.js";
import {
  DEFAULT_CODEX_HOOK_SETTINGS,
  gatewayMessageAdapterTypes as sharedGatewayMessageAdapterTypes,
  autoAssignGatewayPorts as sharedAutoAssignGatewayPorts,
  primaryMessageProcessingAgentAdapter,
  definitionUsesNapcat as sharedDefinitionUsesNapcat,
  normalizeNapCatInstances as sharedNormalizeNapCatInstances,
  sanitizeInstanceId,
  gatewayAdapterTypes as sharedGatewayAdapterTypes,
  normalizeCodexHookSettings,
  normalizeGatewayDefinition as sharedNormalizeGatewayDefinition,
  validateGatewayPortConflicts as sharedValidateGatewayPortConflicts,
  validateNapcatRouteCardinality,
  type CodexHookSettings,
  type CodexPlanAssistantSession,
  type CodexReasoningEffort,
  type MessageAdapterPolicies,
  type MessageProcessingAgentPolicies,
  type PersonaAutomationRuleDefinition,
  type RecentMessageLimits,
  type SpeechPushMode
} from "../shared/gatewayConfigModel.js";
import {
  codexPlanAssistantInitializationPrompt,
  normalizeCodexPlanAssistantModel,
  planAssistantSessionAgentAdapter,
  resolveCodexPlanAssistantTurnModel
} from "../shared/codexPlanAssistantSessions.js";
import {
  resolvePersistedProjectPath,
  resolveProjectPath,
  toPersistedProjectPath
} from "../shared/projectPaths.js";
import { normalizePathForComparison } from "../shared/pathPolicy.js";
import { rabiRoutePackageVersion } from "../packageInfo.js";
import type { ManagerInstanceLock } from "../managerInstanceLock.js";
import {
  listenManagerEndpoint,
  parseManagerPortPolicy
} from "../managerEndpointPolicy.js";
import {
  handleManagerHostLifecycleRequest,
  managerHostIdentityFromEnvironment,
  managerReadyLine
} from "./hostLifecycle.js";
import {
  handleManagerLanDiscoveryRequest,
  MANAGER_DISCOVERY_PROTOCOL_VERSION
} from "./managerLanDiscovery.js";
import {
  startManagerDiscoveryPublisher,
  type ManagerDiscoveryStatus
} from "./managerLanDiscoveryPublisher.js";
import {
  routeRuntimeParts,
  sanitizeConfigName,
  sanitizeRoleId
} from "../shared/routeIdentity.js";
import {
  adapterConfigPath as resolveAdapterConfigPath,
  roleFilePath,
  roleFolderPath,
  routeFolderPath,
  personaConfigPath as resolvePersonaConfigPath
} from "../shared/routePaths.js";
import { ManagerConfigRepository, type ManagerConfig } from "./configRepository.js";
import {
  ManagerWatchBroker,
  disabledManagerWatchBrokerStatus,
  publicManagerWatchBrokerStatus,
  type ManagerWatchBrokerStatus,
  type ManagerWatchDiagnostic
} from "./managerWatchBroker.js";
import { resolveCodexRuntimeState } from "./codexRuntimeState.js";
import { resolveReportedCodexBindingUpdate } from "./codexBindingUpdate.js";
import { proxySpeechEventStream } from "./speechEventProxy.js";
import {
  CodexHookContextService,
  type AgentRequestStopResult,
  type CodexHookContextRequest,
  type PlanTaskCompletionDelivery,
} from "./codexHookContext.js";
import { handleCodexHookApi } from "./codexHookRoutes.js";
import {
  pangHuProgressMessage,
  stablePangHuProgressDeliveryId,
  type PangHuProgressNotificationDelivery,
  type PangHuProgressNotificationResult
} from "./panghuProgressNotificationGate.js";
import { handleLanguageStyleApi } from "./languageStyleRoutes.js";
import { handlePluginCatalogApi } from "./pluginCatalogRoutes.js";
import {
  GenerationRuntime,
  loadPluginProfile,
  PluginPackageCatalog,
  selectReadyPluginCandidates,
  type HostService,
  type LoadedPluginProfile
} from "../plugin-kernel/index.js";
import { createFullPluginExecutor } from "../plugin-runtime-host/executor.js";
import { ProcessLeaseRegistry } from "../runtime/processLeaseRegistry.js";
import { createWearableCompanionRuntimeIdentity } from "./wearableCompanionRuntimeIdentity.js";
import { WearableCompanionWorkerService } from "./wearableCompanionWorkerService.js";
import { WebPluginModuleRegistry } from "./webPluginModules.js";
import {
  ManagerPluginRouteRegistry,
  type ManagerPluginRouteHandler
} from "./managerPluginRouteRegistry.js";
import { isManagerControlRequestPath } from "./managerHttpRequestClassification.js";
import { ManagerPluginRequestTracker } from "./managerPluginRequestTracker.js";
import { createDesktopControlRoutes, desktopConfigFilePayload } from "./desktopControlRoutes.js";
import { handleDesktopPetApi } from "./desktopPetRoutes.js";
import { createYeYuGamerManagerRouteHandler } from "../integrations/yeyuGamer/managerRoutes.js";
import { XiaomiHomeManagerApiClient } from "../integrations/xiaomiHome/managerApi.js";
import { XiaomiHomeArtifactStore } from "../integrations/xiaomiHome/artifactStore.js";
import { XiaomiHomeEventMonitor } from "../integrations/xiaomiHome/eventMonitor.js";
import { XiaomiHomeClipCaptureWorker } from "../integrations/xiaomiHome/clipCapture.js";
import { XiaomiHomeArtifactAccess } from "../integrations/xiaomiHome/artifactAccess.js";
import { XiaomiHomeRuntimeController, XiaomiHomeSettingsStore } from "../integrations/xiaomiHome/settingsRuntime.js";
import { createXiaomiHomeManagerRouteHandler } from "../integrations/xiaomiHome/managerRoutes.js";
import type { XiaomiHomeEvent, XiaomiHomeEventDeliveryContext } from "../xiaomiHomeEventDelivery.js";
import { createDiagnosticsRoutes } from "./diagnosticsRoutes.js";
import { handleGatewayControlApi } from "./gatewayControlRoutes.js";
import { handleRemoteAgentApi as handleRemoteAgentPluginApi } from "./remoteAgentRoutes.js";
import { createAgentThreadControlRoutes } from "./agentThreadControlRoutes.js";
import { createAgentCommunicationRoutes, type AgentCommunicationHttpResponse } from "./agentCommunicationRoutes.js";
import { createAgentProviderControlRouteHandler } from "./agentProviderControlRoutes.js";
import { AgentProviderProcessScope, CopilotControlService } from "./agentProviderControlService.js";
import { AgentAdapterCatalogService, mountAgentAdapterCatalogPlugin } from "./agentAdapterCatalog.js";
import {
  MessageAdapterControlService,
  MessageAdapterScanProviderRegistry,
  handleMessageAdapterControlApi,
  registerBuiltinMessageAdapterScanProviders,
  type MessageAdapterEndpoint,
  type MessageAdapterScanResult as PluginMessageAdapterScanResult
} from "./messageAdapterControl.js";
import {
  handleNapcatControlApi,
  type NapcatAddRequest,
  type NapcatHealthRequest,
  type NapcatLaunchRequest,
  type NapcatRemoveRequest
} from "./napcatControlRoutes.js";
import { FenneNoteOutputService } from "./fenneNoteOutputService.js";
import { handleMessageProcessingApi } from "./messageProcessingRoutes.js";
import { ManagerGatewayRuntimeService } from "./managerGatewayRuntimeService.js";
import { GenerationHandoffLease } from "./generationHandoffLease.js";
import { NapcatSupervisorService } from "./napcatSupervisorService.js";
import { MessageProcessingAutomationService } from "./messageProcessingAutomationService.js";
import { KnowledgeCallbackReminderService } from "./knowledgeCallbackReminderService.js";
import { PlanFeedbackRecoveryService } from "./planFeedbackRecoveryService.js";
import { runWindowsTaskkill, stopChildProcessTree } from "../runtime/windowsProcessTree.js";
import { getBuiltinManagerCordisRoot } from "../runtime/managerCordisRoot.js";
import {
  MANAGER_SHARED_RESOURCES_RUNTIME_KEY,
  mountManagerSharedResourcesRuntime
} from "./managerSharedResourcesRuntime.js";
import { LanguageStyleValidator } from "../languageStyleValidation.js";
import { createPlanTaskCompletionDelivery } from "./planTaskCompletionDelivery.js";
import {
  deliverPlanApprovalFeedback,
  PlanFeedbackDeliveryPendingError,
  type PlanApprovalFeedbackPersonaRequest,
  type PlanApprovalFeedbackSecretaryTarget,
  type PlanApprovalFeedbackTaskRequest
} from "./planApprovalFeedbackDelivery.js";
import {
  recoverPlanFeedbackCandidate as recoverPlanFeedbackCandidateBase,
  type PlanFeedbackDeliveryInspection,
  type PlanFeedbackRecoveryCandidate,
  type PlanFeedbackRecoveryOutcome,
  type PlanFeedbackRecoveryTaskRequest
} from "./planFeedbackRecovery.js";
import {
  reconcilePlanSecretaryBindingsForWorkspace,
  type PlanSecretaryTarget
} from "./planSecretaryAssignment.js";
import {
  ManualTriggerProcessRegistry,
  type ManualTriggerLaunchResult
} from "./manualTriggerProcess.js";
import {
  DEFAULT_MANAGER_RUNTIME_TEARDOWN_TIMEOUT_MS,
  ManagerRuntimeOwner
} from "./managerRuntimeOwner.js";
import {
  MemoryConsolidationScheduler,
  type DueMemoryConsolidationRun,
  type MemoryConsolidationScheduleTarget
} from "./memoryConsolidationScheduler.js";
import { memoryConsolidationFailureDiagnostic } from "./memoryConsolidationDiagnostics.js";
import { evaluateMemoryConsolidationSchedule } from "./memoryConsolidationScheduleWorkerClient.js";
import { canonicalLogicalPlanId } from "../planStorageIdentity.js";
import {
  PlanStorageStartupLifecycle,
  type PlanStorageStartupLifecycleSnapshot
} from "./planStorageStartupLifecycle.js";
import {
  RouteCatalogOperationError,
  RouteCatalogStartupLifecycle,
  type RouteCatalogStartupLifecycleSnapshot
} from "./routeCatalogStartupLifecycle.js";
import { routeCatalogStartupUnavailable } from "./routeCatalogStartupHttpGate.js";
import type { RouteCatalogPersonaPresentation, RouteCatalogSnapshot } from "./routeCatalogTransaction.js";
import {
  planStorageStartupUnavailable,
  publicPlanStorageStartupSnapshot
} from "./planStorageStartupHttpGate.js";
import {
  consumePlanQaFeedback,
  type PlanQaStoragePort,
  type PlanQaTaskRequest
} from "./planQaFeedback.js";
import { handlePlanAgentStatusApi } from "./planAgentStatusRoutes.js";
import { parseRoleKnowledgeResourceRoute } from "./roleKnowledgeRoute.js";
import { parseWearableHealthResourceRoute } from "./wearableHealthRoute.js";
import { RabiGlobalConfigStore, type RabiLinkRelayGlobalConfig } from "./globalConfig.js";
import { LanAgentRegistry } from "./lanAgentRegistry.js";
import { LanAgentReleaseStore } from "./lanAgentReleaseStore.js";
import { handleLanAgentApi } from "./lanAgentRoutes.js";
import {
  generateWebguiAccessToken,
  isLoopbackRemoteAddress,
  isLocalMachineRemoteAddress,
  isPublicWebguiStaticRequest,
  isWebguiLanRequestAuthorized,
  webguiTokenMatches,
  lanAddressPriority,
  managerListensOnLan
} from "./webguiLanAccess.js";
import { handleRabiApi, publicRabiLinkRelayConfig } from "./rabiApi.js";
import { parseGatewayReadyLine } from "../gatewayLifecycle.js";
import { RabiLinkRelayRuntime } from "./rabiLinkRelayRuntime.js";
import { RuntimeRegistry, type GatewayRuntime } from "./runtimeRegistry.js";
import {
  gatewayRuntimeStartDecision,
  gatewayRuntimeSyncAction,
  managerAutostartEnabled,
  managerConfigWatcherEnabled,
  managerReadOnlyEnabled,
  managerReadOnlyRequestAllowed
} from "./managerRuntimeMode.js";
import { buildManagerHealthSnapshot } from "./managerHealth.js";
import { resolveGatewayChildCommand } from "./gatewayChildCommand.js";
import {
  gatewayMessageAdapterEnvironment,
  routeMessageAdapterEnvironment,
  type MessageAdapterEnvironment
} from "./gatewayMessageAdapterEnvironment.js";
import { BilibiliHistoryBridge } from "./bilibiliHistoryBridge.js";
import { handlePersonaAvatarApi } from "./personaAvatarRoutes.js";
import { handlePlanAttachmentApi } from "./planAttachmentRoutes.js";
import { roleInfoPayload } from "./roleInfoPayload.js";
import type { ScanDiagnostic } from "./scanController.js";
import { PersonaSyncLanServer } from "./personaSyncLanServer.js";
import { RabiDirectVideo } from "./rabiDirectVideo.js";
import { createDirectVideoRoutes } from "./rabiDirectVideoRoutes.js";
import { handlePersonaSyncApi, type PersonaSyncRouteContext } from "./personaSyncRoutes.js";
import { handlePersonaVoiceTranscriptApi } from "./personaVoiceTranscriptRoutes.js";
import { handlePersonaChatHistoryApi } from "./personaChatHistoryRoutes.js";
import {
  ManagerReadWorkerError,
  managerCatalogWorkerPool,
  managerKnowledgePageWorkerPool,
  managerPerformanceWorkerPool,
  managerReadWorkerPool
} from "./managerReadWorkerPool.js";
import {
  RoleStorageApplication,
  RoleStorageApplicationError,
  roleStorageHttpError,
  roleStorageOperationKey,
  type RoleStorageCommandContext,
  type RoleStoragePlanFeedbackProjection
} from "./roleStorageApplication.js";
import {
  ensurePlanSecretaryBindingForEvent,
  replacePlanSecretaryBindingForEvent,
  replacePlanTaskBindingForDelivery
} from "./planBindingStorageMutation.js";
import {
  captureGatewayDiagnosticsWorkerInput,
  GatewayDiagnosticsSnapshotService,
  memoryOnlyGatewayRuntimeStatus,
  type GatewayDiagnosticsWorkerInput,
  type GatewayDiagnosticsWorkerResult
} from "./gatewayDiagnosticsSnapshot.js";
import { buildIsolatedGatewayDiagnosticsSnapshot } from "./gatewayDiagnosticsSnapshotWorker.js";
import { handlePersonaMessagingApi } from "./personaMessagingRoutes.js";
import { loadPersonaMessageAuthority, type PersonaMessageAuthority } from "./personaMessageAuthority.js";
import { handleRoleContextProjectionRequest } from "./roleContextProjection.js";
import { deliverRolePanelMessage, RolePanelDeliveryError } from "./rolePanelDelivery.js";
import { hostOwnedSpeechMessageCommand } from "./speechMessageIngress.js";
import {
  ManagerSpeechControl,
  SpeechControlError,
  speechControlErrorMessage,
  speechControlErrorStatus,
  type ManagerSpeechDeliveryOutcome
} from "./speechControl.js";
import {
  SelectionSpeechSettingsStore,
  selectionSpeechSettingsPath
} from "./selectionSpeechSettings.js";
import {
  DesktopSettingsStore,
  desktopSettingsPath
} from "./desktopSettings.js";
import type { DesktopSettings } from "../shared/desktopSettingsContract.js";
import {
  SpeechRuntimeControl,
  SpeechRuntimeControlError
} from "./speechRuntimeControl.js";
import {
  SpeechModelManager,
  SpeechModelManagerError
} from "./speechModelManager.js";
import { SpeechModelSettingsError } from "./speechModelSettings.js";
import { localModelSettingsRequestAllowed } from "./speechModelSettingsAccess.js";
import {
  parseSpeechProcessResult,
  SPEECH_EXIT_DELIVERED,
  SPEECH_EXIT_RECORDED,
  SPEECH_PROCESS_RESULT_MARKER
} from "../speechMessageDelivery.js";
import type {
  SpeechAudioStreamSelectionCommand,
  SpeechIngressRecord,
  SpeechMessageCommand,
  SpeechMicrophoneSettingsCommand,
  SpeechMicrophoneStartCommand,
  SpeechPlaybackVolumeCommand,
  SpeechSpeakerBindingCommand,
  SpeechSpeakerIdentityCommand,
  SpeechSpeakerProfileCreateCommand,
  SpeechSpeakerProfileUpdateCommand,
  SpeechSynthesisCommand
} from "../shared/speechControlContract.js";
import type { LocalSpeechResponse } from "../speech/localSpeechClient.js";
import { standaloneGatewayPayload as buildStandaloneGatewayPayload } from "./statusPayload.js";
import { handlePersonaDocumentApi } from "./personaDocumentRoutes.js";
import {
  getPlan,
  getPublishedPlan,
  getRoleSkill,
  listConsolidationRuns,
  listPlanHistory,
  listPlans,
  listPlansAsync,
  listRecentMemories,
  listRoleSkills,
  presentRoleMemory,
  presentRoleMemories,
  publishedRolePlans,
  roleKnowledgeSnapshotFromPublishedCatalog,
  roleKnowledgeFileCounts,
  subscribePlanUpdates,
  type PlanItem,
  validatePublishedRoleKnowledge,
  validateRoleKnowledge
} from "../roleKnowledge.js";
import { presentPlan, presentPlans } from "../roleKnowledgePresentation.js";
import { ensurePersonaPlanWorkflow } from "../personaPlanWorkflow.js";
import {
  normalizeRoleMemoryPageLimit,
  normalizeRolePlanPageLimit,
  previewRolePlan
} from "../roleKnowledgePagination.js";
import { verifyCriticalProjectFactRecord } from "../messageProcessing/criticalFactRecord.js";
import {
  planFeedbackResponseId,
  planFeedbackSummary,
  type PlanFeedbackDeliveryStatus,
  type PlanFeedbackPostCommit,
  type PlanFeedbackRecord
} from "../planFeedback.js";
import {
  PLAN_FEEDBACK_REQUEST_MAX_BYTES,
  type PlanFeedbackAttachmentUpload
} from "../shared/planFeedbackContract.js";
import { PLAN_ATTACHMENT_REQUEST_MAX_BYTES } from "../shared/planAttachmentContract.js";
import {
  currentWearableHealthState,
  ingestWearableHealthObservation,
  queryWearableHealthHistory,
  readWearableHealthConfig,
  summarizeWearableHealth,
  updateWearableHealthConfig,
  type WearableHealthMetric,
  type WearableHealthObservationInput
} from "../wearableHealth.js";
import {
  type WearableHealthAlertDeliveryContext
} from "../wearableHealthAlertDelivery.js";
import type { WearableHealthAlert } from "../wearableHealth.js";

type ManagerPluginHandlerRouteSpec =
  | {
      routeId: string;
      kind: "exact";
      path: string;
      methods?: readonly string[];
      handlerIndex?: number;
    }
  | {
      routeId: string;
      kind: "prefix";
      pathPrefix: string;
      methods?: readonly string[];
      handlerIndex?: number;
    };

function registerManagerPluginHandlerRoutes(
  registry: ManagerPluginRouteRegistry,
  instanceId: string,
  routeIdPrefix: string,
  handlers: readonly ManagerPluginRouteHandler[],
  routes: readonly ManagerPluginHandlerRouteSpec[]
): () => void {
  return registry.register(instanceId, routes.map(route => {
    const handler = handlers[route.handlerIndex ?? 0];
    if (!handler) {
      throw new Error(`Manager plugin route ${routeIdPrefix}.${route.routeId} references a missing handler.`);
    }
    return {
      routeId: `${routeIdPrefix}.${route.routeId}`,
      match: route.kind === "exact"
        ? { kind: "exact" as const, path: route.path, methods: route.methods }
        : { kind: "prefix" as const, pathPrefix: route.pathPrefix, methods: route.methods },
      handler
    };
  }));
}

type GatewayDefinition = {
  id: string;
  name?: string;
  enabled?: boolean;
  messageAdapterType?: MessageAdapterType;
  messageAdapters?: MessageAdapterType[];
  messageAdaptersDisabled?: MessageAdapterType[];
  messageInputsDisabled?: boolean;
  messageAdapterPolicies?: MessageAdapterPolicies;
  gatewayPort: number;
  webhookPort?: number;
  webhookPath?: string;
  fenneNoteWebhookPort?: number;
  fenneNoteWebhookPath?: string;
  xiaoaiWebhookPort?: number;
  xiaoaiWebhookPath?: string;
  rabiLinkWebhookPort?: number;
  rabiLinkWebhookPath?: string;
  rabiLinkWebhookHost?: string;
  rabiLinkRelayEnabled?: boolean;
  rabiLinkRelayUrl?: string;
  rabiLinkRelayToken?: string;
  rabiLinkRelayDeviceId?: string;
  rabiLinkRelayClaimWaitMs?: number;
  rabiLinkRelayReplyIdleTimeoutMs?: number;
  wecomBotId?: string;
  wecomBotSecret?: string;
  wecomWsUrl?: string;
  weixinBaseUrl?: string;
  weixinBotType?: string;
  feishuAppId?: string;
  feishuAppSecret?: string;
  feishuVerificationToken?: string;
  feishuEncryptKey?: string;
  feishuEventSubscriptionEnabled?: boolean;
  feishuWebhookPort?: number;
  feishuWebhookPath?: string;
  heartbeatIntervalSeconds?: number;
  heartbeatMessage?: string;
  heartbeatSkipWhenAgentBusy?: boolean;
  personaAutomationScriptsEnabled?: boolean;
  remoteAgentDefaultDeviceId?: string;
  remoteAgentDefaultCwd?: string;
  remoteAgentDefaultThreadName?: string;
  napcatHttpUrl?: string;
  napcatWebuiUrl?: string;
  napcatAccessToken?: string;
  napcatWebuiToken?: string;
  napcatInstances?: NapCatInstanceDefinition[];
  ignoredNapcatInstanceIds?: string[];
  targetGroupId?: string;
  pipelinePreset?: string;
  pipeline?: PipelineDefinition;
  routeVariables?: Record<string, string>;
  routeName?: string;
  agentModel?: string;
  agentReasoningEffort?: CodexReasoningEffort;
  codexThreadId?: string;
  codexThreadName?: string;
  codexCwd?: string;
  dshSessionId?: string;
  dshSessionName?: string;
  dshCwd?: string;
  dshBaseUrl?: string;
  dshModelProvider?: string;
  dshModel?: string;
  dshReasoningEffort?: string;
  codexPlanAssistantEnabled?: boolean;
  codexPlanAssistantModel?: string;
  codexPlanAssistantSessions?: CodexPlanAssistantSession[];
  codexMemoryConsolidationAgentEnabled?: boolean;
  codexMemoryConsolidationAgentModel?: string;
  codexHooks?: CodexHookSettings;
  copilotThreadName?: string;
  copilotCwd?: string;
  copilotCliBin?: string;
  marvisAppId?: string;
  astrbotUrl?: string;
  astrbotUsername?: string;
  astrbotPassword?: string;
  astrbotProjectId?: string;
  astrbotSessionId?: string;
  rolesDir?: string;
  routesDir?: string;
  configName?: string;
  agentRoleId?: string;
  agentRoleFile?: string;
  agentAdapters?: AgentAdapterType[];
  primaryAgentAdapter?: AgentAdapterType;
  messageProcessingAgents?: MessageProcessingAgentPolicies;
  routeProfiles?: RouteProfileDefinition[];
  dataDir?: string;
  groupNotificationTemplate?: string;
  groupAtNotificationTemplate?: string;
  groupDirectReplyNotificationTemplate?: string;
  groupIndirectReplyNotificationTemplate?: string;
  groupReplyNotificationTemplate?: string;
  groupNicknameNotificationTemplate?: string;
  privateNotificationTemplate?: string;
  heartbeatNotificationTemplate?: string;
  voiceTranscriptNotificationTemplate?: string;
  recentMessageLimit?: number;
  recentMessageLimits?: RecentMessageLimits;
  speechPushMode?: SpeechPushMode;
  speechTriggerKeywords?: string[];
  languageStyle?: import("../shared/languageStyle.js").LanguageStyleBinding;
  automationRules?: PersonaAutomationRuleDefinition[];
  notificationRules?: NotificationRuleDefinition[];
  roleNotificationRules?: Record<string, NotificationRuleDefinition[]>;
  roleRouteNames?: Record<string, string>;
};

type RouteProfileDefinition = {
  id: string;
  name?: string;
  enabled?: boolean;
  recentMessageLimit?: number;
  recentMessageLimits?: RecentMessageLimits;
  speechPushMode?: SpeechPushMode;
  speechTriggerKeywords?: string[];
  languageStyle?: import("../shared/languageStyle.js").LanguageStyleBinding;
  pipelinePreset?: string;
  pipeline?: PipelineDefinition;
  agentRoleId?: string;
  agentRoleFile?: string;
  rolesDir?: string;
  dataDir?: string;
  routeVariables?: Record<string, string>;
  automationRules?: PersonaAutomationRuleDefinition[];
  personaAutomationScriptsEnabled?: boolean;
  notificationRules?: NotificationRuleDefinition[];
};

type NotificationRuleDefinition = {
  id: string;
  name?: string;
  enabled?: boolean;
  routeKinds?: string[];
  targetGroupId?: string;
  allowedSpeakerNames?: string[];
  regex?: string;
  schedules?: NotificationScheduleDefinition[];
  template: string;
};

type NotificationScheduleDefinition = {
  id: string;
  name?: string;
  enabled?: boolean;
  type: "interval" | "daily_time" | "once_at";
  intervalSeconds?: number;
  windowStartTime?: string;
  windowEndTime?: string;
  timeOfDay?: string;
  onceAt?: string;
};

type GatewayConfigFile = {
  gateways: GatewayDefinition[];
};

type AgentMessageSource = RabiAgentMessageSource;

function agentMessageSourceForSession(
  sessionIdInput: unknown,
  sessionNameInput?: unknown,
  agentAdapter: AgentAdapterType = "codex",
  agentType?: string,
  workspace?: string
): AgentMessageSource {
  const sessionId = String(sessionIdInput || "").trim();
  if (!sessionId) throw new Error("Agent message source requires a source session id.");
  const sessionName = String(sessionNameInput || "").trim();
  if (!sessionName) throw new Error("Agent message source requires a source session name.");
  return {
    type: "agent",
    agentAdapter: isDshSessionId(sessionId) ? "dsh" : agentAdapter,
    agentType,
    sessionId,
    sessionName,
    workspace: String(workspace || "").trim() || undefined
  };
}

function primaryAgentMessageSource(definition: GatewayDefinition): AgentMessageSource {
  const agentAdapter = definition.primaryAgentAdapter
    || normalizeAgentAdapters(definition.agentAdapters)[0]
    || "codex";
  const sessionId = agentAdapter === "dsh" ? definition.dshSessionId : definition.codexThreadId;
  const sessionName = agentAdapter === "dsh"
    ? definition.dshSessionName
    : definition.codexThreadName;
  const workspace = agentAdapter === "dsh" ? definition.dshCwd : definition.codexCwd;
  return agentMessageSourceForSession(sessionId, sessionName, agentAdapter, "主人格 Agent", workspace);
}

function planMessageSource(
  planIdInput: unknown,
  planNameInput: unknown,
  sourceAgent?: AgentMessageSource
): RabiMessageSource {
  const planId = canonicalLogicalPlanId(planIdInput);
  const planName = String(planNameInput || "").trim();
  if (!planName) throw new Error("Plan message source requires planName.");
  const { type: _type, ...agentIdentity } = sourceAgent || {} as AgentMessageSource;
  return {
    type: "plan",
    planId,
    planName,
    ...(sourceAgent ? { sourceAgent: agentIdentity } : {})
  };
}

function primaryAgentWorkspace(definition: GatewayDefinition): string | undefined {
  const adapter = definition.primaryAgentAdapter || normalizeAgentAdapters(definition.agentAdapters)[0];
  return adapter === "dsh" ? definition.dshCwd : adapter === "codex" ? definition.codexCwd : undefined;
}

function primaryAgentSessionId(definition: GatewayDefinition): string | undefined {
  const adapter = definition.primaryAgentAdapter || normalizeAgentAdapters(definition.agentAdapters)[0];
  return adapter === "dsh" ? definition.dshSessionId : adapter === "codex" ? definition.codexThreadId : undefined;
}

function runtimeOwnsAgentSession(runtime: GatewayRuntime, sessionId: string): boolean {
  const id = sessionId.trim();
  if (!id) return false;
  if (String(runtime.definition.codexThreadId || "").trim() === id) return true;
  if (String(runtime.definition.dshSessionId || "").trim() === id) return true;
  if ((runtime.definition.codexPlanAssistantSessions ?? []).some((session) => session.threadId === id)) return true;
  const target = currentMessageProcessingTargetByThreadId(id);
  if (target && runtimeForMessageProcessingTarget(target)?.definition.id === runtime.definition.id) return true;
  const roleId = roleIdForDefinition(runtime.definition);
  if (!roleId) return false;
  const roleDir = roleDirForApi(roleId);
  const plans = publishedRolePlans(roleDir);
  if (!plans) {
    requestRoleKnowledgeCatalogRefresh(roleDir);
    return false;
  }
  return plans.some((plan) => plan.taskBinding?.sessionId === id || plan.secretaryBinding?.sessionId === id);
}

function runtimeForAgentThreadRequest(request: AgentThreadRequest): GatewayRuntime | undefined {
  const sourceAgent = request.messageSource
    ? agentIdentityForMessageSource(request.messageSource)
    : undefined;
  const runtimeList = [...runtimes.values()];
  const requestSessionIds = [request.threadId, sourceAgent?.sessionId, request.sourceThreadId]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  const routeId = selectAgentThreadRouteId({
    targetSessionId: request.threadId,
    messageSourceSessionId: sourceAgent?.sessionId,
    sourceThreadId: request.sourceThreadId,
    needsDsh: request.agentAdapter === "dsh"
      || sourceAgent?.agentAdapter === "dsh"
      || requestSessionIds.some((id) => isDshSessionId(id)),
    workspace: request.cwd
  }, runtimeList.map((runtime) => ({
    id: runtime.definition.id,
    ownedSessionIds: requestSessionIds.filter((id) => runtimeOwnsAgentSession(runtime, id)),
    supportsDsh: normalizeAgentAdapters(runtime.definition.agentAdapters).includes("dsh"),
    dshWorkspaces: [
      runtime.definition.dshCwd,
      ...(runtime.definition.codexPlanAssistantSessions ?? [])
        .filter((session) => planAssistantSessionAgentAdapter(session) === "dsh")
        .map((session) => session.workspace)
    ].map((value) => String(value || "").trim()).filter(Boolean)
  })));
  return routeId ? runtimes.get(routeId) : undefined;
}

function agentThreadRequestOptions(
  request: AgentThreadRequest,
  extra: Partial<AgentThreadRequestOptions> = {}
): AgentThreadRequestOptions {
  const runtime = runtimeForAgentThreadRequest(request);
  const explicitDshBaseUrl = String(request.dshBaseUrl || "").trim();
  return {
    allowedWorkspaces: agentThreadAllowedWorkspaces(),
    defaultWorkspace: rootDir,
    ...(explicitDshBaseUrl
      ? { dshBaseUrl: explicitDshBaseUrl }
      : runtime?.definition.dshBaseUrl
        ? { dshBaseUrl: runtime.definition.dshBaseUrl }
        : {}),
    ...extra
  };
}

type AgentRuntimeState = Record<string, unknown> & {
  agentAdapterType: AgentAdapterType;
};

type AgentStateReportRequest = {
  gatewayId?: string;
  adapterType?: AgentAdapterType;
  generation?: string;
  sequence?: number;
  state?: Record<string, unknown>;
};

type NapCatInstanceDefinition = {
  id: string;
  name?: string;
  enabled?: boolean;
  autoLoginOnRabiStart?: boolean;
  gatewayPort: number;
  httpUrl: string;
  webuiUrl?: string;
  accessToken?: string;
  webuiToken?: string;
  launchCommand?: string;
  workingDir?: string;
  botNickname?: string;
};

const managerRuntimeLayout = resolveRuntimeLayout(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
);
const packageRoot = managerRuntimeLayout.packageRoot;
const rootDir = managerRuntimeLayout.stateRoot;
const managerHostIdentity = managerHostIdentityFromEnvironment();
const managerPortPolicy = parseManagerPortPolicy(process.env.GATEWAY_MANAGER_PORT);
let managerPort = managerPortPolicy.mode === "fixed" ? managerPortPolicy.port : 0;
let managerBaseUrl = managerPort > 0 ? `http://127.0.0.1:${managerPort}` : "";
let managerInstanceId = "";
let managerPluginGenerationStatus: Readonly<{
  id: string;
  sequence: number;
  readiness: Readonly<{ state: "ready" | "degraded"; missingCapabilities: readonly string[] }>;
}> | undefined;
let managerLanDiscoveryStatus: ManagerDiscoveryStatus = Object.freeze({
  state: "disabled",
  serviceType: "_rabiroute._tcp.local"
});
type ActiveStorageLifecycleGeneration = Readonly<{
  roleStorage: RoleStorageApplication;
  planStorage: PlanStorageStartupLifecycle;
  routeCatalog: RouteCatalogStartupLifecycle;
  requestHandler: http.RequestListener;
}>;

let activeStorageLifecycleGeneration: ActiveStorageLifecycleGeneration | undefined;

function planStorageStartupStatus(): PlanStorageStartupLifecycleSnapshot {
  return activeStorageLifecycleGeneration?.planStorage.snapshot() ?? Object.freeze({
    state: "idle",
    attempt: 0,
    incidents: 0,
    lastTransitionAt: new Date().toISOString()
  });
}

function routeCatalogStartupStatus(): RouteCatalogStartupLifecycleSnapshot {
  return activeStorageLifecycleGeneration?.routeCatalog.snapshot() ?? Object.freeze({
    state: "idle",
    attempt: 0,
    incidents: 0,
    lastTransitionAt: new Date().toISOString()
  });
}
const managerHttpLimits = {
  requestTimeoutMs: 30_000,
  headersTimeoutMs: 10_000,
  keepAliveTimeoutMs: 5_000,
  maxRequestsPerSocket: 100
} as const;
const managerOperationalLog = createManagerOperationalLog({ rootDir });
const uninstallDataMutationAuditSink = installOperationalMutationAuditSink(managerOperationalLog, rootDir);
const messageProcessingBoardPersistence = new CoalescingMessageProcessingBoardPersistence(
  messageProcessingBoardStatePath(rootDir),
  {
    onCommitted: (state, durationMs) => {
      const revision = state && typeof state === "object" && !Array.isArray(state)
        ? String((state as { updatedAt?: unknown }).updatedAt ?? "").trim() || undefined
        : undefined;
      recordDataMutationAudit({
        group: "message.processing",
        event: "message_processing_snapshot_committed",
        owner: "CoalescingMessageProcessingBoardPersistence",
        action: "persist_snapshot",
        target: { type: "message_processing_board", id: "board" },
        dataSource: { kind: "file", id: "data/.runtime/message-processing-board.json" },
        outcome: "committed",
        after: revision ? { revision } : undefined,
        durationMs
      });
    },
    onError: error => {
      recordDataMutationAudit({
        level: "error",
        group: "message.processing",
        event: "message_processing_snapshot_commit_failed",
        owner: "CoalescingMessageProcessingBoardPersistence",
        action: "persist_snapshot",
        target: { type: "message_processing_board", id: "board" },
        dataSource: { kind: "file", id: "data/.runtime/message-processing-board.json" },
        outcome: "failed",
        error
      });
    }
  }
);
const messageProcessingBoard = new MessageProcessingBoardStore(messageProcessingBoardPersistence);
const agentRequests = new AgentRequestStore(agentRequestStatePath(rootDir));
let messageProcessingAutomationService: MessageProcessingAutomationService | undefined;
let knowledgeCallbackReminderService: KnowledgeCallbackReminderService<MessageProcessingRequirement> | undefined;
const managerRequestContexts = new WeakMap<http.ServerResponse, {
  requestId: string;
  method: string;
  pathname: () => string;
  startedAt: number;
  responseBytes?: number;
}>();
const rabiGlobalConfig = new RabiGlobalConfigStore(rootDir);
const managerReadOnly = managerReadOnlyEnabled();
const managerHostOverride = process.env.GATEWAY_MANAGER_HOST?.trim() || "";
const managerHost = managerHostOverride || (!managerReadOnly && rabiGlobalConfig.read().webguiLan.enabled ? "0.0.0.0" : "127.0.0.1");
const managerShouldAutostart = !managerReadOnly && managerAutostartEnabled();
const remoteAgentPublicHost = process.env.REMOTE_AGENT_PUBLIC_HOST || process.env.GATEWAY_MANAGER_PUBLIC_HOST || "";
const configRepository = new ManagerConfigRepository({ rootDir, managerPort });
const napcatProcessOwner = new NapcatLifecycleOwner({
  statePath: path.join(rootDir, "data", ".runtime", "napcat-process-ownership.json"),
  driver: createNapcatProcessDriver(async binding => {
    const instance = sharedNormalizeNapCatInstances(runtimes.get(binding.gatewayId)?.definition ?? { id: binding.gatewayId } as GatewayDefinition)
      .find(item => item.id === binding.instanceId && item.httpUrl === binding.httpUrl);
    if (instance) await requestNapcatBotExit(instance.httpUrl, instance.accessToken);
  }),
  log: (event, detail) => managerOperationalLog.record("info", event, { result: detail })
});

const managerEventClients = new Map<http.ServerResponse, NodeJS.Timeout>();

function removeManagerEventClient(response: http.ServerResponse): void {
  const keepAlive = managerEventClients.get(response);
  if (keepAlive) clearInterval(keepAlive);
  managerEventClients.delete(response);
}

export function closeManagerEventClients(): void {
  for (const response of [...managerEventClients.keys()]) {
    removeManagerEventClient(response);
    if (!response.writableEnded && !response.destroyed) response.end();
  }
}

function publishManagerEvent(eventType: string, data: unknown): void {
  const frame = `event: ${eventType.replace(/[^a-zA-Z0-9_.:-]/g, "_")}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const response of [...managerEventClients.keys()]) {
    if (response.writableEnded || response.destroyed) removeManagerEventClient(response);
    else response.write(frame);
  }
}

function openManagerEventStream(request: http.IncomingMessage, response: http.ServerResponse): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  response.write("retry: 3000\n\nevent: ready\ndata: {}\n\n");
  // event-driven-allow: SSE protocol keepalive; no business state is queried.
  const keepAlive = setInterval(() => {
    if (!response.writableEnded) response.write(`: keepalive ${Date.now()}\n\n`);
  }, 15000);
  keepAlive.unref();
  managerEventClients.set(response, keepAlive);
  const removeClient = () => removeManagerEventClient(response);
  request.once("close", removeClient);
  response.once("close", removeClient);
}

export type ManagerSignalTarget = {
  on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
};

export function installManagerSignalHandlers(
  shutdown: (reason: "SIGINT" | "SIGTERM") => void,
  target: ManagerSignalTarget = process
): () => void {
  const onSigint = () => shutdown("SIGINT");
  const onSigterm = () => shutdown("SIGTERM");
  target.on("SIGINT", onSigint);
  target.on("SIGTERM", onSigterm);
  let installed = true;
  return () => {
    if (!installed) return;
    installed = false;
    target.removeListener("SIGINT", onSigint);
    target.removeListener("SIGTERM", onSigterm);
  };
}

export function listenManagerServer(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      server.removeListener("error", onError);
      server.removeListener("listening", onListening);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onListening = (): void => {
      cleanup();
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    try {
      server.listen(port, host);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

let personaSyncAutoReconciler: PersonaSyncAutoReconciler | undefined;

function relayReceiptText(value: unknown, maxLength = 160): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function relayReceiptAuditData(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const state = relayReceiptText(data.state, 32);
  if (!new Set(["delivered", "played", "playback_failed"]).has(state)) return undefined;
  const deliveryId = relayReceiptText(data.deliveryId);
  const messageId = relayReceiptText(data.messageId);
  const deviceId = relayReceiptText(data.deviceId);
  if ((!deliveryId && !messageId) || !deviceId) return undefined;
  const receiptAt = Number(data.receiptAt);
  return {
    ...(messageId ? { messageId } : {}),
    ...(deliveryId ? { deliveryId } : {}),
    deviceId,
    deviceKind: relayReceiptText(data.deviceKind, 64),
    state,
    ...(Number.isFinite(receiptAt) && receiptAt > 0 ? { receiptAt } : {}),
    routeProfileId: relayReceiptText(data.routeProfileId)
  };
}

function runtimeForAgentSendRoute(routeId: string): GatewayRuntime | undefined {
  const exact = runtimes.get(routeId);
  if (exact) return exact;
  return [...runtimes.values()].find((runtime) =>
    (runtime.definition.routeProfiles ?? []).some((profile) => profile.id === routeId)
  );
}

function routeOwnsRabiLinkReceipt(definition: GatewayDefinition, routeProfileId: string): boolean {
  const adapters = definition.messageAdapters ?? [definition.messageAdapterType ?? "napcat"];
  if (!adapters.includes("rabilink")) return false;
  if (!routeProfileId) return definition.enabled !== false;
  return definition.id === routeProfileId
    || (definition.routeProfiles ?? []).some((profile) => profile.id === routeProfileId);
}

function recordRabiLinkRelayReceipt(data: Record<string, unknown>): void {
  const receipt = relayReceiptAuditData(data);
  if (!receipt) return;
  const routeProfileId = String(receipt.routeProfileId || "");
  for (const runtime of runtimes.values()) {
    if (!routeOwnsRabiLinkReceipt(runtime.definition, routeProfileId)) continue;
    appendAdapterLogToDir("rabilink", {
      event: "outbox_receipt",
      message: `RabiLink device reported ${String(receipt.state)}.`,
      data: receipt
    }, dataDirFor(runtime.definition));
  }
  publishManagerEvent("rabilink_outbox_receipt", receipt);
}

const rabiLinkRelayRuntime = new RabiLinkRelayRuntime({
  onStatus: status => {
    publishManagerEvent("rabilink_status", status);
    personaSyncAutoReconciler?.noteRelayStatus(status.state);
  },
  onEvent: (eventType, data) => {
    personaSyncAutoReconciler?.noteRelayEvent(eventType);
    if (eventType === "outbox_receipt") recordRabiLinkRelayReceipt(data);
  }
});

function readManagerConfig(): ManagerConfig {
  return configRepository.readManagerConfig();
}

function writeManagerConfig(cfg: ManagerConfig): void {
  configRepository.writeManagerConfig(cfg);
  routeRoot = configRepository.routeRoot;
  rolesRoot = configRepository.rolesRoot;
}

let rolesRoot = configRepository.rolesRoot;
let routeRoot = configRepository.routeRoot;
let routeCatalogConfig: GatewayConfigFile = { gateways: [] };
let routeCatalogPersonaPresentations: readonly RouteCatalogPersonaPresentation[] = Object.freeze([]);
let roleKnowledgeCatalogsReady = false;
let personaMessageAuthority: PersonaMessageAuthority | undefined;
const messageProcessingSendContextReview = new MessageProcessingSendContextReview({
  getRequirement: (requirementId) => messageProcessingBoard.getRequirement(requirementId),
  findRequirementBySourceMessage: (routeId, messageId) => messageProcessingBoard.findLatestBySourceMessage(routeId, messageId),
  findRequirementsBySourceMessage: (routeId, messageId) => messageProcessingBoard.findBySourceMessage(routeId, messageId),
  loadContext: (requirement, sourceMessageId) => {
    const roleId = String(requirement.source.roleId || "").trim();
    if (!roleId) return [];
    return loadMessageProcessingContext({
      roleDir: roleDirForApi(roleId),
      requirement,
      sourceMessageId
    });
  }
});

function currentPersonaMessageAuthority(): PersonaMessageAuthority {
  personaMessageAuthority ??= loadPersonaMessageAuthority(rootDir);
  return personaMessageAuthority;
}
const agentCompletionDelivery = new AgentCompletionDeliveryService({
  rules: () => {
    const roles = new Set<string>();
    return [...runtimes.values()].flatMap(runtime => {
      const roleId = sanitizeRoleId(runtime.definition.agentRoleId);
      if (!roleId || roles.has(roleId) || runtime.definition.enabled === false) return [];
      roles.add(roleId);
      return (runtime.definition.codexHooks?.completionDeliveries ?? []).map(rule => ({ roleId, rule }));
    });
  },
  taskContext: ({ roleId }, request) => {
    const plans = listPlans(roleDirForApi(roleId));
    let taskName: string | undefined;
    try { taskName = readCodexDesktopThread(request.sessionId)?.title?.trim(); }
    catch (error) {
      managerOperationalLog.record("warn", "completion_task_title_unavailable", {
        action: request.sessionId, error: managerOperationalError(error, rootDir)
      });
    }
    return completionTaskContextFromPlans(request.sessionId, plans, taskName);
  },
  deliver: async ({ rule }, hook, deliveryId, context) => {
    const runtime = runtimes.get(rule.destination.gatewayId);
    if (!runtime || runtime.definition.enabled === false) throw new Error("目标消息路线未启用。");
    const instances = runtime.definition.napcatInstances ?? sharedNormalizeNapCatInstances(runtime.definition);
    const instance = instances.find(item => item.id === rule.destination.params.instanceId && item.enabled !== false);
    if (rule.destination.channel === "napcat" && !instance) throw new Error("目标 QQ 账号未启用或已被移除。");
    const options = {
      rootDir, routeRoot, rolesRoot, publishEvent: publishManagerEvent, speechServiceUrl: speechServiceUrl(),
      runtimes: [{ ...runtime.definition, napcatInstances: instances.map(item => ({ ...item, accessToken: item.accessToken ?? "" })) }]
    };
    await deliverCompletionToEndpoint(rule, hook, deliveryId,
      runtime.definition.routeProfiles?.[0]?.id || runtime.definition.id, options, context);
  }
});
const codexHookContextService = new CodexHookContextService({
  deliverAgentCompletion: async request => {
    const results = await agentCompletionDelivery.handle(request);
    for (const result of results) {
      managerOperationalLog.record(result.status === "failed" ? "warn" : "info", "agent_completion_delivery", {
        action: result.ruleId, outcome: result.status, result: result.reason
      });
    }
    return results;
  },
  rolesRoot: () => rolesRoot,
  storePath: path.join(rootDir, "data", "codex-hook", "sessions.json"),
  deliverPlanTaskCompletion,
  hookEnabled: codexHookEnabled,
  isManagedAgentSession,
  recordAgentRequestStop,
  findPangHuProgressIssue,
  deliverPangHuProgressNotification,
  chatHistoryRoleIds: request => [...gatewayIdsForManagedSession(request.sessionId, request.cwd)]
    .map(id => sanitizeRoleId(runtimes.get(id)?.definition.agentRoleId))
    .filter((roleId): roleId is string => Boolean(roleId)),
  onChatHistoryChanged: roleId => publishManagerEvent("persona_chat_history_changed", { roleId }),
  planStorageReady: () => planStorageStartupStatus().state === "ready"
});
const languageStyleValidator = new LanguageStyleValidator();
const fenneNotePlaybackUrl = process.env.FENNOTE_PLAYBACK_URL?.trim() ?? "";
const fenneNoteReplyUrl = process.env.FENNOTE_REPLY_URL?.trim() ?? "";
const fenneNotePlaybackToken = process.env.FENNOTE_PLAYBACK_TOKEN ?? "";
const fenneNoteReplyToken = process.env.FENNOTE_REPLY_TOKEN ?? fenneNotePlaybackToken;
const webuiDistPath = path.join(packageRoot, "ribiwebgui", "dist");
const runtimes = new RuntimeRegistry();
const persistedPerformanceConfig = rabiGlobalConfig.read().performance;
const performanceMonitoring = new PerformanceMonitoringService(rootDir, managerReadOnly
  ? { ...persistedPerformanceConfig, enabled: false }
  : persistedPerformanceConfig);
let memoryConsolidationScheduler: MemoryConsolidationScheduler | undefined;
const planTaskCompletionDelivery = createPlanTaskCompletionDelivery<GatewayRuntime>({
  getRuntime: gatewayId => runtimes.get(gatewayId),
  listRuntimes: () => [...runtimes.values()],
  roleIdForDefinition,
  triggerRolePanelMessage: triggerGatewayRolePanelMessage,
  appendTimeline: appendRolePanelTimeline,
  assignSecretary: async (runtime, delivery) => (await ensurePlanSecretaryTarget(
    runtime,
    delivery.roleId,
    delivery.plan,
    `completion:${delivery.sourceSessionId}:${delivery.sourceTurnId}`
  )).target,
  sendToSecretary: sendPlanTaskCompletionToSecretary,
  publishEvent: publishManagerEvent
});
const speechIngressStore = new SpeechIngressStore(
  path.join(rootDir, "data", "speech", "messages"),
  path.join(rootDir, "data", "speech", "deliveries")
);
const personaSyncService = new PersonaSyncService(
  () => rolesRoot,
  path.join(rootDir, "data", "persona-sync"),
  {
    readOnly: managerReadOnly,
    watch: managerShouldAutostart,
    reconcileOnQueryFallback: !managerReadOnly,
    scanExecutionMode: managerReadOnly ? "inline" : "child_process",
    autoStart: !managerReadOnly,
    onEvent: event => {
      publishManagerEvent("persona_sync_manifest_changed", event);
      personaSyncAutoReconciler?.noteManifestEvent(event);
    }
  }
);
const personaSyncCoordinator = new PersonaSyncCoordinator(
  personaSyncService,
  path.join(rootDir, "data", "persona-sync"),
  () => {
    const config = rabiGlobalConfig.read();
    const relay = rabiLinkRelayConfigForMeta();
    return {
      url: relay.url,
      token: relay.token,
      deviceId: relay.deviceId,
      deviceGuid: config.rabiGuid
    };
  }
);
personaSyncAutoReconciler = new PersonaSyncAutoReconciler(
  personaSyncCoordinator,
  path.join(rootDir, "data", "persona-sync"),
  {
    enabled: managerShouldAutostart,
    onStatus: status => publishManagerEvent("persona_sync_auto_status", status)
  }
);
function personaSyncRouteContext(controlPlaneAuthorized = false): PersonaSyncRouteContext {
  return {
    service: personaSyncService,
    coordinator: personaSyncCoordinator,
    autoReconciler: personaSyncAutoReconciler!,
    listConflicts: roleId => personaSyncService.listConflictsUsing(roleId, requestedRoleId =>
      managerCatalogWorkerPool.queryPersonaSyncConflicts(
        rolesRoot,
        path.join(rootDir, "data", "persona-sync"),
        requestedRoleId
      )),
    readOnlySnapshot: managerReadOnly,
    controlPlaneAuthorized,
    planStorageStartup: planStorageStartupStatus,
    token: () => rabiLinkRelayConfigForMeta().token,
    relay: () => {
      const config = rabiGlobalConfig.read();
      const relay = rabiLinkRelayConfigForMeta();
      return {
        url: relay.url,
        token: relay.token,
        deviceId: relay.deviceId,
        deviceGuid: config.rabiGuid
      };
    }
  };
}
const personaSyncLanServer = new PersonaSyncLanServer(personaSyncRouteContext(), {
  port: Number(process.env.RABILINK_PERSONA_SYNC_LAN_PORT ?? 0),
  onStatus: status => publishManagerEvent("persona_sync_lan_status", status)
});
const selectionSpeechSettings = new SelectionSpeechSettingsStore(selectionSpeechSettingsPath(rootDir));
const desktopSettings = new DesktopSettingsStore(desktopSettingsPath(rootDir));
const speechControl = new ManagerSpeechControl({
  serviceUrl: () => speechServiceUrl(),
  personas: routeCatalogPersonas,
  route: (routeId) => {
    const runtime = runtimes.get(routeId);
    return runtime
      ? {
          id: runtime.definition.id,
          speechEnabled: runtime.definition.enabled !== false && sharedGatewayAdapterTypes(runtime.definition).includes("speech"),
          rabiLinkEnabled: runtime.definition.enabled !== false && sharedGatewayAdapterTypes(runtime.definition).includes("rabilink"),
          routeProfileIds: runtime.definition.routeProfiles?.map(profile => profile.id) ?? [runtime.definition.id]
        }
      : undefined;
  },
  routes: () => runtimes.values().map(runtime => ({
    id: runtime.definition.id,
    speechEnabled: runtime.definition.enabled !== false && sharedGatewayAdapterTypes(runtime.definition).includes("speech"),
    rabiLinkEnabled: runtime.definition.enabled !== false && sharedGatewayAdapterTypes(runtime.definition).includes("rabilink"),
    routeProfileIds: runtime.definition.routeProfiles?.map(profile => profile.id) ?? [runtime.definition.id]
  })),
  deliverTranscript: ({ routeId, record }) => {
    const runtime = runtimes.get(routeId);
    if (!runtime) return Promise.reject(new Error(`Speech Route disappeared before delivery: ${routeId}`));
    return triggerGatewaySpeechMessage(runtime, record);
  },
  appendRouteLog: (routeId, message) => {
    const runtime = runtimes.get(routeId);
    if (runtime) appendLog(runtime, message);
  },
  speechIngressStore
});
const speechRuntimeControl = new SpeechRuntimeControl({
  rootDir,
  serviceUrl: () => speechServiceUrl()
});
const agentStateByGateway = new Map<string, Partial<Record<AgentAdapterType, AgentRuntimeState>>>();
const remoteAgentToken = process.env.REMOTE_AGENT_TOKEN?.trim() || "";
let remoteAgentHub: RemoteAgentHub | undefined;
let agentAdapterCatalogService: AgentAdapterCatalogService | undefined;
let watchedConfigSnapshot = "";
// Route catalog mutations already apply their committed snapshot to the live
// Manager. The config watcher observes that same durable write later; consuming
// that one echo prevents a second lifecycle recapture and Gateway restart.
let pendingManagedConfigWatchEchoes = 0;
let configWatchLifecycle: ManagerWatchBrokerStatus = disabledManagerWatchBrokerStatus();
let pluginPackageWatchLifecycle: ManagerWatchBrokerStatus = disabledManagerWatchBrokerStatus();

function headerValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function remoteAgentRequestToken(request: http.IncomingMessage, requestUrl: URL): string {
  const bearer = headerValue(request.headers.authorization).match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || "";
  return requestUrl.searchParams.get("token")?.trim()
    || headerValue(request.headers["x-remote-agent-token"]).trim()
    || bearer;
}

function isRemoteAgentRequestAuthorized(request: http.IncomingMessage, requestUrl: URL): boolean {
  if (isLoopbackRemoteAddress(request.socket.remoteAddress)) return true;
  if (isWebguiLanRequestAuthorized(request, requestUrl, rabiGlobalConfig.read().webguiLan)) return true;
  if (!remoteAgentToken) return false;
  return remoteAgentRequestToken(request, requestUrl) === remoteAgentToken;
}

function remoteRequestUsesIndependentAuthorization(request: http.IncomingMessage, requestUrl: URL): boolean {
  return requestUrl.pathname.startsWith("/api/remote-agent/")
    && isRemoteAgentRequestAuthorized(request, requestUrl);
}

function webguiLanRequestAllowed(request: http.IncomingMessage, requestUrl: URL): boolean {
  if (
    !managerListensOnLan(managerHost)
    || isLocalMachineRemoteAddress(request.socket.remoteAddress, localIpv4AddressEntries().map(item => item.address))
  ) return true;
  if (isPublicWebguiStaticRequest(request.method, requestUrl.pathname)) return true;
  if (remoteRequestUsesIndependentAuthorization(request, requestUrl)) return true;
  if (requestUrl.pathname.startsWith("/api/lan-agent/releases/") && request.method === "GET") {
    const authorization = Array.isArray(request.headers.authorization) ? request.headers.authorization[0] ?? "" : request.headers.authorization ?? "";
    const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? "";
    return webguiTokenMatches(token, rabiGlobalConfig.read().webguiLan.accessToken);
  }
  return isWebguiLanRequestAuthorized(request, requestUrl, rabiGlobalConfig.read().webguiLan);
}

function definitionFingerprint(definition: GatewayDefinition): string {
  return JSON.stringify(definition);
}

function routeCatalogMutationFailure(
  error: unknown
): Error & { statusCode: number; code: string } {
  const conflict = error instanceof RouteCatalogOperationError
    && error.code === "ROUTE_CATALOG_REVISION_CONFLICT";
  return Object.assign(new Error(conflict
    ? "Route catalog changed; refresh and retry this update."
    : "Route catalog update is temporarily unavailable."), {
    statusCode: conflict ? 409 : 503,
    code: conflict ? "route_catalog_conflict" : "route_catalog_unavailable",
    cause: error
  });
}

function routeCatalogVersion(): Readonly<{
  contentHash: string;
  routeConfigHash: string;
  presentationHash: string;
  revision: number;
}> {
  const snapshot = routeCatalogStartupStatus();
  return Object.freeze({
    // Compatibility: public contentHash remains the route mutation CAS token.
    contentHash: snapshot.routeConfigHash ?? "",
    routeConfigHash: snapshot.routeConfigHash ?? "",
    presentationHash: snapshot.presentationHash ?? "",
    revision: snapshot.revision ?? 0
  });
}

function routeCatalogPersonas(): RouteCatalogSnapshot["personas"] {
  return routeCatalogPersonaPresentations;
}

function requireRouteCatalogLifecycle(): RouteCatalogStartupLifecycle {
  if (!activeStorageLifecycleGeneration) {
    throw routeCatalogMutationFailure(new Error("Route catalog lifecycle is unavailable."));
  }
  return activeStorageLifecycleGeneration.routeCatalog;
}

async function ensureDataDirs(): Promise<void> {
  try {
    await requireRouteCatalogLifecycle().recapture();
  } catch (error) {
    throw routeCatalogMutationFailure(error);
  }
}

function readConfig(): GatewayConfigFile {
  return structuredClone(routeCatalogConfig);
}

async function removeGatewayConfig(
  id: string,
  expectedContentHash: string | undefined,
  operationId: string
): Promise<void> {
  const decodedId = decodeURIComponent(id);
  const runtime = runtimes.get(decodedId);
  const configName = runtime
    ? sanitizeConfigName(runtime.definition.configName) || routeRuntimeParts(runtime.definition.id).configName
    : routeRuntimeParts(decodedId).configName || sanitizeConfigName(decodedId);
  if (!configName) {
    throw new Error(`Invalid gateway id: ${decodedId}`);
  }
  try {
    await requireRouteCatalogLifecycle().remove(configName, expectedContentHash, operationId);
    pendingManagedConfigWatchEchoes += 1;
  } catch (error) {
    throw routeCatalogMutationFailure(error);
  }
}

async function writeConfig(
  config: GatewayConfigFile,
  expectedContentHash: string | undefined,
  operationId: string
): Promise<GatewayConfigFile> {
  if (!Array.isArray(config.gateways)) {
    throw new Error("routes must be an array");
  }

  config.gateways.forEach(validateNapcatRouteCardinality);
  const normalized = { gateways: config.gateways.map(normalizeDefinition) };
  validateNapcatBindings(routeNapcatBindings(normalized.gateways));
  sharedAutoAssignGatewayPorts(normalized.gateways, managerPort);
  sharedValidateGatewayPortConflicts(normalized.gateways);
  try {
    await requireRouteCatalogLifecycle().replace(normalized, expectedContentHash, operationId);
    pendingManagedConfigWatchEchoes += 1;
    return readConfig();
  } catch (error) {
    throw routeCatalogMutationFailure(error);
  }
}

function normalizeDefinition(definition: GatewayDefinition): GatewayDefinition {
  return sharedNormalizeGatewayDefinition(definition, {
    managerPort,
    routeDataDir: (configName) => path.relative(rootDir, routeFolderPath(routeRoot, configName)).replace(/\\/g, "/"),
    rolesDir: path.relative(rootDir, rolesRoot).replace(/\\/g, "/"),
    normalizeAgentAdapters: (adapters) => normalizeAgentAdapters(adapters),
    normalizePipeline: (pipeline) => normalizePipelineDefinition(pipeline) as GatewayDefinition["pipeline"]
  }) as GatewayDefinition;
}

function normalizeCodexCwd(value: unknown): string | undefined {
  return resolvePersistedProjectPath(value, rootDir);
}

function resolveCodexThreadName(definition: GatewayDefinition): string {
  return definition.codexThreadName?.trim()
    || definition.routeName?.trim()
    || definition.name?.trim()
    || routeRuntimeParts(definition.id).configName
    || definition.id;
}

function resolveCopilotThreadName(definition: GatewayDefinition): string {
  return definition.copilotThreadName?.trim()
    || definition.routeName?.trim()
    || definition.name?.trim()
    || routeRuntimeParts(definition.id).configName
    || definition.id
    || "Copilot CLI";
}

function normalizeIgnoredNapcatInstanceIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map(item => String(item || "").trim()).filter(Boolean))];
}

function personaConfigPath(roleId: string): string {
  return resolvePersonaConfigPath(rolesRoot, roleId);
}

function adapterConfigPath(configName: string): string {
  return resolveAdapterConfigPath(routeRoot, configName);
}

function configPathValue(value: unknown): string | undefined {
  return toPersistedProjectPath(value, rootDir);
}

export function adapterConfigItem(definition: GatewayDefinition): Record<string, unknown> {
  const usesNapcat = sharedDefinitionUsesNapcat(definition);
  return {
    configName: sanitizeConfigName(definition.configName) || routeRuntimeParts(definition.id).configName,
    name: definition.name,
    routeName: definition.routeName,
    enabled: definition.enabled !== false,
    messageAdapters: definition.messageAdapters ?? [definition.messageAdapterType ?? "napcat"],
    messageAdaptersDisabled: definition.messageAdaptersDisabled,
    messageInputsDisabled: definition.messageInputsDisabled,
    messageAdapterPolicies: definition.messageAdapterPolicies,
    pipelinePreset: definition.pipelinePreset,
    pipeline: definition.pipeline,
    gatewayPort: definition.gatewayPort,
    webhookPort: definition.webhookPort,
    webhookPath: definition.webhookPath,
    fenneNoteWebhookPort: definition.fenneNoteWebhookPort,
    fenneNoteWebhookPath: definition.fenneNoteWebhookPath,
    xiaoaiWebhookPort: definition.xiaoaiWebhookPort,
    xiaoaiWebhookPath: definition.xiaoaiWebhookPath,
    rabiLinkWebhookPort: definition.rabiLinkWebhookPort,
    rabiLinkWebhookPath: definition.rabiLinkWebhookPath,
    rabiLinkWebhookHost: definition.rabiLinkWebhookHost,
    feishuAppId: definition.feishuAppId,
    feishuAppSecret: definition.feishuAppSecret,
    feishuVerificationToken: definition.feishuVerificationToken,
    feishuEncryptKey: definition.feishuEncryptKey,
    feishuEventSubscriptionEnabled: definition.feishuEventSubscriptionEnabled === true,
    feishuWebhookPort: definition.feishuWebhookPort,
    feishuWebhookPath: definition.feishuWebhookPath,
    napcatHttpUrl: definition.napcatHttpUrl,
    napcatWebuiUrl: definition.napcatWebuiUrl,
    napcatAccessToken: definition.napcatAccessToken,
    napcatWebuiToken: definition.napcatWebuiToken,
    napcatInstances: usesNapcat && Array.isArray(definition.napcatInstances)
      ? definition.napcatInstances.map((instance) => ({
          ...instance,
          workingDir: configPathValue(instance.workingDir)
        }))
      : undefined,
    ignoredNapcatInstanceIds: normalizeIgnoredNapcatInstanceIds(definition.ignoredNapcatInstanceIds),
    heartbeatIntervalSeconds: definition.heartbeatIntervalSeconds,
    heartbeatMessage: definition.heartbeatMessage,
    heartbeatSkipWhenAgentBusy: definition.heartbeatSkipWhenAgentBusy,
    personaAutomationScriptsEnabled: definition.personaAutomationScriptsEnabled,
    remoteAgentDefaultDeviceId: definition.remoteAgentDefaultDeviceId,
    remoteAgentDefaultCwd: configPathValue(definition.remoteAgentDefaultCwd),
    remoteAgentDefaultThreadName: definition.remoteAgentDefaultThreadName,
    agentModel: definition.agentModel,
    agentReasoningEffort: definition.agentReasoningEffort,
    codexThreadId: definition.codexThreadId,
    codexThreadName: definition.codexThreadName,
    codexCwd: configPathValue(definition.codexCwd),
    dshSessionId: definition.dshSessionId,
    dshSessionName: definition.dshSessionName,
    dshCwd: configPathValue(definition.dshCwd),
    dshBaseUrl: definition.dshBaseUrl,
    codexPlanAssistantEnabled: definition.codexPlanAssistantEnabled,
    codexPlanAssistantModel: definition.codexPlanAssistantModel,
    codexPlanAssistantSessions: definition.codexPlanAssistantSessions,
    codexMemoryConsolidationAgentEnabled: definition.codexMemoryConsolidationAgentEnabled,
    codexMemoryConsolidationAgentModel: definition.codexMemoryConsolidationAgentModel,
    codexHooks: definition.codexHooks,
    messageProcessingAgents: definition.messageProcessingAgents,
    copilotThreadName: definition.copilotThreadName,
    copilotCwd: configPathValue(definition.copilotCwd),
    copilotCliBin: definition.copilotCliBin,
    marvisAppId: definition.marvisAppId,
    astrbotUrl: definition.astrbotUrl,
    astrbotUsername: definition.astrbotUsername,
    astrbotPassword: definition.astrbotPassword,
    astrbotProjectId: definition.astrbotProjectId,
    astrbotSessionId: definition.astrbotSessionId,
    rolesDir: configPathValue(definition.rolesDir),
    agentRoleId: definition.agentRoleId,
    agentRoleFile: definition.agentRoleFile,
    agentAdapters: definition.agentAdapters,
    primaryAgentAdapter: definition.primaryAgentAdapter,
    speechPushMode: definition.speechPushMode,
    routeVariables: definition.routeVariables
  };
}

function hasGlobalRabiLinkRelayConfig(config = rabiGlobalConfig.read().rabiLinkRelay): boolean {
  return Boolean(config.url || config.token);
}

function rabiLinkRelayConfigFor(definition: GatewayDefinition): RabiLinkRelayGlobalConfig {
  const globalConfig = rabiGlobalConfig.read();
  const globalRelay = globalConfig.rabiLinkRelay;
  if (hasGlobalRabiLinkRelayConfig(globalRelay)) {
    return globalRelay;
  }
  const url = definition.rabiLinkRelayUrl?.trim() || "";
  const token = definition.rabiLinkRelayToken?.trim() || "";
  return {
    enabled: Boolean(url && token),
    url,
    token,
    deviceId: definition.rabiLinkRelayDeviceId?.trim() || globalRelay.deviceId || globalConfig.rabiName || definition.id,
    claimWaitMs: definition.rabiLinkRelayClaimWaitMs ?? globalRelay.claimWaitMs,
    replyIdleTimeoutMs: definition.rabiLinkRelayReplyIdleTimeoutMs ?? globalRelay.replyIdleTimeoutMs,
    speechProxyEnabled: globalRelay.speechProxyEnabled,
    speechServiceUrl: globalRelay.speechServiceUrl
  };
}

function firstRouteLevelRabiLinkRelayConfig(): RabiLinkRelayGlobalConfig | null {
  const globalConfig = rabiGlobalConfig.read();
  for (const runtime of runtimes.values()) {
    const definition = runtime.definition;
    if (!definition.rabiLinkRelayUrl?.trim() && !definition.rabiLinkRelayToken?.trim()) continue;
    const url = definition.rabiLinkRelayUrl?.trim() || "";
    const token = definition.rabiLinkRelayToken?.trim() || "";
    return {
      enabled: Boolean(url && token),
      url,
      token,
      deviceId: definition.rabiLinkRelayDeviceId?.trim() || globalConfig.rabiLinkRelay.deviceId || globalConfig.rabiName || definition.id,
      claimWaitMs: definition.rabiLinkRelayClaimWaitMs ?? globalConfig.rabiLinkRelay.claimWaitMs,
      replyIdleTimeoutMs: definition.rabiLinkRelayReplyIdleTimeoutMs ?? globalConfig.rabiLinkRelay.replyIdleTimeoutMs,
      speechProxyEnabled: globalConfig.rabiLinkRelay.speechProxyEnabled,
      speechServiceUrl: globalConfig.rabiLinkRelay.speechServiceUrl
    };
  }
  return null;
}

function rabiLinkRelayConfigForMeta(): RabiLinkRelayGlobalConfig {
  const globalRelay = rabiGlobalConfig.read().rabiLinkRelay;
  if (hasGlobalRabiLinkRelayConfig(globalRelay)) return globalRelay;
  return firstRouteLevelRabiLinkRelayConfig() || globalRelay;
}

async function syncRabiLinkRelayRuntime(onLanReady?: () => void | Promise<void>): Promise<void> {
  if (!managerShouldAutostart) {
    await Promise.all([
      personaSyncLanServer.stop(),
      rabiLinkRelayRuntime.stop()
    ]);
    return;
  }
  const globalConfig = rabiGlobalConfig.read();
  const relay = rabiLinkRelayConfigForMeta();
  const lanEnabled = relay.enabled && Boolean(relay.url.trim()) && Boolean(relay.token.trim());
  if (!lanEnabled) await personaSyncLanServer.stop();
  await rabiLinkRelayRuntime.sync({
    ...relay,
    deviceGuid: globalConfig.rabiGuid,
    deviceName: globalConfig.rabiName || os.hostname(),
    localWebguiUrl: `http://127.0.0.1:${managerPort}`,
    peerUrls: lanEnabled ? personaSyncLanServer.peerUrls() : [],
    speechProxyEnabled: relay.speechProxyEnabled,
    localSpeechUrl: relay.speechServiceUrl
  });
  if (lanEnabled && personaSyncLanServer.status().state !== "listening") {
    try {
      await personaSyncLanServer.start();
    } catch (error) {
      console.warn(`Persona sync LAN listener unavailable; Relay fallback remains active: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    await onLanReady?.();
  }
}

async function writeAdapterConfigFile(definition: GatewayDefinition): Promise<void> {
  validateNapcatRouteCardinality(definition);
  validateNapcatBindings(routeNapcatBindings([...readConfig().gateways.filter(item => item.id !== definition.id), definition]));
  const desired = structuredClone(definition);
  const committed = readConfig().gateways.find(item => item.id === desired.id);
  const live = runtimes.get(desired.id);
  if (committed && live?.definition === definition) {
    live.definition = structuredClone(committed);
  }
  try {
    await requireRouteCatalogLifecycle().upsert(desired);
    pendingManagedConfigWatchEchoes += 1;
  } catch (error) {
    throw routeCatalogMutationFailure(error);
  }
}

async function backfillNapcatInstanceWebuiUrl(
  definition: GatewayDefinition,
  instanceId: string,
  webuiUrl: unknown
): Promise<string | null> {
  const value = String(webuiUrl || "").trim();
  if (!value) return null;
  const instances = sharedNormalizeNapCatInstances(definition);
  const target = instances.find((item) => item.id === instanceId);
  if (!target || target.webuiUrl === value) return null;
  target.webuiUrl = value;
  definition.napcatInstances = instances;
  const primary = instances.find((item) => item.enabled !== false) ?? instances[0];
  if (primary) {
    definition.napcatWebuiUrl = primary.webuiUrl;
    definition.napcatWebuiToken = primary.webuiToken ?? "";
  }
  await writeAdapterConfigFile(definition);
  return value;
}

function correctedNapcatWebuiUrlFromHealth(health: Record<string, unknown>): string {
  const webui = (health.webui ?? {}) as Record<string, unknown>;
  return String(webui.correctedUrl || webui.correctedWebuiUrl || "").trim();
}

function addHealthDiagnostic(health: Record<string, unknown>, message: string): Record<string, unknown> {
  const diagnostics = Array.isArray(health.diagnostics) ? health.diagnostics : [];
  return {
    ...health,
    diagnostics: [
      ...diagnostics,
      message
    ]
  };
}

function napcatInstanceIgnoreKeys(instance: Partial<NapCatInstanceDefinition> & { botUserId?: unknown }): string[] {
  const keys = new Set<string>();
  const add = (prefix: string, value: unknown): void => {
    const text = String(value ?? "").trim();
    if (text) keys.add(`${prefix}:${text}`);
  };
  add("id", instance.id);
  add("ws", instance.gatewayPort);
  add("http", instance.httpUrl);
  add("webui", instance.webuiUrl);
  add("qq", instance.botUserId);
  return [...keys];
}

function ignoreNapcatInstance(definition: GatewayDefinition, instance: Partial<NapCatInstanceDefinition> & { botUserId?: unknown }): void {
  const next = new Set(normalizeIgnoredNapcatInstanceIds(definition.ignoredNapcatInstanceIds));
  for (const key of napcatInstanceIgnoreKeys(instance)) next.add(key);
  definition.ignoredNapcatInstanceIds = [...next];
}

async function addManagedNapcatInstance(
  request: NapcatAddRequest,
  context: ReturnType<typeof napcatManagerCtx>
): Promise<Record<string, unknown>> {
  const gatewayId = request.gatewayId?.trim();
  if (!gatewayId) throw new Error("缺少 gatewayId。");
  const runtime = runtimes.get(gatewayId);
  if (!runtime) throw new Error(`未找到路由：${gatewayId}`);
  const definition = runtime.definition;
  if (definition.enabled === false || !sharedDefinitionUsesNapcat(definition)) throw new Error("NapCat 未绑定到启用的 Rabi 消息端，不能启动或登录。");
  const instances = sharedNormalizeNapCatInstances(definition);
  if (instances.length > 0) {
    throw new Error("每个 Route 只能绑定一个 NapCat；如需另一个 QQ，请新建 Route。");
  }
  const index = instances.length + 1;
  const id = `napcat-${randomUUID()}`;
  const used = new Set<number>();
  for (const runtimeItem of runtimes.values()) {
    for (const item of sharedNormalizeNapCatInstances(runtimeItem.definition)) {
      used.add(Number(item.gatewayPort || 0));
      try { used.add(Number(new URL(item.httpUrl).port || 0)); } catch { /* ignore */ }
      try { used.add(Number(new URL(item.webuiUrl || "").port || 0)); } catch { /* ignore */ }
    }
  }

  const steps = ["正在准备 NapCat 实例...", "正在查找合适端口..."];
  const webuiPort = await nextFreeLocalPort(6099 + instances.length, used);
  const httpPort = await nextFreeLocalPort(3000 + instances.length, used);
  const wsPort = await nextFreeLocalPort(Number(definition.gatewayPort || 8789) + instances.length, used);
  steps.push(`已分配端口：WebUI ${webuiPort} / HTTP ${httpPort} / WS ${wsPort}`);

  const prepared = prepareManagedNapcatInstance(context, {
    id,
    name: `QQ ${index}`,
    gatewayPort: wsPort,
    httpPort,
    webuiPort,
    index
  });
  const instance = prepared.instance;
  steps.push(...prepared.steps);

  definition.napcatInstances = [instance];
  const primary = definition.napcatInstances.find((item) => item.enabled !== false) ?? instance;
  definition.gatewayPort = primary.gatewayPort;
  definition.napcatHttpUrl = primary.httpUrl;
  definition.napcatWebuiUrl = primary.webuiUrl;
  definition.napcatAccessToken = primary.accessToken ?? "";
  definition.napcatWebuiToken = primary.webuiToken ?? "";
  await writeAdapterConfigFile(definition);

  steps.push("正在执行启动命令...");
  const launchResult = await launchNapcatInstanceEndpoint(context, { gatewayId, instanceId: id });
  steps.push(String(launchResult.message || "已尝试启动 NapCat 后台。"));
  return {
    ok: launchResult.ok !== false,
    message: launchResult.ok !== false
      ? "已创建并启动 NapCat；请在当前 Route 的 NapCat 卡片中完成 QQ 登录。"
      : "已创建 NapCat，但后台未在超时时间内可达；请检查启动命令后从当前 Route 卡片重试。",
    steps,
    launch: launchResult,
    instance,
    webuiUrl: instance.webuiUrl
  };
}

async function removeManagedNapcatInstance(request: NapcatRemoveRequest): Promise<Record<string, unknown>> {
  const gatewayId = request.gatewayId?.trim();
  const instanceId = request.instanceId?.trim();
  if (!gatewayId || !instanceId) throw new Error("缺少 gatewayId 或 instanceId。");
  const runtime = runtimes.get(gatewayId);
  if (!runtime) throw new Error(`未找到路由：${gatewayId}`);
  const instances = sharedNormalizeNapCatInstances(runtime.definition);
  const existing = instances.find((item) => item.id === instanceId);
  if (!existing) throw new Error("NapCat 未绑定到启用的 Rabi 消息端，不能启动或登录。");
  const stop = await stopNapcatInstanceEndpoint(napcatManagerCtx(), {
    gatewayId,
    instanceId,
    name: request.name,
    gatewayPort: request.gatewayPort,
    httpUrl: request.httpUrl,
    webuiUrl: request.webuiUrl,
    accessToken: request.accessToken,
    webuiToken: request.webuiToken,
    launchCommand: request.launchCommand,
    workingDir: request.workingDir
  });
  if (stop.ok !== true) {
    return {
      ok: false,
      message: "NapCat 后台仍在运行，已保留实例配置和插件进程所有权。",
      stop
    };
  }

  ignoreNapcatInstance(runtime.definition, {
    ...(existing || {}),
    id: instanceId,
    gatewayPort: request.gatewayPort ?? existing?.gatewayPort,
    httpUrl: request.httpUrl ?? existing?.httpUrl,
    webuiUrl: request.webuiUrl ?? existing?.webuiUrl,
    botUserId: existing?.botUserId
  });
  runtime.definition.napcatInstances = instances.filter((item) => item.id !== instanceId);
  const primary = runtime.definition.napcatInstances.find((item) => item.enabled !== false);
  if (primary) {
    runtime.definition.gatewayPort = primary.gatewayPort;
    runtime.definition.napcatHttpUrl = primary.httpUrl;
    runtime.definition.napcatWebuiUrl = primary.webuiUrl;
    runtime.definition.napcatAccessToken = primary.accessToken ?? "";
    runtime.definition.napcatWebuiToken = primary.webuiToken ?? "";
  } else {
    runtime.definition.messageAdaptersDisabled = [...new Set([...(runtime.definition.messageAdaptersDisabled ?? []), "napcat" as MessageAdapterType])];
    runtime.definition.messageAdapterPolicies = {
      ...(runtime.definition.messageAdapterPolicies ?? {}),
      napcat: {
        ...(runtime.definition.messageAdapterPolicies?.napcat ?? {}),
        inputEnabled: false
      }
    };
    runtime.definition.napcatAccessToken = "";
    runtime.definition.napcatWebuiToken = "";
  }
  await writeAdapterConfigFile(runtime.definition);
  return {
    ok: true,
    message: "已停止并移除 NapCat 实例。",
    stop
  };
}

async function ensurePersonaConfigFile(roleId: string): Promise<string> {
  const configPath = personaConfigPath(roleId);
  try {
    await requireRouteCatalogLifecycle().ensurePersona(roleId);
  } catch (error) {
    throw routeCatalogMutationFailure(error);
  }
  return configPath;
}

async function ensureRoleFile(roleId: string, roleFile: string): Promise<string> {
  const target = roleFilePath(rolesRoot, roleId, roleFile);
  try {
    await requireRouteCatalogLifecycle().ensureRoleFile(roleId, roleFile);
  } catch (error) {
    throw routeCatalogMutationFailure(error);
  }
  return target;
}

async function ensureRoleFolder(roleId: string): Promise<string> {
  const target = roleFolderPath(rolesRoot, roleId);
  try {
    await requireRouteCatalogLifecycle().ensureRoleFolder(roleId);
  } catch (error) {
    throw routeCatalogMutationFailure(error);
  }
  return target;
}

async function reconcilePersistedPlanSecretaryWorkspaces(): Promise<void> {
  const ownerByRoleDir = new Map<string, { roleDir: string; roleId: string; workspace: string; conflicting: boolean }>();
  for (const runtime of runtimes.values()) {
    const workspace = runtime.definition.codexCwd?.trim();
    if (!workspace) continue;
    const roleDir = roleDirForDefinition(runtime.definition);
    const roleId = roleIdForDefinition(runtime.definition);
    const key = path.resolve(roleDir).toLowerCase();
    const existing = ownerByRoleDir.get(key);
    if (!existing) {
      ownerByRoleDir.set(key, { roleDir, roleId, workspace, conflicting: false });
      continue;
    }
    if (!sameCodexWorkspace(existing.workspace, workspace)) existing.conflicting = true;
  }

  for (const [roleDirKey, owner] of ownerByRoleDir) {
    if (owner.conflicting) {
      console.warn(`Plan secretary workspace reconciliation skipped because ${roleDirKey} has multiple Primary Persona workspaces.`);
      continue;
    }
    try {
      const plans = (await currentRoleStorageApplication().queries.recaptureCatalog(
        owner.roleId,
        { timeoutMs: 30_000 }
      )).plans;
      const stalePlanIds: string[] = [];
      reconcilePlanSecretaryBindingsForWorkspace(
        plans,
        owner.workspace,
        (planId) => { stalePlanIds.push(planId); }
      );
      for (const planId of stalePlanIds) {
        const projection = await currentRoleStorageApplication().queries.plan(owner.roleId, planId, { timeoutMs: 30_000 });
        if (!projection) continue;
        await currentRoleStorageApplication().commands.updatePlanSecretaryBinding(owner.roleId, planId, null, {
          idempotencyKey: roleStorageOperationKey(
            "workspace-reconcile",
            owner.workspace,
            planId,
            projection.revision
          ),
          expectedRevision: projection.revision,
          timeoutMs: 30_000
        });
      }
    } catch (error) {
      console.warn(`Plan secretary workspace reconciliation failed for ${owner.roleDir}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

const gatewayRuntimePluginLease = new GenerationHandoffLease();

const gatewayRuntimeService = new ManagerGatewayRuntimeService<GatewayDefinition, GatewayRuntime>(runtimes, {
  loadDefinitions: () => readConfig().gateways,
  normalizeDefinition,
  definitionFingerprint,
  createRuntime: definition => ({
    definition,
    process: null,
    needsRestart: false,
    startedAt: null,
    stoppedAt: null,
    lastExit: null,
    readiness: "stopped",
    endpoints: [],
    lastError: null,
    log: []
  }),
  isRunning: runtime => Boolean(runtime.process),
  reconcileAction: runtime => gatewayRuntimeSyncAction({
    managerShouldAutostart,
    enabled: runtime.definition.enabled === true,
    runtimeRequired: sharedGatewayMessageAdapterTypes(runtime.definition).length > 0,
    running: Boolean(runtime.process),
    needsRestart: runtime.needsRestart
  }),
  startRuntime: runtime => startGatewayRuntime(runtime.definition.id),
  stopRuntime: runtime => stopGatewayRuntime(runtime.definition.id),
  restartRuntime: runtime => {
    if (!runtime.process) {
      startGatewayRuntime(runtime.definition.id);
      return;
    }
    runtime.needsRestart = true;
    appendLog(runtime, "restarting because gateway config changed");
    runtime.process.kill();
  }
});

async function loadRuntimes(): Promise<void> {
  try {
    await requireRouteCatalogLifecycle().recapture();
  } catch (error) {
    throw routeCatalogMutationFailure(error);
  }
}

function routeNapcatBindings(definitions: GatewayDefinition[]): NapcatBinding[] {
  return definitions
    .filter(definition => definition.enabled !== false && sharedDefinitionUsesNapcat(definition))
    .flatMap(definition => sharedNormalizeNapCatInstances(definition).filter(instance => instance.enabled !== false).map(instance => ({
      gatewayId: definition.id, instanceId: instance.id, botUserId: String(instance.botUserId || "").trim() || undefined,
      workingDir: instance.workingDir ? path.resolve(rootDir, instance.workingDir) : undefined,
      httpUrl: instance.httpUrl, webuiUrl: instance.webuiUrl
    })));
}

async function applyRouteCatalogSnapshot(snapshot: RouteCatalogSnapshot): Promise<void> {
  if (
    normalizePathForComparison(snapshot.routeRoot) !== normalizePathForComparison(routeRoot)
    || normalizePathForComparison(snapshot.rolesRoot) !== normalizePathForComparison(rolesRoot)
  ) {
    throw new Error("Route catalog snapshot roots no longer match the active Manager configuration.");
  }
  const normalized = snapshot.gateways.map(definition => normalizeDefinition(
    structuredClone(definition) as GatewayDefinition
  ));
  const ids = new Set<string>();
  for (const definition of normalized) {
    if (ids.has(definition.id)) throw new Error(`Duplicate route catalog id: ${definition.id}`);
    ids.add(definition.id);
  }
  sharedValidateGatewayPortConflicts(normalized);
  if (!managerReadOnly) await napcatProcessOwner.reconcile(routeNapcatBindings(normalized));
  gatewayRuntimeService.loadDefinitions(normalized);
  routeCatalogConfig = { gateways: structuredClone(normalized) };
  routeCatalogPersonaPresentations = Object.freeze(snapshot.personas.map(item => Object.freeze({
    ...structuredClone(item),
    files: Object.freeze(item.files.map(file => Object.freeze({ ...file }))),
    speech: Object.freeze({ ...item.speech })
  })));
  reconcileMessageProcessingAgentRequests();
}

function syncRunningGateways(): void {
  if (!gatewayRuntimePluginLease.active) return;
  if (routeCatalogStartupStatus().state !== "ready") return;
  gatewayRuntimeService.reconcile();
}

async function reloadChangedConfig(
  reason: string,
  reconcileManagerPlugins?: (reason: string) => Promise<void>,
  afterReload?: () => void | Promise<void>
): Promise<void> {
  try {
    configRepository.refreshManagerConfig();
    routeRoot = configRepository.routeRoot;
    rolesRoot = configRepository.rolesRoot;
    const routeCatalogLifecycle = activeStorageLifecycleGeneration?.routeCatalog;
    if (!routeCatalogLifecycle) throw new Error("Route catalog lifecycle is unavailable.");
    await routeCatalogLifecycle.recapture();
    await reconcilePersistedPlanSecretaryWorkspaces();
  } catch (error) {
    console.error(`Failed to reload gateway config ${reason}`, error);
  }
  if (reconcileManagerPlugins) {
    try {
      await reconcileManagerPlugins(reason);
    } catch (error) {
      console.error(`Failed to reconcile Manager plugins ${reason}`, error);
    }
  }
  try {
    syncRunningGateways();
    await afterReload?.();
    memoryConsolidationScheduler?.reschedule();
    console.log(`gateway-manager reloaded ${reason}`);
  } catch (error) {
    console.error(`Failed to apply reloaded Manager config ${reason}`, error);
  }

}

type ConfigWatcher = Pick<ManagerWatchBroker, "close">;
type PluginPackageWatcher = Pick<ManagerWatchBroker, "close">;

function recordWatchDiagnostic(source: "config" | "plugin_tree", diagnostic: ManagerWatchDiagnostic): void {
  const { status } = diagnostic;
  managerOperationalLog.record(diagnostic.event === "manager_watch_degraded" ? "warn" : "info", diagnostic.event, {
    source,
    owner: "ManagerWatchBroker",
    operationId: `${managerInstanceId}:${source}:${status.attempts}`,
    childPid: status.activeWorkerPid,
    durationMs: diagnostic.durationMs,
    result: `previous=${diagnostic.previousState}; state=${status.state}; attempt=${status.attempts}; timeoutMs=${diagnostic.timeoutMs}; timeouts=${status.timeouts}; restarts=${status.restarts}; errors=${status.errors.length}; lastSuccessAt=${status.lastSuccessAt ?? "never"}`,
    action: managerOperationalError(new Error(diagnostic.reason), rootDir)?.message,
    error: diagnostic.error ? managerOperationalError(diagnostic.error, rootDir) : undefined
  });
}

function startPluginPackageWatcher(
  directories: readonly string[],
  reconcile: (reason: string) => Promise<void>
): PluginPackageWatcher {
  let initialized = false;
  let snapshot = "";
  const broker = new ManagerWatchBroker({
    request: { kind: "plugin_tree", roots: directories },
    debounceMs: 160,
    onStatus: status => { pluginPackageWatchLifecycle = status; },
    onDiagnostic: diagnostic => recordWatchDiagnostic("plugin_tree", diagnostic),
    onSnapshot: async result => {
      if (result.partial) {
        console.warn(`Plugin watch snapshot is partial (${result.errors.length} unavailable path(s)); Manager remains online.`);
      }
      if (!initialized) {
        initialized = true;
        snapshot = result.snapshot;
        return;
      }
      if (result.snapshot === snapshot) return;
      snapshot = result.snapshot;
      try {
        await reconcile("plugin profile or bundle changed");
      } catch (error) {
        console.warn("Plugin bundle reload failed; the active revision remains in service.", error);
        throw error;
      }
    }
  });
  broker.start();
  return broker;
}

function startConfigWatcher(
  reconcileManagerPlugins?: (reason: string) => Promise<void>,
  afterReload?: () => void | Promise<void>
): ConfigWatcher {
  let initialized = false;
  const broker = new ManagerWatchBroker({
    request: () => ({
      kind: "config",
      routeRoot,
      rolesRoot,
      operationTimeoutMs: 1_500,
      explicitFiles: [configRepository.managerConfigPath]
    }),
    onStatus: status => { configWatchLifecycle = status; },
    onDiagnostic: diagnostic => recordWatchDiagnostic("config", diagnostic),
    onSnapshot: async (result, reason) => {
      if (result.partial) {
        console.warn(`Config watch snapshot is partial (${result.errors.length} unavailable path(s)); Manager remains online.`);
      }
      if (initialized && result.snapshot !== watchedConfigSnapshot) {
        watchedConfigSnapshot = result.snapshot;
        if (pendingManagedConfigWatchEchoes > 0) {
          pendingManagedConfigWatchEchoes -= 1;
          broker.requestRefresh("after managed route catalog write");
          return;
        }
        await reloadChangedConfig(reason, reconcileManagerPlugins, afterReload);
        broker.requestRefresh("after config root refresh");
      } else {
        watchedConfigSnapshot = result.snapshot;
        initialized = true;
      }
    }
  });
  broker.start();
  return broker;
}

function appendLog(runtime: GatewayRuntime, line: string): void {
  runtimes.appendLog(runtime, line);
  console.log(`[${runtime.definition.id}] ${line}`);
}

function childCommand(extraArgs: string[] = []) {
  return resolveGatewayChildCommand(packageRoot, extraArgs);
}

function reconcileSpeechMicrophone(reason: string, isActive: () => boolean = () => true): void {
  void speechRuntimeControl.start()
    .then(() => isActive() ? speechControl.reconcileMicrophone() : undefined)
    .catch(error => {
      if (!isActive()) return;
      console.warn(
        `Speech runtime/microphone reconciliation failed after ${reason}:`,
        error instanceof Error ? error.message : String(error)
      );
    });
}

function resolveWingetCopilot(): string | null {
  if (!process.env.LOCALAPPDATA) return null;
  const wingetBase = path.join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Packages");
  try {
    for (const entry of fs.readdirSync(wingetBase)) {
      if (entry.startsWith("GitHub.Copilot")) {
        const exe = path.join(wingetBase, entry, "copilot.exe");
        if (fs.existsSync(exe)) return exe;
      }
    }
  } catch { /* skip */ }
  return null;
}

function envFor(
  definition: GatewayDefinition,
  adapterEnvironment: MessageAdapterEnvironment = routeMessageAdapterEnvironment(sharedGatewayAdapterTypes(definition))
): NodeJS.ProcessEnv {
  const parts = routeRuntimeParts(definition.id);
  const configName = sanitizeConfigName(definition.configName) || parts.configName;
  const routeDataDir = path.relative(rootDir, routeFolderPath(routeRoot, configName)).replace(/\\/g, "/");
  const routeRolesDir = path.relative(rootDir, rolesRoot).replace(/\\/g, "/");
  const rabiLinkRelay = rabiLinkRelayConfigFor(definition);
  const globalConfig = rabiGlobalConfig.read();
  const {
    RABIROUTE_HOST_CONTROL_TOKEN: _hostControlToken,
    ...gatewayBaseEnvironment
  } = process.env;
  return {
    ...gatewayBaseEnvironment,
    GATEWAY_ID: definition.id,
    RABI_GUID: globalConfig.rabiGuid,
    GATEWAY_MANAGER_PORT: String(managerPort),
    GATEWAY_MANAGER_URL: `http://127.0.0.1:${managerPort}`,
    RABIROUTE_APPLICATION_GENERATION_ID: managerHostIdentity?.applicationGenerationId ?? managerInstanceId,
    RABIROUTE_MANAGER_INSTANCE_ID: managerInstanceId,
    PERSONA_MESSAGING_CAPABILITY: currentPersonaMessageAuthority().issue(definition.id, roleIdForDefinition(definition)),
    ...adapterEnvironment,
    MESSAGE_ADAPTER_POLICIES: JSON.stringify(definition.messageAdapterPolicies ?? {}),
    AGENT_MODEL: definition.agentModel?.trim() || "",
    AGENT_REASONING_EFFORT: definition.agentReasoningEffort ?? "",
    DSH_MODEL_PROVIDER: definition.dshModelProvider?.trim() || "",
    DSH_MODEL: definition.dshModel?.trim() || "",
    DSH_REASONING_EFFORT: definition.dshReasoningEffort?.trim() || "",
    RABI_DSH_ROUTE_CONFIG_PATH: adapterConfigPath(configName),
    MESSAGE_PROCESSING_AGENTS: JSON.stringify(definition.messageProcessingAgents ?? {}),
    PIPELINE_PRESET: definition.pipelinePreset ?? "",
    PIPELINE: definition.pipeline ? JSON.stringify(definition.pipeline) : "",
    HEARTBEAT_INTERVAL_SECONDS: String(definition.heartbeatIntervalSeconds ?? 900),
    HEARTBEAT_MESSAGE: definition.heartbeatMessage ?? "定时心跳巡检：请按当前计划、记忆和可用状态执行必要检查。",
    HEARTBEAT_SKIP_WHEN_AGENT_BUSY: definition.heartbeatSkipWhenAgentBusy ? "1" : "0",
    PERSONA_AUTOMATION_SCRIPTS_ENABLED: definition.personaAutomationScriptsEnabled ? "1" : "0",
    REMOTE_AGENT_DEFAULT_DEVICE_ID: definition.remoteAgentDefaultDeviceId?.trim() || "",
    REMOTE_AGENT_DEFAULT_CWD: configPathValue(definition.remoteAgentDefaultCwd) || "",
    REMOTE_AGENT_DEFAULT_THREAD_NAME: definition.remoteAgentDefaultThreadName?.trim() || "",
    NAPCAT_HTTP_URL: definition.napcatHttpUrl ?? process.env.NAPCAT_HTTP_URL ?? "http://127.0.0.1:3000",
    NAPCAT_WEBUI_URL: definition.napcatWebuiUrl ?? process.env.NAPCAT_WEBUI_URL ?? "http://127.0.0.1:6099/webui",
    NAPCAT_ACCESS_TOKEN: definition.napcatAccessToken ?? process.env.NAPCAT_ACCESS_TOKEN ?? "",
    NAPCAT_WEBUI_TOKEN: definition.napcatWebuiToken ?? process.env.NAPCAT_WEBUI_TOKEN ?? "",
    NAPCAT_INSTANCES: JSON.stringify(definition.napcatInstances ?? sharedNormalizeNapCatInstances(definition)),
    GATEWAY_PORT: String(definition.gatewayPort),
    WEBHOOK_PORT: String(definition.webhookPort ?? definition.gatewayPort),
    WEBHOOK_PATH: definition.webhookPath ?? "/webhook",
    FENNENOTE_WEBHOOK_PORT: String(definition.fenneNoteWebhookPort ?? definition.webhookPort ?? definition.gatewayPort),
    FENNENOTE_WEBHOOK_PATH: definition.fenneNoteWebhookPath ?? "/fennenote",
    FENNOTE_WEBHOOK_PORT: String(definition.fenneNoteWebhookPort ?? definition.webhookPort ?? definition.gatewayPort),
    FENNOTE_WEBHOOK_PATH: definition.fenneNoteWebhookPath ?? "/fennenote",
    XIAOAI_WEBHOOK_PORT: String(definition.xiaoaiWebhookPort ?? definition.webhookPort ?? definition.gatewayPort),
    XIAOAI_WEBHOOK_PATH: definition.xiaoaiWebhookPath ?? "/xiaoai",
    RABILINK_WEBHOOK_PORT: String(definition.rabiLinkWebhookPort ?? definition.webhookPort ?? definition.gatewayPort),
    RABILINK_WEBHOOK_PATH: definition.rabiLinkWebhookPath ?? "/rabilink",
    RABILINK_WEBHOOK_HOST: definition.rabiLinkWebhookHost?.trim() || "0.0.0.0",
    RABILINK_RELAY_ENABLED: rabiLinkRelay.url && rabiLinkRelay.token ? "1" : "",
    RABILINK_RELAY_URL: rabiLinkRelay.url,
    RABILINK_RELAY_APP_TOKEN: rabiLinkRelay.token,
    RABILINK_RELAY_DEVICE_ID: rabiLinkRelay.deviceId || definition.id,
    RABILINK_RELAY_DEVICE_GUID: globalConfig.rabiGuid,
    RABILINK_RELAY_CLAIM_WAIT_MS: String(rabiLinkRelay.claimWaitMs),
    RABILINK_RELAY_REPLY_IDLE_TIMEOUT_MS: String(rabiLinkRelay.replyIdleTimeoutMs),
    WECOM_BOT_ID: definition.wecomBotId?.trim() || process.env.WECOM_BOT_ID || "",
    WECOM_BOT_SECRET: definition.wecomBotSecret?.trim() || process.env.WECOM_BOT_SECRET || "",
    WECOM_WS_URL: definition.wecomWsUrl?.trim() || process.env.WECOM_WS_URL || "",
    WEIXIN_BASE_URL: definition.weixinBaseUrl?.trim() || process.env.WEIXIN_BASE_URL || "https://ilinkai.weixin.qq.com",
    WEIXIN_BOT_TYPE: definition.weixinBotType?.trim() || process.env.WEIXIN_BOT_TYPE || "3",
    FEISHU_APP_ID: definition.feishuAppId?.trim() || process.env.FEISHU_APP_ID || "",
    FEISHU_APP_SECRET: definition.feishuAppSecret?.trim() || process.env.FEISHU_APP_SECRET || "",
    FEISHU_VERIFICATION_TOKEN: definition.feishuVerificationToken?.trim() || process.env.FEISHU_VERIFICATION_TOKEN || "",
    FEISHU_ENCRYPT_KEY: definition.feishuEncryptKey?.trim() || process.env.FEISHU_ENCRYPT_KEY || "",
    FEISHU_EVENT_SUBSCRIPTION_ENABLED: definition.feishuEventSubscriptionEnabled === true ? "true" : "false",
    FEISHU_WEBHOOK_PORT: String(definition.feishuWebhookPort ?? definition.gatewayPort),
    FEISHU_WEBHOOK_PATH: definition.feishuWebhookPath ?? "/feishu",
    CODEX_THREAD_ID: definition.primaryAgentAdapter === "dsh"
      ? (definition.dshSessionId?.trim() || definition.codexThreadId?.trim() || "")
      : (definition.codexThreadId?.trim() || ""),
    CODEX_THREAD_NAME: resolveCodexThreadName(definition),
    CODEX_CWD: normalizeCodexCwd(definition.codexCwd) ?? normalizeCodexCwd(process.env.CODEX_CWD) ?? rootDir,
    DSH_SESSION_ID: definition.dshSessionId?.trim() || "",
    DSH_SESSION_NAME: definition.dshSessionName?.trim() || "",
    DSH_BASE_URL: definition.dshBaseUrl?.trim() || "",
    DSH_CWD: normalizeCodexCwd(definition.dshCwd) || "",
    CODEX_PLAN_ASSISTANT_ENABLED: definition.codexPlanAssistantEnabled === true ? "true" : "false",
    CODEX_PLAN_ASSISTANT_MODEL: normalizeCodexPlanAssistantModel(definition.codexPlanAssistantModel),
    CODEX_PLAN_ASSISTANT_SESSIONS: JSON.stringify(definition.codexPlanAssistantSessions ?? []),
    CODEX_MEMORY_CONSOLIDATION_AGENT_ENABLED: definition.codexMemoryConsolidationAgentEnabled === true ? "true" : "false",
    CODEX_MEMORY_CONSOLIDATION_AGENT_MODEL: normalizeCodexMemoryConsolidationAgentModel(definition.codexMemoryConsolidationAgentModel),
    COPILOT_THREAD_NAME: resolveCopilotThreadName(definition),
    COPILOT_CLI_BIN: definition.copilotCliBin?.trim() || process.env.COPILOT_CLI_BIN || resolveWingetCopilot() || (process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "copilot.cmd") : "") || "copilot",
    COPILOT_CWD: resolvePersistedProjectPath(definition.copilotCwd, rootDir) ?? resolveProjectPath(process.env.COPILOT_CWD, rootDir) ?? rootDir,
    MARVIS_APP_ID: definition.marvisAppId?.trim() || process.env.MARVIS_APP_ID || "Tencent.Marvis",
    ASTRBOT_URL: definition.astrbotUrl?.trim() || process.env.ASTRBOT_URL || "http://127.0.0.1:6185",
    ASTRBOT_USERNAME: definition.astrbotUsername?.trim() || process.env.ASTRBOT_USERNAME || "",
    ASTRBOT_PASSWORD: definition.astrbotPassword?.trim() || process.env.ASTRBOT_PASSWORD || "",
    ASTRBOT_PROJECT_ID: definition.astrbotProjectId?.trim() || process.env.ASTRBOT_PROJECT_ID || "",
    ASTRBOT_SESSION_ID: definition.astrbotSessionId?.trim() || process.env.ASTRBOT_SESSION_ID || "",
    ROLES_DIR: routeRolesDir,
    AGENT_ROLE_ID: sanitizeRoleId(definition.agentRoleId),
    AGENT_ROLE_FILE: definition.agentRoleFile ?? "persona.md",
    AGENT_ADAPTERS: Array.isArray(definition.agentAdapters) ? definition.agentAdapters.join(",") : process.env.AGENT_ADAPTERS ?? "",
    PRIMARY_AGENT_ADAPTER: definition.primaryAgentAdapter ?? "",
    TARGET_GROUP_ID: definition.targetGroupId ?? "",
    BOT_NICKNAME: process.env.BOT_NICKNAME ?? "QQ小助手",
    ROUTE_VARIABLES: definition.routeVariables ? JSON.stringify(definition.routeVariables) : "",
    ROUTE_PROFILES: Array.isArray(definition.routeProfiles) ? JSON.stringify(definition.routeProfiles) : "",
    DATA_DIR: routeDataDir,
    GROUP_NOTIFICATION_TEMPLATE: definition.groupNotificationTemplate ?? "",
    GROUP_AT_NOTIFICATION_TEMPLATE: definition.groupAtNotificationTemplate ?? "",
    GROUP_DIRECT_REPLY_NOTIFICATION_TEMPLATE: definition.groupDirectReplyNotificationTemplate ?? definition.groupReplyNotificationTemplate ?? "",
    GROUP_INDIRECT_REPLY_NOTIFICATION_TEMPLATE: definition.groupIndirectReplyNotificationTemplate ?? definition.groupNicknameNotificationTemplate ?? "",
    PRIVATE_NOTIFICATION_TEMPLATE: definition.privateNotificationTemplate ?? "",
    VOICE_TRANSCRIPT_NOTIFICATION_TEMPLATE: definition.voiceTranscriptNotificationTemplate ?? "",
    RECENT_MESSAGE_LIMITS: definition.recentMessageLimits ? JSON.stringify(definition.recentMessageLimits) : "",
    SPEECH_PUSH_MODE: definition.speechPushMode ?? "hot",
    SPEECH_TRIGGER_KEYWORDS: Array.isArray(definition.speechTriggerKeywords) ? JSON.stringify(definition.speechTriggerKeywords) : "[]",
    AUTOMATION_RULES: Array.isArray(definition.automationRules) ? JSON.stringify(definition.automationRules) : "[]",
    NOTIFICATION_RULES: Array.isArray(definition.notificationRules) ? JSON.stringify(definition.notificationRules) : "",
  };
}

function startGatewayRuntime(id: string): void {
  const runtime = runtimes.get(id);
  if (!runtime) {
    throw new Error(`Gateway not found: ${id}`);
  }
  if (routeCatalogStartupStatus().state !== "ready") {
    runtime.readiness = "blocked";
    runtime.lastError = "Route catalog startup is not ready.";
    appendLog(runtime, "skip start until route catalog startup is ready");
    return;
  }
  const runtimeAdapters = sharedGatewayMessageAdapterTypes(runtime.definition);
  const startDecision = gatewayRuntimeStartDecision({
    enabled: runtime.definition.enabled === true,
    runtimeRequired: runtimeAdapters.length > 0,
    running: Boolean(runtime.process && !runtime.process.killed)
  });
  if (startDecision === "skip-disabled") {
    appendLog(runtime, "skip start because gateway is disabled");
    return;
  }
  if (startDecision === "skip-not-required") {
    appendLog(runtime, "skip start because Route has no Gateway-owned message adapters");
    return;
  }
  if (startDecision === "already-running") {
    return;
  }

  const command = childCommand();
  const agentStateGeneration = randomUUID();
  const childEnv = envFor(runtime.definition, gatewayMessageAdapterEnvironment(runtimeAdapters));
  childEnv.AGENT_STATE_GENERATION = agentStateGeneration;
  childEnv.RABIROUTE_GATEWAY_GENERATION_ID = agentStateGeneration;
  runtime.agentStateGeneration = agentStateGeneration;
  agentStateByGateway.delete(runtime.definition.id);
  const child = spawn(command.command, command.args, {
    cwd: rootDir,
    env: childEnv,
    shell: command.shell,
    windowsHide: true
  });

  runtime.log = [];
  runtime.process = child;
  runtime.readiness = "starting";
  runtime.endpoints = [];
  runtime.lastError = null;
  runtime.needsRestart = false;
  runtime.startedAt = new Date().toISOString();
  runtime.stoppedAt = null;
  appendLog(runtime, `starting pid=${child.pid ?? "unknown"}; awaiting exact Gateway READY`);
  managerOperationalLog.record("info", "gateway_started", {
    routeId: runtime.definition.id,
    childPid: child.pid,
    result: "started"
  });

  let stdoutBuffer = "";
  child.stdout.on("data", (data) => {
    stdoutBuffer += data.toString();
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines.filter(Boolean)) {
      const ready = child.pid ? parseGatewayReadyLine(line, {
        gatewayId: runtime.definition.id,
        gatewayGenerationId: agentStateGeneration,
        pid: child.pid
      }) : null;
      if (ready && runtime.process === child) {
        runtime.readiness = "ready";
        runtime.endpoints = ready.endpoints;
        runtime.lastError = null;
        appendLog(runtime, `READY generation=${agentStateGeneration} endpoints=${ready.endpoints.length}`);
        continue;
      }
      appendLog(runtime, line);
    }
  });

  child.stderr.on("data", (data) => {
    for (const line of data.toString().split(/\r?\n/).filter(Boolean)) {
      appendLog(runtime, `ERR ${line}`);
      runtime.lastError = line.slice(-2_000);
      if (/EADDRINUSE|address already in use/i.test(line) && runtime.readiness !== "ready") {
        runtime.readiness = "blocked";
      }
    }
  });

  child.on("exit", (code, signal) => {
    if (runtime.process !== child) return;
    runtime.process = null;
    runtime.agentStateGeneration = undefined;
    agentStateByGateway.delete(runtime.definition.id);
    runtime.stoppedAt = new Date().toISOString();
    if (runtime.readiness === "stopping" || (code === 0 && runtime.readiness === "ready")) {
      runtime.readiness = "stopped";
    } else if (runtime.readiness !== "blocked") {
      runtime.readiness = "failed";
    }
    runtime.endpoints = [];
    runtime.lastExit = {
      code,
      signal,
      at: runtime.stoppedAt
    };
    appendLog(runtime, `exited code=${code ?? ""} signal=${signal ?? ""}`);
    managerOperationalLog.record(code === 0 ? "info" : "warn", "gateway_exited", {
      routeId: runtime.definition.id,
      childPid: child.pid,
      result: `code=${code ?? "null"}; signal=${signal ?? "null"}`
    });
    if (runtime.needsRestart && runtime.definition.enabled) {
      startGatewayRuntime(runtime.definition.id);
    }
  });
}

function stopGatewayRuntime(id: string): void {
  const runtime = runtimes.get(id);
  if (!runtime) {
    throw new Error(`Gateway not found: ${id}`);
  }
  if (!runtime.process) {
    return;
  }

  appendLog(runtime, "stopping");
  runtime.readiness = "stopping";
  managerOperationalLog.record("info", "gateway_stop_requested", {
    routeId: runtime.definition.id,
    childPid: runtime.process.pid,
    result: "requested"
  });
  runtime.agentStateGeneration = undefined;
  agentStateByGateway.delete(runtime.definition.id);
  const child = runtime.process;
  void stopChildProcessTree(child).catch(() => { child.kill(); });
}

function startGateway(id: string): void {
  if (!gatewayRuntimePluginLease.active) throw new Error("Manager Gateway runtime plugin is inactive.");
  gatewayRuntimeService.start(id);
}

function stopGateway(id: string): void {
  if (!gatewayRuntimePluginLease.active) throw new Error("Manager Gateway runtime plugin is inactive.");
  gatewayRuntimeService.stop(id);
}

function restartGateway(id: string): void {
  if (!gatewayRuntimePluginLease.active) throw new Error("Manager Gateway runtime plugin is inactive.");
  gatewayRuntimeService.restart(id);
}

function stopAllGateways(): void {
  gatewayRuntimeService.stopAll();
}

function waitForGatewayChildExit(child: ChildProcessWithoutNullStreams, timeoutMs = 5_000): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", finish);
      child.off("error", finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    child.once("exit", finish);
    child.once("error", finish);
  });
}

async function stopAllGatewaysAndWait(): Promise<void> {
  const children = runtimes.values()
    .map(runtime => runtime.process)
    .filter((child): child is ChildProcessWithoutNullStreams => Boolean(child));
  stopAllGateways();
  await Promise.all(children.map(child => waitForGatewayChildExit(child)));
}

function dataDirFor(definition: GatewayDefinition): string {
  const parts = routeRuntimeParts(definition.id);
  const configName = sanitizeConfigName(definition.configName) || parts.configName;
  return routeFolderPath(routeRoot, configName);
}

function roleInfoFor(
  definition: GatewayDefinition,
  includeContents = true,
  _catalogCache?: Map<string, Array<Record<string, unknown>>>
): Record<string, unknown> {
  return roleInfoPayload(rootDir, definition, {
    includeContents,
    personaPresentations: routeCatalogPersonas()
  });
}

function readAgentStates(definition: GatewayDefinition): Record<string, unknown> {
  const adapters = definition.agentAdapters ?? ["codex"];
  const states: Record<string, unknown> = {};
  for (const adapter of adapters) {
    states[adapter] = readAgentState(definition, adapter);
  }
  return states;
}

function readAgentState(definition: GatewayDefinition, adapterType: AgentAdapterType): Record<string, unknown> {
  const reported: Record<string, unknown> = agentStateByGateway.get(definition.id)?.[adapterType] ?? {};
  const base = defaultAgentState(definition, adapterType);
  if (adapterType === "codex") {
    return resolveCodexRuntimeState(base, reported);
  }
  const merged: Record<string, unknown> = {
    ...base,
    ...reported,
    agentAdapterType: adapterType
  };
  return {
    ...merged,
    bound: adapterType === "marvis"
      ? false
      : Boolean(merged.lastNotificationAt && !merged.lastNotificationError)
  };
}

function defaultAgentState(definition: GatewayDefinition, adapterType: AgentAdapterType): Record<string, unknown> {
  if (adapterType === "copilotCli") {
    return {
      agentAdapterType: adapterType,
      bound: false,
      monitorThreadName: resolveCopilotThreadName(definition),
      monitorThreadSource: definition.copilotCliBin || process.env.COPILOT_CLI_BIN || "copilot",
      monitorProjectPath: definition.copilotCwd || rootDir,
      message: "Copilot CLI 已配置；等待当前 Manager 进程收到成功投递上报。"
    };
  }

  if (adapterType === "marvis") {
    return {
      agentAdapterType: adapterType,
      bound: false,
      handoffOnly: true,
      monitorThreadName: "Marvis",
      monitorThreadSource: definition.marvisAppId?.trim() || process.env.MARVIS_APP_ID || "Tencent.Marvis",
      message: "Marvis 当前是打开桌面端并复制 prompt 的人工接力，不做线程绑定。"
    };
  }

  if (adapterType === "astrbot") {
    const astrbotUrl = definition.astrbotUrl?.trim() || process.env.ASTRBOT_URL || "http://127.0.0.1:6185";
    return {
      agentAdapterType: adapterType,
      bound: false,
      monitorThreadName: "AstrBot Agent",
      monitorThreadSource: astrbotUrl,
      message: "AstrBot 已配置；等待当前 Manager 进程收到成功投递上报。"
    };
  }

  if (adapterType === "dsh") {
    const dshBaseUrl = definition.dshBaseUrl?.trim() || "http://127.0.0.1:3080";
    return {
      agentAdapterType: adapterType,
      bound: Boolean(definition.dshSessionId?.trim() && definition.dshCwd?.trim()),
      monitorThreadName: definition.dshSessionName?.trim() || "DSH 主人格",
      monitorThreadSource: dshBaseUrl,
      monitorThreadId: definition.dshSessionId?.trim() || "",
      monitorThreadCwd: definition.dshCwd?.trim() || "",
      deliveryTransport: "http",
      message: "DSH 会话主人格：投递通过 DSH apiproxy session.prompt 完成。"
    };
  }

  return {
    agentAdapterType: adapterType,
    bound: false,
    monitorThreadName: resolveCodexThreadName(definition),
    monitorProjectPath: normalizeCodexCwd(definition.codexCwd) ?? rootDir,
    deliveryTransport: "desktop-ipc",
    desktopHostName: "Codex/ChatGPT Desktop",
    desktopHostRequired: true,
    message: "等待 Codex Desktop 首次接收投递；Desktop 未就绪时不会启动备用 Runtime。"
  };
}

async function checkHttpEndpoint(url: string, timeoutMs = 1200): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal
    });
    return response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function runtimeAdapterTypes(definition: GatewayDefinition): MessageAdapterType[] {
  const active = sharedGatewayAdapterTypes(definition);
  return active.length > 0 ? active : ["disabled"];
}

function adapterRuntimes(type: MessageAdapterType): GatewayRuntime[] {
  return [...runtimes.values()].filter((runtime) => runtimeAdapterTypes(runtime.definition).includes(type));
}

function firstLocalIpv4Address(): string {
  for (const addresses of Object.values(os.networkInterfaces())) {
    const match = (addresses ?? []).find((address) => address.family === "IPv4" && !address.internal);
    if (match?.address) return match.address;
  }
  return "127.0.0.1";
}

function isUnspecifiedHttpHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "0.0.0.0" || normalized === "::" || normalized === "[::]";
}

function callbackUrlForCopy(url: string, type: MessageAdapterType): string {
  if (type !== "rabilink") return url;
  try {
    const parsed = new URL(url);
    if (isUnspecifiedHttpHost(parsed.hostname)) {
      parsed.hostname = firstLocalIpv4Address();
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

function routeCallbackEndpoint(runtime: GatewayRuntime, type: MessageAdapterType): MessageAdapterEndpoint | null {
  if (type !== "webhook" && type !== "fennenote" && type !== "xiaoai" && type !== "rabilink") return null;
  const definition = runtime.definition;
  const status = readGatewayStatus(definition) as Record<string, any>;
  const callback = status.httpCallbacks?.[type];
  const port = type === "fennenote"
    ? definition.fenneNoteWebhookPort ?? definition.webhookPort ?? definition.gatewayPort
    : type === "xiaoai"
      ? definition.xiaoaiWebhookPort ?? definition.webhookPort ?? definition.gatewayPort
      : type === "rabilink"
        ? definition.rabiLinkWebhookPort ?? definition.webhookPort ?? definition.gatewayPort
        : definition.webhookPort ?? definition.gatewayPort;
  const pathValue = type === "fennenote"
    ? definition.fenneNoteWebhookPath ?? "/fennenote"
    : type === "xiaoai"
      ? definition.xiaoaiWebhookPath ?? "/xiaoai"
      : type === "rabilink"
        ? definition.rabiLinkWebhookPath ?? "/rabilink"
        : definition.webhookPath ?? "/webhook";
  const normalized = pathValue.startsWith("/") ? pathValue : `/${pathValue}`;
  const host = type === "rabilink" ? definition.rabiLinkWebhookHost?.trim() || "0.0.0.0" : "127.0.0.1";
  const url = callbackUrlForCopy(String(callback?.url || `http://${host}:${port}${normalized}`), type);
  return {
    label: `${sanitizeConfigName(definition.configName) || routeRuntimeParts(definition.id).configName} 回调入口`,
    url,
    healthy: Boolean(runtime.process && callback)
  };
}

function routeHasRecentMessages(runtime: GatewayRuntime, type: MessageAdapterType): boolean {
  try {
    const files = readMessageFiles(runtime.definition) as Record<string, { entries?: unknown[] }>;
    return Boolean(files[type]?.entries?.length);
  } catch {
    return false;
  }
}

function napcatManagerCtx(beforeLaunch?: () => void) {
  return {
    rootDir,
    getRuntimes: () => [...runtimes.values()].map(runtime => ({ ...runtime, status: readGatewayStatus(runtime.definition) as Record<string, unknown> })),
    normalizeNapCatInstances: sharedNormalizeNapCatInstances,
    appendLog,
    checkHttpEndpoint,
    runBindingOperation: <T>(request: ManagedNapcatLaunchRequest, operation: () => Promise<T>) => napcatProcessOwner.run(request, operation),
    stopOwnedInstance: (request: ManagedNapcatLaunchRequest) => napcatProcessOwner.remove(request),
    stopOwnedInstanceForRestart: (request: ManagedNapcatLaunchRequest) => napcatProcessOwner.stopForRestart(request),
    launchNapcatProcess: async (plan: NapcatLaunchPlan, visible: boolean, request: ManagedNapcatLaunchRequest) => {
      beforeLaunch?.();
      napcatProcessOwner.prepareLaunch(request);
      const child = launchManagedNapcatProcess(plan, visible);
      await napcatProcessOwner.recordLaunch(request, child.pid);
      return child;
    },
    recordNapcatLaunchPids: (request: ManagedNapcatLaunchRequest) => napcatProcessOwner.recordLaunch(request)
  };
}

function agentManagerApiCtx(): AgentManagerApiContext {
  return {
    rootDir,
    getRuntimes: () => runtimes.values(),
    checkHttpEndpoint,
    resolveWingetCopilot
  };
}

async function repairGatewayConfigsForScan(
  _targetGatewayId?: string
): Promise<{ changed: boolean; messages: string[] }> {
  const original = readConfig().gateways;
  const messages: string[] = [];
  const managedNapcatRoot = path.resolve(rootDir, "data", "napcat");
  const normalized = original.map((definition) => {
    if (!sharedDefinitionUsesNapcat(definition) && Array.isArray(definition.napcatInstances) && definition.napcatInstances.length > 0) {
      messages.push(`已移除 ${definition.id} 中残留的 NapCat 实例配置。`);
    }
    const cleanedDefinition = { ...definition };
    if (Array.isArray(cleanedDefinition.napcatInstances)) {
      const kept = cleanedDefinition.napcatInstances.filter((instance) => {
        const workingDir = instance.workingDir?.trim();
        if (!workingDir) return true;
        const resolved = path.resolve(workingDir);
        const relative = path.relative(managedNapcatRoot, resolved);
        const isManaged = relative && !relative.startsWith("..") && !path.isAbsolute(relative);
        const keep = !isManaged || fs.existsSync(resolved);
        if (!keep) {
          messages.push(`已移除 ${definition.id}/${instance.id} 中已删除的受管 NapCat 实例配置。`);
        }
        return keep;
      });
      cleanedDefinition.napcatInstances = kept;
      if ((definition.napcatInstances?.length ?? 0) > 0 && kept.length === 0) {
        cleanedDefinition.messageAdaptersDisabled = [...new Set([...(cleanedDefinition.messageAdaptersDisabled ?? []), "napcat" as MessageAdapterType])];
        cleanedDefinition.messageAdapterPolicies = {
          ...(cleanedDefinition.messageAdapterPolicies ?? {}),
          napcat: {
            ...(cleanedDefinition.messageAdapterPolicies?.napcat ?? {}),
            inputEnabled: false
          }
        };
      }
    }
    return normalizeDefinition(cleanedDefinition);
  });
  sharedAutoAssignGatewayPorts(normalized, managerPort);
  sharedValidateGatewayPortConflicts(normalized);

  const byId = new Map(original.map((definition) => [definition.id, definition]));
  for (const repaired of normalized) {
    const before = byId.get(repaired.id);
    if (!before) {
      messages.push(`已补齐路由 ${repaired.id} 的标准配置。`);
      continue;
    }
    if (before.gatewayPort !== repaired.gatewayPort) {
      messages.push(`已为 ${repaired.id} 重新分配入口端口：${before.gatewayPort} -> ${repaired.gatewayPort}。`);
    }
    if (before.webhookPort !== repaired.webhookPort && repaired.webhookPort) {
      messages.push(`已为 ${repaired.id} 重新分配 Webhook 端口：${before.webhookPort || "-"} -> ${repaired.webhookPort}。`);
    }
    if (before.fenneNoteWebhookPort !== repaired.fenneNoteWebhookPort && repaired.fenneNoteWebhookPort) {
      messages.push(`已为 ${repaired.id} 重新分配 FenneNote 端口：${before.fenneNoteWebhookPort || "-"} -> ${repaired.fenneNoteWebhookPort}。`);
    }
    if (before.xiaoaiWebhookPort !== repaired.xiaoaiWebhookPort && repaired.xiaoaiWebhookPort) {
      messages.push(`已为 ${repaired.id} 重新分配 XiaoAI 端口：${before.xiaoaiWebhookPort || "-"} -> ${repaired.xiaoaiWebhookPort}。`);
    }
    if (sharedDefinitionUsesNapcat(repaired)) {
      const beforeInstances = before.napcatInstances ?? [];
      const repairedInstances = repaired.napcatInstances ?? [];
      for (const instance of repairedInstances) {
        const old = beforeInstances.find((item) => item.id === instance.id);
        if (!old) continue;
        if (old.gatewayPort !== instance.gatewayPort) {
          messages.push(`已为 ${repaired.id}/${instance.id} 重新分配 WS 端口：${old.gatewayPort} -> ${instance.gatewayPort}。`);
        }
        if (old.httpUrl !== instance.httpUrl) {
          messages.push(`已为 ${repaired.id}/${instance.id} 重新分配 HTTP 地址：${old.httpUrl || "-"} -> ${instance.httpUrl}。`);
        }
      }
    }
  }

  const changed = messages.length > 0;
  if (changed) {
    const observedRevision = routeCatalogVersion().routeConfigHash;
    await writeConfig(
      { gateways: normalized },
      observedRevision,
      roleStorageOperationKey("route-scan-repair", observedRevision, messages.join("\n"))
    );
    syncRunningGateways();
  }
  return { changed, messages };
}

const NAPCAT_HEALTH_SCAN_DEADLINE_MS = 6_500;

function remoteAgentMessageAdapterScanResult(): PluginMessageAdapterScanResult {
  return remoteAgentHub?.localScanResult() ?? {
    type: "remoteAgent",
    label: "远端 Agent",
    maturity: "experimental",
    installed: false,
    requirements: [{
      id: "plugin",
      label: "Remote Agent 插件",
      required: true,
      ok: false,
      detail: "manager:remote-agent 未启用。"
    }],
    endpoints: [],
    warnings: ["启用 manager:remote-agent 后才会扫描和连接远端设备。"]
  };
}

async function repairAllNapcatInstances(): Promise<Record<string, unknown>> {
  const scanRepair = await repairGatewayConfigsForScan();
  const context = napcatManagerCtx();
  const results: Array<Record<string, unknown>> = [];
  for (const runtime of runtimes.values()) {
    if (!sharedDefinitionUsesNapcat(runtime.definition)) continue;
    for (const instance of runtime.definition.napcatInstances ?? sharedNormalizeNapCatInstances(runtime.definition)) {
      const health = await testNapcatHealthEndpoint(context, {
        httpUrl: instance.httpUrl,
        webuiUrl: instance.webuiUrl,
        accessToken: instance.accessToken,
        webuiToken: instance.webuiToken,
        gatewayPort: instance.gatewayPort
      });
      if (health.fixAvailable) {
        try {
          const fixed = await configureNapcatOneBot(context, {
            httpUrl: instance.httpUrl,
            webuiUrl: instance.webuiUrl,
            accessToken: instance.accessToken,
            webuiToken: instance.webuiToken,
            gatewayPort: instance.gatewayPort
          });
          results.push({
            gatewayId: runtime.definition.id,
            instanceId: instance.id,
            ok: true,
            action: "configure-onebot",
            ...fixed
          });
        } catch (error) {
          results.push({
            gatewayId: runtime.definition.id,
            instanceId: instance.id,
            ok: false,
            action: "configure-onebot",
            message: error instanceof Error ? error.message : String(error)
          });
        }
      } else {
        results.push({
          gatewayId: runtime.definition.id,
          instanceId: instance.id,
          ok: Boolean(health.ok),
          action: "health-check",
          message: health.ok ? "已连通，无需修复。" : String(health.message || "没有可自动修复项。")
        });
      }
    }
  }
  return {
    ok: true,
    repair: scanRepair,
    results,
    napcatHealth: (await napcatScanHealthPayload()).payload,
    gatewayPayload: standaloneGatewayPayload()
  };
}

async function checkNapcatHealthWithBackfill(body: NapcatHealthRequest): Promise<Record<string, unknown>> {
  let result = await testNapcatHealthEndpoint(napcatManagerCtx(), body) as Record<string, unknown>;
  const correctedWebuiUrl = correctedNapcatWebuiUrlFromHealth(result);
  if (!correctedWebuiUrl) return result;

  const runtime = body.gatewayId
    ? runtimes.get(body.gatewayId)
    : [...runtimes.values()].find(item => {
        const instances = item.definition.napcatInstances ?? sharedNormalizeNapCatInstances(item.definition);
        return instances.some(instance =>
          (body.instanceId && instance.id === body.instanceId)
          || (body.httpUrl && instance.httpUrl === body.httpUrl)
          || (body.webuiUrl && instance.webuiUrl === body.webuiUrl)
        );
      });
  const instances = runtime
    ? runtime.definition.napcatInstances ?? sharedNormalizeNapCatInstances(runtime.definition)
    : [];
  const instance = runtime
    ? instances.find(item => item.id === body.instanceId)
      ?? instances.find(item => body.httpUrl && item.httpUrl === body.httpUrl)
      ?? instances.find(item => body.webuiUrl && item.webuiUrl === body.webuiUrl)
    : undefined;
  if (!runtime || !instance) return result;

  const backfilled = await backfillNapcatInstanceWebuiUrl(
    runtime.definition,
    instance.id,
    correctedWebuiUrl
  );
  if (!backfilled) return result;
  instance.webuiUrl = backfilled;
  result = addHealthDiagnostic(result, `已根据 NapCat webui.json 自动修正 WebUI 地址：${backfilled}`);
  return result;
}

async function napcatScanHealthPayload(): Promise<{
  payload: NapcatHealthScanPayload;
  diagnostics: Record<string, ScanDiagnostic>;
  partial: boolean;
  durationMs: number;
  deadlineMs: number;
}> {
  const ctx = napcatManagerCtx();
  const napcatRuntimes = [...runtimes.values()].filter((runtime) => sharedDefinitionUsesNapcat(runtime.definition));
  return scanNapcatHealthReadOnly({
    runtimes: napcatRuntimes,
    gatewayId: (runtime) => runtime.definition.id,
    instances: (runtime) => runtime.definition.napcatInstances ?? sharedNormalizeNapCatInstances(runtime.definition),
    instanceId: (instance) => instance.id,
    instanceEnabled: (instance) => instance.enabled !== false,
    instanceMetadata: (instance) => ({
      gatewayPort: instance.gatewayPort,
      instanceName: instance.name || instance.id,
      webui: {
        url: instance.webuiUrl,
        configuredUrl: instance.webuiUrl
      }
    }),
    testHealth: (runtime, instance) => testNapcatHealthEndpoint(ctx, {
        gatewayId: runtime.definition.id,
        instanceId: instance.id,
        httpUrl: instance.httpUrl,
        webuiUrl: instance.webuiUrl,
        accessToken: instance.accessToken,
        webuiToken: instance.webuiToken,
        gatewayPort: instance.gatewayPort,
        botUserId: (instance as NapCatInstanceDefinition & { botUserId?: string | number }).botUserId,
        botNickname: (instance as NapCatInstanceDefinition & { botNickname?: string }).botNickname,
        readWebuiLoginInfo: true,
        inspectProcesses: false
      }) as Promise<Record<string, unknown>>
  }, { deadlineMs: NAPCAT_HEALTH_SCAN_DEADLINE_MS });
}








function readGatewayStatus(definition: GatewayDefinition): Record<string, unknown> {
  const statusPath = path.join(dataDirFor(definition), "gateway-status.json");
  if (!fs.existsSync(statusPath)) {
    return {
      statusPath,
      napcat: {
        connected: false
      }
    };
  }

  try {
    return {
      ...JSON.parse(fs.readFileSync(statusPath, "utf8")) as Record<string, unknown>,
      statusPath
    };
  } catch (error) {
    return {
      statusPath,
      napcat: {
        connected: false,
        error: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function napcatStatusRows(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.filter(isRecord);
  }
  if (isRecord(value)) {
    const rows: Array<Record<string, unknown>> = [];
    for (const [id, item] of Object.entries(value)) {
      if (isRecord(item)) {
        rows.push({
          id,
          ...item
        });
      }
    }
    return rows;
  }
  return [];
}

function collectStartedNapcatInstances(): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();

  for (const runtime of runtimes.values()) {
    if (!runtime.process || !sharedDefinitionUsesNapcat(runtime.definition)) {
      continue;
    }

    const configName = sanitizeConfigName(runtime.definition.configName) || routeRuntimeParts(runtime.definition.id).configName;
    const configuredInstances = runtime.definition.napcatInstances ?? sharedNormalizeNapCatInstances(runtime.definition);
    const status = readGatewayStatus(runtime.definition);
    const statusInstances = napcatStatusRows(status.napcatInstances);
    const sourceRows = statusInstances.length > 0
      ? statusInstances
      : napcatStatusRows(status.napcat ? { default: status.napcat } : {});

    for (const row of sourceRows) {
      const rowId = String(row.id || row.instanceId || "default");
      const rowPort = Number(row.gatewayPort || row.port || row.wsPort || 0);
      const configured = configuredInstances.find((instance) =>
        String(instance.id) === rowId || (rowPort > 0 && Number(instance.gatewayPort) === rowPort)
      );
      if (!configured) {
        continue;
      }
      const gatewayPort = Number(row.gatewayPort || configured?.gatewayPort || runtime.definition.gatewayPort || 0);
      const key = [
        runtime.definition.id,
        rowId,
        gatewayPort || "",
        row.httpUrl || configured?.httpUrl || ""
      ].join(":");
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      rows.push({
        ...configured,
        ...row,
        id: rowId,
        name: row.name || configured?.name || rowId,
        enabled: configured?.enabled !== false,
        gatewayPort,
        httpUrl: row.httpUrl || configured?.httpUrl || runtime.definition.napcatHttpUrl,
        webuiUrl: row.webuiUrl || configured?.webuiUrl || runtime.definition.napcatWebuiUrl,
        routeId: runtime.definition.id,
        routeName: runtime.definition.name || runtime.definition.routeName || configName,
        configName,
        started: true,
        running: true
      });
    }
  }

  return rows;
}

function gatewayStatusForRuntime(runtime: GatewayRuntime, startedNapcatInstances = collectStartedNapcatInstances()): Record<string, unknown> {
  const status = readGatewayStatus(runtime.definition);
  return {
    ...status,
    napcatInstances: startedNapcatInstances,
    napcatInstanceCount: startedNapcatInstances.length,
    napcatStartedInstanceCount: startedNapcatInstances.length
  };
}

function messageFileCandidateDirs(definition: GatewayDefinition): string[] {
  const dirs = new Set<string>();
  dirs.add(dataDirFor(definition));
  const roleId = sanitizeRoleId(definition.agentRoleId);
  const rolesDir = path.resolve(rootDir, definition.rolesDir ?? path.join("data", "roles"));
  if (roleId) {
    dirs.add(roleFolderPath(rolesDir, roleId));
  }
  for (const profile of definition.routeProfiles ?? []) {
    if (profile.dataDir) {
      dirs.add(path.resolve(rootDir, profile.dataDir));
    }
    const profileRole = sanitizeRoleId(profile.agentRoleId);
    if (profileRole) {
      dirs.add(roleFolderPath(rolesDir, profileRole));
    }
  }
  return [...dirs];
}

function recordTimeMs(record: Record<string, unknown>): number {
  const time = record.time;
  if (typeof time === "number") {
    return time < 10_000_000_000 ? time * 1000 : time;
  }
  for (const key of ["recordedAt", "createdAt", "lastEventAt", "startedAt", "endedAt"]) {
    const value = record[key];
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return 0;
}

function messageFileEntry(source: string, filePath: string, record: Record<string, unknown>): Record<string, unknown> {
  const groupId = record.groupId ?? record.group_id;
  const userId = record.userId ?? record.user_id;
  const text = record.rawMessage ?? record.message ?? record.text ?? record.content ?? record.rawLine ?? "";
  return {
    source,
    path: filePath,
    time: record.time,
    timeMs: recordTimeMs(record),
    messageId: record.messageId ?? record.message_id,
    instanceId: record.instanceId,
    adapterType: record.adapterType,
    sender: record.senderName ?? record.sender ?? record.source,
    target: groupId ? `群 ${String(groupId)}` : userId ? `私聊 ${String(userId)}` : record.source ?? source,
    text: typeof text === "string" ? text : JSON.stringify(text),
    raw: record
  };
}

type WearableAlertCliDelivery = {
  status: "delivered" | "routed" | "missed" | "failed" | "skipped";
  matchedRuleCount: number;
  sentPacketCount: number;
  reason?: string;
  adapterOutcomes?: Array<{
    adapter?: string;
    status?: string;
    error?: string;
  }>;
};

type WearableGatewayDeliveryResult = WearableAlertCliDelivery & {
  gatewayId?: string;
};

const wearableDeliveryResultPrefix = "RABIROUTE_WEARABLE_DELIVERY_RESULT:";

function wearableGatewayRuntimes(roleId: string): GatewayRuntime[] {
  const safeRoleId = sanitizeRoleId(roleId);
  if (!safeRoleId) return [];
  return [...runtimes.values()].filter((runtime) => {
    const definitionRoleId = sanitizeRoleId(runtime.definition.agentRoleId)
      || routeRuntimeParts(runtime.definition.id).roleId;
    return runtime.definition.enabled !== false
      && definitionRoleId === safeRoleId
      && sharedGatewayAdapterTypes(runtime.definition).includes("wearable");
  });
}

function parseWearableAlertCliDelivery(stdout: string): WearableAlertCliDelivery | null {
  const line = stdout.split(/\r?\n/)
    .reverse()
    .find((item) => item.startsWith(wearableDeliveryResultPrefix));
  if (!line) return null;
  try {
    const parsed = JSON.parse(line.slice(wearableDeliveryResultPrefix.length)) as Partial<WearableAlertCliDelivery>;
    if (!parsed.status || !Number.isFinite(parsed.matchedRuleCount) || !Number.isFinite(parsed.sentPacketCount)) {
      return null;
    }
    return {
      status: parsed.status,
      matchedRuleCount: Number(parsed.matchedRuleCount),
      sentPacketCount: Number(parsed.sentPacketCount),
      reason: parsed.reason,
      adapterOutcomes: Array.isArray(parsed.adapterOutcomes) ? parsed.adapterOutcomes : []
    };
  } catch {
    return null;
  }
}

function deliverWearableAlertViaGateway(
  runtime: GatewayRuntime,
  alert: WearableHealthAlert,
  context: WearableHealthAlertDeliveryContext
): Promise<WearableGatewayDeliveryResult> {
  return new Promise((resolve) => {
    const command = childCommand(["--wearable-health-alert-stdin"]);
    const child = spawn(command.command, command.args, {
      cwd: rootDir,
      env: envFor(runtime.definition),
      shell: command.shell,
      windowsHide: true
    });
    let stdout = "";
    let settled = false;
    const finish = (result: WearableGatewayDeliveryResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      appendLog(
        runtime,
        `wearable alert delivery status=${result.status} matched=${result.matchedRuleCount} sent=${result.sentPacketCount}`
      );
      resolve(result);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish({
        gatewayId: runtime.definition.id,
        status: "failed",
        matchedRuleCount: 0,
        sentPacketCount: 0,
        reason: "delivery_process_timeout"
      });
    }, 10 * 60 * 1000);
    child.stdout.on("data", (data) => {
      if (stdout.length < 256 * 1024) stdout += data.toString();
    });
    child.stderr.resume();
    child.on("error", () => finish({
      gatewayId: runtime.definition.id,
      status: "failed",
      matchedRuleCount: 0,
      sentPacketCount: 0,
      reason: "delivery_process_spawn_failed"
    }));
    child.on("exit", () => {
      const delivery = parseWearableAlertCliDelivery(stdout);
      finish(delivery
        ? { gatewayId: runtime.definition.id, ...delivery }
        : {
            gatewayId: runtime.definition.id,
            status: "failed",
            matchedRuleCount: 0,
            sentPacketCount: 0,
            reason: "delivery_process_no_result"
          });
    });
    child.stdin.on("error", () => {
      // The process exit/error handlers own the final result.
    });
    child.stdin.end(JSON.stringify({ alert, context }));
  });
}

async function deliverWearableAlert(
  roleId: string,
  alert: WearableHealthAlert,
  context: WearableHealthAlertDeliveryContext
): Promise<WearableGatewayDeliveryResult[]> {
  const candidates = wearableGatewayRuntimes(roleId);
  if (candidates.length === 0) {
    return [{
      status: "missed",
      matchedRuleCount: 0,
      sentPacketCount: 0,
      reason: "no_matching_wearable_gateway"
    }];
  }
  return Promise.all(candidates.map((runtime) => deliverWearableAlertViaGateway(runtime, alert, context)));
}

async function xiaomiHomeHealthForScan(): Promise<Record<string, unknown>> {
  if (!managerPort) throw new Error("Manager listener is not ready.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch(`http://127.0.0.1:${managerPort}/api/agent/xiaomi-home/health`, {
      method: "GET",
      signal: controller.signal
    });
    const payload = await response.json() as { data?: Record<string, unknown>; error?: { message?: string } };
    if (!response.ok || !payload.data) {
      throw new Error(payload.error?.message || `Xiaomi Home health returned HTTP ${response.status}.`);
    }
    return payload.data;
  } finally {
    clearTimeout(timer);
  }
}

type XiaomiHomeGatewayDeliveryResult = WearableAlertCliDelivery & { gatewayId?: string };
const xiaomiHomeDeliveryResultPrefix = "RABIROUTE_XIAOMI_HOME_DELIVERY_RESULT:";

function xiaomiHomeGatewayRuntimes(roleId: string): GatewayRuntime[] {
  const safeRoleId = sanitizeRoleId(roleId);
  if (!safeRoleId) return [];
  return [...runtimes.values()].filter(runtime => {
    const definitionRoleId = sanitizeRoleId(runtime.definition.agentRoleId)
      || routeRuntimeParts(runtime.definition.id).roleId;
    return runtime.definition.enabled !== false
      && definitionRoleId === safeRoleId
      && sharedGatewayAdapterTypes(runtime.definition).includes("xiaomiHome");
  });
}

function parseXiaomiHomeEventCliDelivery(stdout: string): WearableAlertCliDelivery | null {
  const line = stdout.split(/\r?\n/).reverse().find(item => item.startsWith(xiaomiHomeDeliveryResultPrefix));
  if (!line) return null;
  try {
    const parsed = JSON.parse(line.slice(xiaomiHomeDeliveryResultPrefix.length)) as Partial<WearableAlertCliDelivery>;
    if (!parsed.status || !Number.isFinite(parsed.matchedRuleCount) || !Number.isFinite(parsed.sentPacketCount)) return null;
    return {
      status: parsed.status,
      matchedRuleCount: Number(parsed.matchedRuleCount),
      sentPacketCount: Number(parsed.sentPacketCount),
      reason: parsed.reason,
      adapterOutcomes: Array.isArray(parsed.adapterOutcomes) ? parsed.adapterOutcomes : []
    };
  } catch {
    return null;
  }
}

function deliverXiaomiHomeEventViaGateway(
  runtime: GatewayRuntime,
  event: XiaomiHomeEvent,
  context: XiaomiHomeEventDeliveryContext
): Promise<XiaomiHomeGatewayDeliveryResult> {
  return new Promise(resolve => {
    const command = childCommand(["--xiaomi-home-event-stdin"]);
    const child = spawn(command.command, command.args, {
      cwd: rootDir,
      env: envFor(runtime.definition),
      shell: command.shell,
      windowsHide: true
    });
    let stdout = "";
    let settled = false;
    const finish = (result: XiaomiHomeGatewayDeliveryResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      appendLog(runtime, `xiaomi home event delivery status=${result.status} matched=${result.matchedRuleCount} sent=${result.sentPacketCount}`);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish({ gatewayId: runtime.definition.id, status: "failed", matchedRuleCount: 0, sentPacketCount: 0, reason: "delivery_process_timeout" });
    }, 10 * 60 * 1000);
    child.stdout.on("data", data => { if (stdout.length < 256 * 1024) stdout += data.toString(); });
    child.stderr.resume();
    child.on("error", () => finish({ gatewayId: runtime.definition.id, status: "failed", matchedRuleCount: 0, sentPacketCount: 0, reason: "delivery_process_spawn_failed" }));
    child.on("exit", () => {
      const delivery = parseXiaomiHomeEventCliDelivery(stdout);
      finish(delivery ? { gatewayId: runtime.definition.id, ...delivery } : {
        gatewayId: runtime.definition.id, status: "failed", matchedRuleCount: 0, sentPacketCount: 0, reason: "delivery_process_no_result"
      });
    });
    child.stdin.on("error", () => { /* exit/error handlers own the result */ });
    child.stdin.end(JSON.stringify({ event, context }));
  });
}

async function deliverXiaomiHomeEvent(
  event: XiaomiHomeEvent,
  context: XiaomiHomeEventDeliveryContext
): Promise<XiaomiHomeGatewayDeliveryResult[]> {
  const candidates = xiaomiHomeGatewayRuntimes(context.agentRoleId);
  if (candidates.length === 0) {
    return [{ status: "missed", matchedRuleCount: 0, sentPacketCount: 0, reason: "no_matching_xiaomi_home_gateway" }];
  }
  return Promise.all(candidates.map(runtime => deliverXiaomiHomeEventViaGateway(runtime, event, context)));
}

function wearableHealthMessageFileEntry(filePath: string, record: Record<string, unknown>): Record<string, unknown> {
  const metric = String(record.metric ?? "");
  const value = record.value;
  const sleepState = String(record.sleepState ?? record.stage ?? "");
  const text = metric === "heart_rate"
    ? `心率 ${String(value ?? "-")} bpm`
    : metric === "sleep_state"
      ? `睡眠状态 ${sleepState || "unknown"}`
      : metric === "sleep_session"
        ? `睡眠区间 ${String(record.startAt ?? "-")} ~ ${String(record.endAt ?? "-")}`
        : metric === "sleep_stage"
          ? `睡眠阶段 ${sleepState || "unknown"}`
          : `健康观测 ${metric || "unknown"}`;
  return {
    source: "智能手表 / 手环",
    path: filePath,
    time: record.recordedAt,
    timeMs: recordTimeMs(record),
    messageId: record.id,
    adapterType: "wearable",
    sender: record.sourceDeviceName ?? record.sourceDeviceId ?? "wearable",
    target: "健康时间线",
    text,
    raw: record
  };
}

function adapterLogEntry(filePath: string, record: Record<string, unknown>): Record<string, unknown> {
  const data = record.data && typeof record.data === "object" ? record.data as Record<string, unknown> : {};
  const text = record.message ?? data.text ?? data.rawMessage ?? data.eventType ?? record.rawLine ?? "";
  return {
    adapter: record.adapter,
    event: record.event ?? "log",
    level: record.level ?? "info",
    instanceId: record.instanceId,
    path: filePath,
    time: record.time,
    timeMs: recordTimeMs(record),
    messageId: data.messageId ?? data.message_id,
    sender: data.senderName ?? data.sender ?? data.source,
    target: data.groupId ? `群 ${String(data.groupId)}` : data.userId ? `私聊 ${String(data.userId)}` : data.path ?? data.name,
    text: typeof text === "string" ? text : JSON.stringify(text),
    raw: record
  };
}

type JsonlTailCache = Map<string, Array<Record<string, unknown>>>;

function cachedJsonlTail(
  cache: JsonlTailCache | undefined,
  filePath: string,
  limit: number
): Array<Record<string, unknown>> {
  if (!cache) return readJsonlTail(filePath, limit);
  const key = `${filePath}\0${limit}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const records = readJsonlTail(filePath, limit);
  cache.set(key, records);
  return records;
}

function readMessageFiles(
  definition: GatewayDefinition,
  tailCache?: JsonlTailCache
): Record<string, unknown> {
  const dirs = messageFileCandidateDirs(definition);
  const readEntries = (source: string, fileName: string) => dirs.flatMap((dir) => {
    const filePath = path.join(dir, fileName);
    return cachedJsonlTail(tailCache, filePath, 8).map((record) => messageFileEntry(source, filePath, record));
  });
  const sortTail = (items: Array<Record<string, unknown>>) => items
    .sort((left, right) => Number(left.timeMs || 0) - Number(right.timeMs || 0))
    .slice(-8)
    .reverse();

  const napcatEntries = sortTail([
    ...readEntries("群聊", "group-messages.jsonl"),
    ...readEntries("私聊", "private-messages.jsonl")
  ]);
  const heartbeatEntries = sortTail(readEntries("定时触发", "heartbeat-events.jsonl"));
  const rolePanelEntries = sortTail(dirs.flatMap((dir) => {
    const filePath = path.join(dir, "role-panel", "messages.jsonl");
    return cachedJsonlTail(tailCache, filePath, 8).map((record) => messageFileEntry("角色面板", filePath, record));
  }));
  const speechEntries = sortTail([
    ...readEntries("语音消息端", "speech-voice-transcripts.jsonl"),
    ...readEntries("语音消息端", "voice-transcripts.jsonl").filter((entry) => String((entry.raw as Record<string, unknown>)?.adapterType ?? "").toLowerCase() === "speech")
  ]);
  const fenneNoteEntries = sortTail([
    ...readEntries("FenneNote / 芬妮笔记", "fennenote-voice-transcripts.jsonl"),
    ...readEntries("FenneNote / 芬妮笔记", "voice-transcripts.jsonl").filter((entry) => String((entry.raw as Record<string, unknown>)?.adapterType ?? "").toLowerCase() === "fennenote")
  ]);
  const xiaoaiEntries = sortTail([
    ...readEntries("小米音箱 / 小爱", "xiaoai-voice-transcripts.jsonl"),
    ...readEntries("小米音箱 / 小爱", "voice-transcripts.jsonl").filter((entry) => String((entry.raw as Record<string, unknown>)?.adapterType ?? "").toLowerCase() === "xiaoai")
  ]);
  const rabiLinkEntries = sortTail([
    ...readEntries("RabiLink / Relay", "rabilink-voice-transcripts.jsonl"),
    ...readEntries("RabiLink / Relay", "voice-transcripts.jsonl").filter((entry) => String((entry.raw as Record<string, unknown>)?.adapterType ?? "").toLowerCase() === "rabilink")
  ]);
  const wearableHealthFiles = dirs.flatMap((dir) => {
    const eventsDir = path.join(dir, "wearable-health", "events");
    try {
      return fs.readdirSync(eventsDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.jsonl$/i.test(entry.name))
        .sort((left, right) => right.name.localeCompare(left.name))
        .slice(0, 7)
        .map((entry) => path.join(eventsDir, entry.name));
    } catch {
      return [];
    }
  });
  const wearableEntries = sortTail(wearableHealthFiles.flatMap((filePath) =>
    cachedJsonlTail(tailCache, filePath, 8).map((record) => wearableHealthMessageFileEntry(filePath, record))));
  const webhookEntries = sortTail(readEntries("通用 Webhook", "voice-transcripts.jsonl")
    .filter((entry) => {
      const adapterType = String((entry.raw as Record<string, unknown>)?.adapterType ?? "").toLowerCase();
      return !adapterType || adapterType === "webhook";
    }));
  const wecomEntries = sortTail(readEntries("企业微信 / WeCom", "wecom-messages.jsonl"));
  const weixinEntries = sortTail(readEntries("个人微信 / Weixin", "weixin-messages.jsonl"));

  return {
    napcat: {
      paths: dirs.flatMap((dir) => [
        path.join(dir, "group-messages.jsonl"),
        path.join(dir, "private-messages.jsonl")
      ]),
      entries: napcatEntries
    },
    heartbeat: {
      paths: dirs.map((dir) => path.join(dir, "heartbeat-events.jsonl")),
      entries: heartbeatEntries
    },
    rolePanel: {
      paths: dirs.map((dir) => path.join(dir, "role-panel", "messages.jsonl")),
      entries: rolePanelEntries
    },
    speech: {
      paths: dirs.flatMap((dir) => [
        path.join(dir, "speech-voice-transcripts.jsonl"),
        path.join(dir, "voice-transcripts.jsonl")
      ]),
      entries: speechEntries
    },
    fennenote: {
      paths: dirs.flatMap((dir) => [
        path.join(dir, "fennenote-voice-transcripts.jsonl"),
        path.join(dir, "voice-transcripts.jsonl")
      ]),
      entries: fenneNoteEntries
    },
    xiaoai: {
      paths: dirs.flatMap((dir) => [
        path.join(dir, "xiaoai-voice-transcripts.jsonl"),
        path.join(dir, "voice-transcripts.jsonl")
      ]),
      entries: xiaoaiEntries
    },
    rabilink: {
      paths: dirs.flatMap((dir) => [
        path.join(dir, "rabilink-voice-transcripts.jsonl"),
        path.join(dir, "voice-transcripts.jsonl")
      ]),
      entries: rabiLinkEntries
    },
    wearable: {
      paths: wearableHealthFiles,
      entries: wearableEntries
    },
    wecom: {
      paths: dirs.map((dir) => path.join(dir, "wecom-messages.jsonl")),
      entries: wecomEntries
    },
    weixin: {
      paths: dirs.map((dir) => path.join(dir, "weixin-messages.jsonl")),
      entries: weixinEntries
    },
    webhook: {
      paths: dirs.map((dir) => path.join(dir, "voice-transcripts.jsonl")),
      entries: webhookEntries
    }
  };
}

function readAdapterLogs(
  definition: GatewayDefinition,
  tailCache?: JsonlTailCache
): Record<string, unknown> {
  const dir = dataDirFor(definition);
  const readEntries = (adapter: MessageAdapterType | "outbox") => {
    const filePath = path.join(dir, `${adapter}-adapter.log.jsonl`);
    return cachedJsonlTail(tailCache, filePath, 12)
      .map((record) => adapterLogEntry(filePath, record))
      .sort((left, right) => Number(left.timeMs || 0) - Number(right.timeMs || 0))
      .reverse();
  };

  return {
    napcat: {
      paths: [path.join(dir, "napcat-adapter.log.jsonl")],
      entries: readEntries("napcat")
    },
    heartbeat: {
      paths: [path.join(dir, "heartbeat-adapter.log.jsonl")],
      entries: readEntries("heartbeat")
    },
    rolePanel: {
      paths: [path.join(dir, "rolePanel-adapter.log.jsonl")],
      entries: readEntries("rolePanel")
    },
    speech: {
      paths: [path.join(dir, "speech-adapter.log.jsonl")],
      entries: readEntries("speech")
    },
    fennenote: {
      paths: [path.join(dir, "fennenote-adapter.log.jsonl")],
      entries: readEntries("fennenote")
    },
    xiaoai: {
      paths: [path.join(dir, "xiaoai-adapter.log.jsonl")],
      entries: readEntries("xiaoai")
    },
    rabilink: {
      paths: [path.join(dir, "rabilink-adapter.log.jsonl")],
      entries: readEntries("rabilink")
    },
    wearable: {
      paths: [path.join(dir, "wearable-adapter.log.jsonl")],
      entries: readEntries("wearable")
    },
    wecom: {
      paths: [path.join(dir, "wecom-adapter.log.jsonl")],
      entries: readEntries("wecom")
    },
    weixin: {
      paths: [path.join(dir, "weixin-adapter.log.jsonl")],
      entries: readEntries("weixin")
    },
    webhook: {
      paths: [path.join(dir, "webhook-adapter.log.jsonl")],
      entries: readEntries("webhook")
    },
    outbox: {
      paths: [path.join(dir, "outbox-adapter.log.jsonl")],
      entries: readEntries("outbox")
    }
  };
}

function runtimeStatus(runtime: GatewayRuntime): Record<string, unknown> {
  const service = activeGatewayDiagnosticsSnapshotService();
  service.requestRefresh();
  const snapshot = service.read(true);
  const cached = snapshot.records.find(record => record.id === runtime.definition.id);
  return memoryOnlyGatewayRuntimeStatus(rootDir, runtime, cached);
}

function runtimeStatusWithRoleInfoCache(
  runtime: GatewayRuntime,
  roleInfoCatalogCache?: Map<string, Array<Record<string, unknown>>>,
  tailCache?: JsonlTailCache
): Record<string, unknown> {
  const usesNapcat = sharedDefinitionUsesNapcat(runtime.definition);
  const gatewayStatus = gatewayStatusForRuntime(runtime);
  const rabiLinkRelay = rabiLinkRelayConfigFor(runtime.definition);
  return {
    id: runtime.definition.id,
    name: runtime.definition.name,
    configName: sanitizeConfigName(runtime.definition.configName) || routeRuntimeParts(runtime.definition.id).configName,
    enabled: runtime.definition.enabled,
    messageAdapterType: runtime.definition.messageAdapterType ?? "napcat",
    messageAdapters: runtime.definition.messageAdapters ?? [runtime.definition.messageAdapterType ?? "napcat"],
    messageAdaptersDisabled: runtime.definition.messageAdaptersDisabled ?? [],
    messageInputsDisabled: runtime.definition.messageInputsDisabled === true,
    messageAdapterPolicies: runtime.definition.messageAdapterPolicies ?? {},
    agentAdapters: runtime.definition.agentAdapters ?? ["codex"],
    primaryAgentAdapter: runtime.definition.primaryAgentAdapter,
    messageProcessingAgents: runtime.definition.messageProcessingAgents ?? {},
    pipelinePreset: runtime.definition.pipelinePreset,
    pipeline: runtime.definition.pipeline,
    gatewayPort: runtime.definition.gatewayPort,
    webhookPort: runtime.definition.webhookPort,
    webhookPath: runtime.definition.webhookPath,
    fenneNoteWebhookPort: runtime.definition.fenneNoteWebhookPort,
    fenneNoteWebhookPath: runtime.definition.fenneNoteWebhookPath,
    xiaoaiWebhookPort: runtime.definition.xiaoaiWebhookPort,
    xiaoaiWebhookPath: runtime.definition.xiaoaiWebhookPath,
    rabiLinkWebhookPort: runtime.definition.rabiLinkWebhookPort,
    rabiLinkWebhookPath: runtime.definition.rabiLinkWebhookPath,
    rabiLinkWebhookHost: runtime.definition.rabiLinkWebhookHost,
    rabiLinkRelayEnabled: rabiLinkRelay.enabled,
    rabiLinkRelayUrl: rabiLinkRelay.url,
    rabiLinkRelayToken: rabiLinkRelay.token ? "********" : "",
    rabiLinkRelayDeviceId: rabiLinkRelay.deviceId,
    rabiLinkRelayClaimWaitMs: rabiLinkRelay.claimWaitMs,
    rabiLinkRelayReplyIdleTimeoutMs: rabiLinkRelay.replyIdleTimeoutMs,
    rabiLinkRelayConfigScope: hasGlobalRabiLinkRelayConfig() ? "global" : "route-fallback",
    wecomBotId: runtime.definition.wecomBotId,
    wecomBotSecret: runtime.definition.wecomBotSecret,
    wecomWsUrl: runtime.definition.wecomWsUrl,
    feishuAppId: runtime.definition.feishuAppId ? "********" : "",
    feishuAppSecret: runtime.definition.feishuAppSecret ? "********" : "",
    feishuVerificationToken: runtime.definition.feishuVerificationToken ? "********" : "",
    feishuEncryptKey: runtime.definition.feishuEncryptKey ? "********" : "",
    feishuEventSubscriptionEnabled: runtime.definition.feishuEventSubscriptionEnabled === true,
    feishuWebhookPort: runtime.definition.feishuWebhookPort,
    feishuWebhookPath: runtime.definition.feishuWebhookPath,
    weixinBaseUrl: runtime.definition.weixinBaseUrl,
    weixinBotType: runtime.definition.weixinBotType,
    heartbeatIntervalSeconds: runtime.definition.heartbeatIntervalSeconds ?? 900,
    heartbeatMessage: runtime.definition.heartbeatMessage ?? "",
    personaAutomationScriptsEnabled: runtime.definition.personaAutomationScriptsEnabled === true,
    remoteAgentDefaultDeviceId: runtime.definition.remoteAgentDefaultDeviceId ?? "",
    remoteAgentDefaultCwd: runtime.definition.remoteAgentDefaultCwd ?? "",
    remoteAgentDefaultThreadName: runtime.definition.remoteAgentDefaultThreadName ?? "",
    napcatHttpUrl: runtime.definition.napcatHttpUrl ?? "http://127.0.0.1:3000",
    napcatWebuiUrl: runtime.definition.napcatWebuiUrl ?? "http://127.0.0.1:6099/webui",
    napcatAccessToken: runtime.definition.napcatAccessToken ?? "",
    napcatWebuiToken: runtime.definition.napcatWebuiToken ?? "",
    napcatInstances: usesNapcat ? (runtime.definition.napcatInstances ?? sharedNormalizeNapCatInstances(runtime.definition)) : [],
    targetGroupId: runtime.definition.targetGroupId ?? "",
    routeVariables: runtime.definition.routeVariables,
    routeName: runtime.definition.routeName,
    routeProfiles: runtime.definition.routeProfiles ?? [],
    agentModel: runtime.definition.agentModel ?? "",
    agentReasoningEffort: runtime.definition.agentReasoningEffort,
    dshModelProvider: runtime.definition.dshModelProvider,
    dshModel: runtime.definition.dshModel,
    dshReasoningEffort: runtime.definition.dshReasoningEffort,
    codexThreadId: runtime.definition.codexThreadId,
    codexThreadName: resolveCodexThreadName(runtime.definition),
    codexCwd: runtime.definition.codexCwd,
    codexPlanAssistantEnabled: runtime.definition.codexPlanAssistantEnabled === true,
    codexPlanAssistantModel: normalizeCodexPlanAssistantModel(runtime.definition.codexPlanAssistantModel),
    codexPlanAssistantSessions: runtime.definition.codexPlanAssistantSessions ?? [],
    codexMemoryConsolidationAgentEnabled: runtime.definition.codexMemoryConsolidationAgentEnabled === true,
    codexMemoryConsolidationAgentModel: normalizeCodexMemoryConsolidationAgentModel(runtime.definition.codexMemoryConsolidationAgentModel),
    codexHooks: normalizeCodexHookSettings(runtime.definition.codexHooks),
    copilotThreadName: resolveCopilotThreadName(runtime.definition),
    copilotCwd: runtime.definition.copilotCwd,
    copilotCliBin: runtime.definition.copilotCliBin,
    marvisAppId: runtime.definition.marvisAppId,
    astrbotUrl: runtime.definition.astrbotUrl,
    astrbotUsername: runtime.definition.astrbotUsername,
    astrbotPassword: runtime.definition.astrbotPassword,
    astrbotProjectId: runtime.definition.astrbotProjectId,
    astrbotSessionId: runtime.definition.astrbotSessionId,
    rolesDir: runtime.definition.rolesDir,
    routesDir: runtime.definition.routesDir,
    agentRoleId: runtime.definition.agentRoleId,
    agentRoleFile: runtime.definition.agentRoleFile,
    roleInfo: roleInfoFor(runtime.definition, true, roleInfoCatalogCache),
    dataDir: runtime.definition.dataDir,
    groupNotificationTemplate: runtime.definition.groupNotificationTemplate,
    groupAtNotificationTemplate: runtime.definition.groupAtNotificationTemplate,
    groupDirectReplyNotificationTemplate: runtime.definition.groupDirectReplyNotificationTemplate,
    groupIndirectReplyNotificationTemplate: runtime.definition.groupIndirectReplyNotificationTemplate,
    groupReplyNotificationTemplate: runtime.definition.groupReplyNotificationTemplate,
    groupNicknameNotificationTemplate: runtime.definition.groupNicknameNotificationTemplate,
    privateNotificationTemplate: runtime.definition.privateNotificationTemplate,
    notificationRules: runtime.definition.notificationRules,
    automationRules: runtime.definition.automationRules,
    roleNotificationRules: runtime.definition.roleNotificationRules,
    roleRouteNames: runtime.definition.roleRouteNames,
    running: runtime.readiness === "ready",
    lifecycleState: runtime.readiness,
    endpoints: runtime.endpoints,
    lastError: runtime.lastError,
    pid: runtime.process?.pid ?? null,
    startedAt: runtime.startedAt,
    stoppedAt: runtime.stoppedAt,
    lastExit: runtime.lastExit,
    gatewayStatus,
    adapterLogs: readAdapterLogs(runtime.definition, tailCache),
    messageFiles: readMessageFiles(runtime.definition, tailCache),
    agentStates: readAgentStates(runtime.definition),
    log: runtime.log.slice(-30)
  };
}

function runtimeSummaryStatusWithRoleInfoCache(
  runtime: GatewayRuntime,
  roleInfoCatalogCache?: Map<string, Array<Record<string, unknown>>>
): Record<string, unknown> {
  const definition = runtime.definition;
  const usesNapcat = sharedDefinitionUsesNapcat(definition);
  const napcatInstances = usesNapcat
    ? (definition.napcatInstances ?? sharedNormalizeNapCatInstances(definition)).map((instance) => ({
      id: instance.id,
      name: instance.name,
      enabled: instance.enabled,
      botNickname: instance.botNickname
    }))
    : [];
  return {
    id: definition.id,
    name: definition.name,
    configName: sanitizeConfigName(definition.configName) || routeRuntimeParts(definition.id).configName,
    routeName: definition.routeName,
    enabled: definition.enabled,
    running: runtime.readiness === "ready",
    lifecycleState: runtime.readiness,
    messageAdapterType: definition.messageAdapterType ?? "napcat",
    messageAdapters: definition.messageAdapters ?? [definition.messageAdapterType ?? "napcat"],
    agentRoleId: definition.agentRoleId,
    agentRoleFile: definition.agentRoleFile,
    rolesDir: definition.rolesDir,
    roleInfo: roleInfoFor(definition, false, roleInfoCatalogCache),
    roleRouteNames: definition.roleRouteNames,
    napcatInstances,
    codexCwd: definition.codexCwd,
    dataDir: definition.dataDir,
    notificationRules: definition.notificationRules
  };
}

/** Executed only inside ManagerReadWorkerPool's child process. */
export function buildGatewayDiagnosticsWorkerSnapshot(
  input: GatewayDiagnosticsWorkerInput
): GatewayDiagnosticsWorkerResult {
  return buildIsolatedGatewayDiagnosticsSnapshot(input, {
    reset: personaPresentations => {
      for (const id of runtimes.keys()) runtimes.delete(id);
      agentStateByGateway.clear();
      routeCatalogPersonaPresentations = Object.freeze([...personaPresentations]);
    },
    install: snapshot => {
      runtimes.set(snapshot.definition, {
        process: snapshot.processPid === null
          ? null
          : ({ pid: snapshot.processPid } as ChildProcessWithoutNullStreams),
        needsRestart: snapshot.needsRestart,
        startedAt: snapshot.startedAt,
        stoppedAt: snapshot.stoppedAt,
        lastExit: snapshot.lastExit,
        readiness: snapshot.readiness,
        endpoints: snapshot.endpoints,
        lastError: snapshot.lastError,
        log: [...snapshot.log]
      });
      agentStateByGateway.set(
        snapshot.definition.id,
        snapshot.agentStates as Partial<Record<AgentAdapterType, AgentRuntimeState>>
      );
    },
    runtimes: () => runtimes.values(),
    diagnostics: (runtime, roleInfoCatalogCache, tailCache) =>
      runtimeStatusWithRoleInfoCache(runtime, roleInfoCatalogCache, tailCache),
    summary: (runtime, roleInfoCatalogCache) =>
      runtimeSummaryStatusWithRoleInfoCache(runtime, roleInfoCatalogCache)
  });
}

function jsonResponse(response: http.ServerResponse, statusCode: number, body: unknown): void {
  if (statusCode >= 400) {
    const context = managerRequestContexts.get(response);
    const responseBody = body as { message?: unknown; error?: unknown } | null;
    const failure = responseBody?.message ?? responseBody?.error ?? `HTTP ${statusCode}`;
    managerOperationalLog.record(statusCode >= 500 ? "error" : "warn", "http_response_error", {
      requestId: context?.requestId,
      method: context?.method,
      pathname: context?.pathname(),
      statusCode,
      durationMs: context ? Math.max(0, Date.now() - context.startedAt) : undefined,
      result: "failed",
      error: managerOperationalError(failure, rootDir)
    });
  }
  const serialized = measureSyncPerformanceOperation(
    PERFORMANCE_OPERATIONS.managerHttpJsonSerialize,
    () => JSON.stringify(body)
  );
  const context = managerRequestContexts.get(response);
  if (context) context.responseBytes = Buffer.byteLength(serialized);
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(serialized);
}

function readJsonBody<T>(request: http.IncomingMessage, maxBytes = 0): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;
    request.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      if (maxBytes > 0 && total > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(buffer);
    });
    request.on("end", () => {
      try {
        if (tooLarge) throw new Error(`Request body exceeds ${maxBytes} bytes.`);
        const text = Buffer.concat(chunks).toString("utf8");
        resolve((text ? JSON.parse(text) : {}) as T);
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function singleRequestHeader(request: http.IncomingMessage, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    if (value.length !== 1) {
      throw new RoleStorageApplicationError(`${name} must be sent exactly once.`, "invalid_request", 400);
    }
    return value[0]?.trim() || undefined;
  }
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function roleStorageRequestContext(
  request: http.IncomingMessage,
  response: http.ServerResponse
): RoleStorageCommandContext {
  const controller = new AbortController();
  request.once("aborted", () => controller.abort(new Error("Role storage request was aborted.")));
  response.once("close", () => {
    if (!response.writableEnded) controller.abort(new Error("Role storage response closed before completion."));
  });
  return Object.freeze({
    idempotencyKey: singleRequestHeader(request, "idempotency-key"),
    expectedRevision: singleRequestHeader(request, "if-match")
      ?? singleRequestHeader(request, "x-rabiroute-expected-revision"),
    signal: controller.signal
  });
}

function currentRoleStorageApplication(): RoleStorageApplication {
  if (!activeStorageLifecycleGeneration) {
    throw new RoleStorageApplicationError("Role storage is not ready.", "busy", 503);
  }
  return activeStorageLifecycleGeneration.roleStorage;
}

async function appendRolePanelTimeline(
  roleId: string,
  message: RolePanelTimelineMessage
): Promise<RolePanelTimelineAppendResult> {
  const receipt = await currentRoleStorageApplication().commands.appendRolePanelTimeline(roleId, message, {
    idempotencyKey: roleStorageOperationKey("role-panel-timeline-append", roleId, message.id),
    expectedRevision: null
  });
  return receipt.commit;
}

async function submitAgentPlanFeedback(
  input: AgentPlanFeedbackSubmitRequest
): Promise<AgentPlanFeedbackSubmitResult> {
  const application = currentRoleStorageApplication();
  const projection = await application.queries.planFeedback(input.roleId, input.planId, {
    timeoutMs: 30_000
  });
  if (!projection) {
    throw new RoleStorageApplicationError(
      `Plan not found for feedback reply: ${input.roleId}/${input.planId}.`,
      "not_found",
      404
    );
  }
  const committed = await application.commands.submitPlanFeedback(input.roleId, input.planId, {
    feedbackId: input.feedbackId,
    stepId: input.stepId,
    gatewayId: input.gatewayId,
    kind: input.kind,
    author: "agent",
    source: "agent",
    text: input.text,
    notifyAgent: false
  }, {
    expectedRevision: projection.planRevision,
    idempotencyKey: roleStorageOperationKey("agent-plan-feedback-reply", input.deliveryId),
    timeoutMs: 30_000
  });
  return Object.freeze({
    record: committed.commit.record,
    created: committed.commit.created
  });
}

function respondRoleStorageError(response: http.ServerResponse, error: unknown): void {
  const mapped = roleStorageHttpError(error);
  for (const [name, value] of Object.entries(mapped.headers)) response.setHeader(name, value);
  jsonResponse(response, mapped.statusCode, mapped.body);
}

function respondRoleStorageCommit(
  response: http.ServerResponse,
  statusCode: number,
  operationId: string,
  data: unknown,
  revision?: string | null
): void {
  response.setHeader("idempotency-key", operationId);
  if (revision) response.setHeader("etag", `"${revision}"`);
  jsonResponse(response, statusCode, { code: 0, data });
}

async function readRoleStorageJsonBody<T>(request: http.IncomingMessage, maxBytes = 0): Promise<T> {
  try {
    return await readJsonBody<T>(request, maxBytes);
  } catch {
    throw new RoleStorageApplicationError("Request body must be valid JSON within the allowed size.", "invalid_request", 400);
  }
}

function readBodyBuffer(request: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      if (total > maxBytes) {
        reject(new Error(`Request body exceeds ${maxBytes} bytes.`));
        request.destroy();
        return;
      }
      chunks.push(buffer);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

type ManualTriggerRequest = {
  triggerId?: string;
  triggerName?: string;
  message?: string;
  routeKind?: string;
  ruleId?: string;
  triggerSource?: "manual" | "auto";
};


type RolePanelMessageRequest = {
  gatewayId?: string;
  text?: string;
  attachments?: RolePanelAttachment[];
};

type PlanFeedbackRequest = {
  feedbackId?: string;
  gatewayId?: string;
  stepId?: string;
  text?: string;
  kind?: "guidance" | "guidance_response" | "approval_suggestion" | "approval_response";
  author?: "user" | "agent" | "system";
  source?: "webgui" | "tray" | "qq" | "agent" | "api";
  attachments?: PlanFeedbackAttachmentUpload[];
  planAttachmentIds?: string[];
  notifyAgent?: boolean;
};

const manualTriggerProcesses = new ManualTriggerProcessRegistry();

type ManualTriggerCompletionCallbacks = {
  onSuccess?: () => void;
  onFailure?: (error: Error) => void;
};

function triggerGatewayManualRule(
  id: string,
  request: ManualTriggerRequest = {},
  completion: ManualTriggerCompletionCallbacks = {},
  owner?: string
): ManualTriggerLaunchResult {
  const runtime = runtimes.get(id);
  if (!runtime) {
    throw new Error(`Gateway not found: ${id}`);
  }

  const triggerId = sanitizeRoleId(request.triggerId) || "manual";
  const triggerName = request.triggerName?.trim() || triggerId;
  const message = request.message?.trim() || triggerName;
  const routeKind = normalizeManualRouteKind(request.routeKind);
  const triggerSource = request.triggerSource === "auto" ? "auto" : "manual";
  const ruleId = sanitizeRoleId(request.ruleId) || (routeKind === "heartbeat" ? "" : triggerId);
  const args = [
    `--manual-trigger=${triggerId}`,
    `--manual-name=${encodeURIComponent(triggerName)}`,
    `--manual-message=${encodeURIComponent(message)}`,
    `--manual-route-kind=${routeKind}`,
    `--manual-source=${triggerSource}`
  ];
  if (ruleId) {
    args.push(`--manual-rule=${ruleId}`);
  }
  const command = childCommand(args);
  const processKey = `${id}:${routeKind}:${triggerId}`;
  const result = manualTriggerProcesses.launch(
    processKey,
    () => {
      appendLog(runtime, `manual trigger requested: ${triggerName}`);
      return spawn(command.command, command.args, {
        cwd: rootDir,
        env: envFor(runtime.definition),
        shell: command.shell,
        windowsHide: true
      });
    },
    {
      onStdout: (text) => {
        for (const line of text.split(/\r?\n/).filter(Boolean)) {
          appendLog(runtime, `manual trigger: ${line}`);
        }
      },
      onStderr: (text) => {
        for (const line of text.split(/\r?\n/).filter(Boolean)) {
          appendLog(runtime, `manual trigger error: ${line}`);
        }
      },
      onError: (error) => {
        appendLog(runtime, `manual trigger process error: ${error.message}`);
        completion.onFailure?.(error);
      },
      onExit: (code, signal) => {
        if (code === 0) {
          appendLog(runtime, `manual trigger completed: ${triggerName}`);
          completion.onSuccess?.();
          return;
        }
        const error = new Error(`manual trigger failed: code=${code ?? "null"} signal=${signal ?? "null"}`);
        appendLog(runtime, error.message);
        completion.onFailure?.(error);
      }
    },
    owner
  );
  if (result.alreadyRunning) {
    appendLog(runtime, `manual trigger already running: ${triggerName}`);
  }
  return result;
}

function normalizeManualRouteKind(value: unknown): ForwardRouteKind {
  return value === "heartbeat" ? "heartbeat" : "manual_trigger";
}

function routeDataDirForDefinition(definition: GatewayDefinition): string {
  const configName = routeRuntimeParts(definition.id).configName || sanitizeConfigName(definition.name ?? definition.id);
  return routeFolderPath(routeRoot, configName);
}

function listGatewayDeliveryReplayAttempts(id: string, limit: number, status: string | null): Record<string, unknown> {
  const runtime = runtimes.get(id);
  if (!runtime) {
    throw new Error(`Gateway not found: ${id}`);
  }
  const dataDir = routeDataDirForDefinition(runtime.definition);
  return {
    gatewayId: id,
    dataDir: path.relative(rootDir, dataDir).replace(/\\/g, "/"),
    attempts: listDeliveryReplayAttempts(dataDir, {
      status: status === "failed" || status === "delivered" || status === "missed" || status === "routed" || status === "skipped" ? status : undefined,
      limit
    }).map((attempt) => ({
      attemptId: attempt.attemptId,
      time: attempt.time,
      routeKind: attempt.routeKind,
      messageId: attempt.messageId,
      status: attempt.result.status,
      matchedRuleCount: attempt.result.matchedRuleCount,
      sentPacketCount: attempt.result.sentPacketCount,
      failedAdapterCount: attempt.result.adapterOutcomes.filter((outcome) => outcome.status === "failed").length,
      packetCount: attempt.packets.length,
      replayOfAttemptId: attempt.replayOfAttemptId
    }))
  };
}

function replayGatewayDelivery(id: string, request: DeliveryReplayRequest = {}): Promise<void> {
  const runtime = runtimes.get(id);
  if (!runtime) {
    throw new Error(`Gateway not found: ${id}`);
  }
  const attemptIds = (request.attemptIds?.length ? request.attemptIds : request.attemptId ? [request.attemptId] : [])
    .map((item) => String(item).trim())
    .filter(Boolean);
  const routeKind = parseReplayRouteKind(request.routeKind);
  const messageId = request.messageId?.trim();
  if (attemptIds.length === 0 && (!routeKind || !messageId)) {
    throw new Error("No delivery replay attempt id was provided.");
  }

  const mode = request.mode === "merge" || attemptIds.length > 1 ? "merge" : "single";
  const args = [
    `--delivery-replay-mode=${mode}`
  ];
  if (attemptIds.length > 0) {
    args.push(`--delivery-replay=${encodeURIComponent(attemptIds.join(","))}`);
  }
  if (routeKind && messageId) {
    args.push(`--delivery-replay-route-kind=${routeKind}`, `--delivery-replay-message=${encodeURIComponent(messageId)}`);
  }
  const command = childCommand(args);
  appendLog(runtime, `delivery replay requested: mode=${mode} attempts=${attemptIds.join(",") || "none"} message=${routeKind && messageId ? `${routeKind}:${messageId}` : "none"}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command.command, command.args, {
      cwd: rootDir,
      env: envFor(runtime.definition),
      shell: command.shell,
      windowsHide: true
    });

    child.stdout.on("data", (data) => {
      for (const line of data.toString("utf8").split(/\r?\n/).filter(Boolean)) {
        appendLog(runtime, `delivery replay: ${line}`);
      }
    });
    child.stderr.on("data", (data) => {
      for (const line of data.toString("utf8").split(/\r?\n/).filter(Boolean)) {
        appendLog(runtime, `delivery replay error: ${line}`);
      }
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        appendLog(runtime, `delivery replay completed: mode=${mode} attempts=${attemptIds.length}`);
        resolve();
        return;
      }
      reject(new Error(`delivery replay failed: code=${code ?? "null"} signal=${signal ?? "null"}`));
    });
  });
}

function parseReplayRouteKind(value: unknown): ForwardRouteKind | undefined {
  return value === "private"
    || value === "group_message"
    || value === "direct_at"
    || value === "direct_reply"
    || value === "indirect_reply"
    || value === "heartbeat"
    || value === "manual_trigger"
    || value === "role_panel_message"
    || value === "plan_feedback"
    || value === "voice_transcript"
    ? value
    : undefined;
}

function roleDirForDefinition(definition: GatewayDefinition): string {
  const rolesDir = path.resolve(rootDir, definition.rolesDir ?? path.join("data", "roles"));
  const roleId = sanitizeRoleId(definition.agentRoleId) || routeRuntimeParts(definition.id).roleId || "Rabi";
  return roleFolderPath(rolesDir, roleId);
}

function memoryConsolidationScheduleTargets(): MemoryConsolidationScheduleTarget[] {
  return runtimes.values()
    .filter((runtime) => runtime.definition.enabled !== false)
    .map((runtime) => {
      const roleDir = roleDirForDefinition(runtime.definition);
      const roleId = roleIdForDefinition(runtime.definition);
      return {
        gatewayId: runtime.definition.id,
        roleId,
        roleKey: path.resolve(roleDir).toLowerCase(),
        roleDir
      };
    });
}

function deliverAutomaticMemoryConsolidation(
  target: MemoryConsolidationScheduleTarget,
  run: DueMemoryConsolidationRun
): Promise<void> {
  return new Promise((resolve, reject) => {
    const result = triggerGatewayManualRule(target.gatewayId, {
      triggerId: "memory-consolidation",
      triggerName: "记忆沉淀",
      message: `近期记忆已到达 72 小时触发时间，请处理沉淀批次 ${run.runId}。`,
      routeKind: "manual_trigger",
      ruleId: "memory-consolidation",
      triggerSource: "auto"
    }, {
      onSuccess: () => {
        void currentRoleStorageApplication().commands.markMemoryConsolidationDelivered(
          target.roleId,
          run.runId,
          undefined,
          {
            idempotencyKey: roleStorageOperationKey("memory-delivered", run.runId),
            expectedRevision: run.revision,
            timeoutMs: 30_000
          }
        ).then(() => {
          const runtime = runtimes.get(target.gatewayId);
          publishManagerEvent("memory_consolidation_changed", {
            gatewayId: target.gatewayId,
            roleId: runtime ? roleIdForDefinition(runtime.definition) : target.roleId,
            runId: run.runId,
            status: "requested"
          });
          resolve();
        }, reject);
      },
      onFailure: reject
    }, "manager:memory-consolidation");
    if (result.alreadyRunning) resolve();
  });
}

function createMemoryConsolidationScheduler(): MemoryConsolidationScheduler {
  const failureStateRoot = path.join(projectDirectoryLayout(rootDir).runtimeStateRoot, "background-failure-circuits");
  return new MemoryConsolidationScheduler({
    listTargets: memoryConsolidationScheduleTargets,
    evaluate: (target, signal) => evaluateMemoryConsolidationSchedule(target.roleDir, { signal, timeoutMs: 30_000 }),
    requestDueRun: async (target, dueOperationIdentity) => {
      if (!dueOperationIdentity) return null;
      const committed = await currentRoleStorageApplication().commands.requestMemoryConsolidation(
        target.roleId,
        { triggerSource: "auto" },
        {
          idempotencyKey: roleStorageOperationKey(
            "memory-consolidation-auto",
            target.roleId,
            dueOperationIdentity
          ),
          timeoutMs: 30_000
        }
      );
      const projection = committed.projection;
      return projection
        ? {
            runId: projection.run.id,
            delivered: Boolean(projection.run.deliveredAt),
            revision: projection.revision
          }
        : null;
    },
    deliver: deliverAutomaticMemoryConsolidation,
    persistencePath: path.join(failureStateRoot, "memory-consolidation.json"),
    onPersistenceError: (error) => {
      managerOperationalLog.record("warn", "background_failure_state_persist_failed", {
        action: "memory-consolidation",
        error: managerOperationalError(error, rootDir)
      });
    },
    onError: (target, error, circuit) => {
      const runtime = runtimes.get(target.gatewayId);
      const diagnostic = memoryConsolidationFailureDiagnostic(error);
      if (runtime) {
        appendLog(runtime, `automatic memory consolidation failed; phase=${circuit.snapshot.phase}; failures=${circuit.snapshot.consecutiveFailures}; retryAt=${new Date(circuit.snapshot.retryAt).toISOString()}; ${diagnostic.runtimeLogSuffix}`);
      }
      managerOperationalLog.record("error", "memory_consolidation_auto_failed", {
        result: `gatewayId=${target.gatewayId}; phase=${circuit.snapshot.phase}; failures=${circuit.snapshot.consecutiveFailures}; signature=${circuit.snapshot.signature}; retryAt=${new Date(circuit.snapshot.retryAt).toISOString()}; ${diagnostic.runtimeLogSuffix}`,
        error: diagnostic.operationalError
      });
    },
    onIncident: (target, error, circuit) => {
      const diagnostic = memoryConsolidationFailureDiagnostic(error);
      managerOperationalLog.record("error", "memory_consolidation_incident_opened", {
        action: `gatewayId=${target.gatewayId}`,
        result: `incidentId=${circuit.snapshot.incidentId}; signature=${circuit.snapshot.signature}; failures=${circuit.snapshot.consecutiveFailures}; retryAt=${new Date(circuit.snapshot.retryAt).toISOString()}; ${diagnostic.runtimeLogSuffix}`,
        error: diagnostic.operationalError
      });
    }
  });
}

function roleIdForDefinition(definition: GatewayDefinition): string {
  return sanitizeRoleId(definition.agentRoleId) || routeRuntimeParts(definition.id).roleId || "Rabi";
}

function roleIdsForPlanBoundSession(sessionId: string, cwd?: string): Set<string> {
  const roleIds = new Set<string>();
  const candidateRoleIds = new Set(
    [...runtimes.values()].map(runtime => roleIdForDefinition(runtime.definition))
  );
  for (const roleId of candidateRoleIds) {
    const roleDir = roleDirForApi(roleId);
    const plans = publishedRolePlans(roleDir);
    if (!plans) {
      requestRoleKnowledgeCatalogRefresh(roleDir);
      continue;
    }
    for (const plan of plans) {
      const bindings = [plan.taskBinding, plan.secretaryBinding];
      if (bindings.some((binding) => binding?.sessionId === sessionId && hookWorkspaceMatches(binding.workspace, cwd))) {
        roleIds.add(roleId);
        break;
      }
    }
  }
  return roleIds;
}

function gatewayIdsForManagedSession(sessionId: string, cwd?: string): Set<string> {
  const exactSessionId = String(sessionId || "").trim();
  const gatewayIds = new Set<string>();
  for (const runtime of runtimes.values()) {
    if (
      (String(runtime.definition.codexThreadId || "").trim() === exactSessionId
        && hookWorkspaceMatches(runtime.definition.codexCwd, cwd))
      || (String(runtime.definition.dshSessionId || "").trim() === exactSessionId
        && hookWorkspaceMatches(runtime.definition.dshCwd, cwd))
    ) {
      gatewayIds.add(runtime.definition.id);
    }
  }
  for (const requirement of messageProcessingBoard.list({ limit: 10_000 })) {
    if (
      (requirement.worker?.threadId === exactSessionId && hookWorkspaceMatches(requirement.worker.workspace, cwd))
      || requirement.handoff?.targetThreadId === exactSessionId
    ) {
      gatewayIds.add(requirement.source.routeId);
    }
  }
  const roleIds = roleIdsForPlanBoundSession(exactSessionId, cwd);
  if (roleIds.size > 0) {
    for (const runtime of runtimes.values()) {
      if (roleIds.has(roleIdForDefinition(runtime.definition))) gatewayIds.add(runtime.definition.id);
    }
  }
  return gatewayIds;
}

function codexHookSettingsForSession(sessionId: string, cwd?: string): CodexHookSettings {
  const exactSessionId = String(sessionId || "").trim();
  const managedGatewayIds = gatewayIdsForManagedSession(exactSessionId, cwd);
  const matches = [...runtimes.values()].filter((runtime) => (
    managedGatewayIds.has(runtime.definition.id)
  ));
  if (matches.length === 0) return { ...DEFAULT_CODEX_HOOK_SETTINGS };
  const settings = matches.map((runtime) => normalizeCodexHookSettings(runtime.definition.codexHooks));
  return {
    sessionContextEnabled: settings.every((item) => item.sessionContextEnabled),
    reasoningContextEnabled: settings.every((item) => item.reasoningContextEnabled),
    planTaskCompletionEnabled: settings.every((item) => item.planTaskCompletionEnabled),
    agentCommunicationEnforcementEnabled: settings.every((item) => item.agentCommunicationEnforcementEnabled),
    onlyPrimaryPersonaCanSendMessages: settings.every((item) => item.onlyPrimaryPersonaCanSendMessages)
  };
}

function codexHookEnabled(request: CodexHookContextRequest): boolean {
  const settings = codexHookSettingsForSession(request.sessionId, request.cwd);
  if (request.eventName === "SessionStart" || request.eventName === "UserPromptSubmit") {
    return settings.sessionContextEnabled;
  }
  if (request.eventName === "PreToolUse" || request.eventName === "PostToolUse") {
    return settings.reasoningContextEnabled;
  }
  return settings.planTaskCompletionEnabled;
}

function hookWorkspaceMatches(expected: string | undefined, actual: string | undefined): boolean {
  if (!expected || !actual) return true;
  return normalizePathForComparison(expected) === normalizePathForComparison(actual);
}

function isManagedAgentSession(request: CodexHookContextRequest): boolean {
  const sessionId = String(request.sessionId || "").trim();
  if (!sessionId) return false;
  const managed = agentRequests.hasManagedSession(sessionId, request.cwd)
    || gatewayIdsForManagedSession(sessionId, request.cwd).size > 0;
  if (!managed) return false;
  return codexHookSettingsForSession(sessionId, request.cwd).agentCommunicationEnforcementEnabled;
}

function recordAgentRequestStop(request: CodexHookContextRequest): AgentRequestStopResult {
  if (managerReadOnly) return { status: "ignored", reason: "manager_read_only", turnId: request.turnId };
  const turnId = String(request.turnId || "").trim();
  if (!turnId) return { status: "ignored", reason: "missing_turn_id" };
  const scheduled = agentRequests.recordTargetTurnEnded(request.sessionId, request.cwd, turnId);
  for (const item of scheduled) scheduleAgentRequestReminder(item);
  if (!scheduled.length) {
    return { status: "ignored", reason: "no_unanswered_agent_requests", turnId };
  }
  publishManagerEvent("agent_requests_changed", {
    requestIds: scheduled.map((item) => item.id),
    status: "awaiting_response",
    nextReminderAt: scheduled[0]?.nextReminderAt
  });
  return {
    status: "scheduled",
    reason: "target_turn_ended_without_response",
    requestIds: scheduled.map((item) => item.id),
    turnId
  };
}

function agentRequestReminderPrompt(request: AgentRequestRecord): string {
  const sourceWorkspace = request.source.workspace || "<原请求任务工作目录>";
  return [
    "[Rabi Agent 请求回复提醒]",
    `requestId：${request.id}`,
    `原请求任务：${request.source.threadName || request.source.threadId}`,
    `原请求任务 ID：${request.source.threadId}`,
    `需要回答：${request.responseInstruction}`,
    "上一轮迭代结束时没有检测到通过 RabiRoute 接口提交的正式回复。普通 Codex 最终文字不算回复。",
    "请完成判断后调用 POST /api/agent/threads，并填写：",
    `action=send、threadId=${request.source.threadId}、cwd=${sourceWorkspace}、messageSource={type=agent，agentAdapter=当前 Agent 端，sessionId=当前任务完整 ID，sessionName=当前任务名称}、sourceThreadId=当前任务完整 ID、sourceAgentType=当前 Agent 类型、inReplyToRequestId=${request.id}、result=结果或决定、nextAction=下一步、responsePolicy=required 或 none、prompt=重新编写的回复内容。`,
    "如果下一步仍要求原请求方处理完再返回，填写 responsePolicy=required 和 responseInstruction；如果本次回复结束往返，填写 responsePolicy=none。"
  ].join("\n");
}

function scheduleAgentRequestReminder(request: AgentRequestRecord): void {
  messageProcessingAutomationService?.schedule(request);
}

async function deliverAgentRequestReminder(request: AgentRequestRecord): Promise<void> {
  const requestId = request.id;
  const messageProcessingTarget = currentMessageProcessingTargetByThreadId(request.target.threadId)
    ?? ((request.target.agentType === "message_processing" || request.target.agentType === "primary_persona")
      && request.target.threadName
      && request.target.workspace
      ? {
          agentType: request.target.agentType,
          worker: {
            threadId: request.target.threadId,
            threadName: request.target.threadName,
            workspace: request.target.workspace
          }
        } as MessageProcessingDeliveryTarget
      : undefined);
  const target = messageProcessingTarget?.worker ?? request.target;
  const reminderRequest: AgentThreadRequest = {
    action: "send",
    agentAdapter: target.agentAdapter ?? (isDshSessionId(target.threadId) ? "dsh" : "codex"),
    threadId: target.threadId,
    ...(target.threadName ? { title: target.threadName, createIfMissing: true } : {}),
    cwd: target.workspace,
    messageSource: {
      type: "system",
      eventType: "agent_request_reminder",
      eventName: "Agent 回复提醒",
      eventId: request.id
    },
    prompt: agentRequestReminderPrompt(request)
  };
  const result = await handleAgentThreadRequest(
    reminderRequest,
    agentThreadRequestOptions(reminderRequest, { agentRequests })
  );
  if (result.data.status !== "delivered") {
    throw new Error(String(result.data.warning || result.data.message || "Agent request reminder was not accepted."));
  }
  if (messageProcessingTarget) {
    await persistResolvedMessageProcessingTarget(
      messageProcessingTarget,
      result.data,
      runtimeForMessageProcessingTarget(messageProcessingTarget)
    );
  } else {
    persistResolvedAgentRequestTarget(target, result.data);
  }
  const updated = agentRequests.recordReminderResult(requestId, true);
  publishManagerEvent("agent_requests_changed", {
    requestId,
    status: updated.status,
    reminderCount: updated.reminderCount,
    lastReminderAt: updated.lastReminderAt
  });
}

function recordAgentRequestReminderFailure(request: AgentRequestRecord, error: unknown): void {
  const updated = agentRequests.recordReminderResult(request.id, false, error);
  managerOperationalLog.record("warn", "agent_request_reminder_failed", {
    result: "failed",
    requestId: request.id,
    error: managerOperationalError(error, rootDir)
  });
  publishManagerEvent("agent_requests_changed", {
    requestId: request.id,
    status: updated.status,
    reminderCount: updated.reminderCount,
    lastReminderError: updated.lastReminderError,
    nextReminderAt: updated.nextReminderAt
  });
}

function refreshAgentRequestReminderTimers(): void {
  messageProcessingAutomationService?.refresh();
}

function agentThreadAllowedWorkspaces(): string[] {
  let desktopWorkspaces: string[] = [];
  try {
    desktopWorkspaces = listCodexDesktopThreads({ limit: 10_000 })
      .map((thread) => thread.cwd?.trim())
      .filter((value): value is string => Boolean(value));
  } catch {
    // Keep configured workspaces available when Desktop state is temporarily unreadable.
  }
  return [...new Set([
    rootDir,
    ...desktopWorkspaces,
    ...[...runtimes.values()].flatMap((runtime) => [
      runtime.definition.codexCwd?.trim(),
      runtime.definition.dshCwd?.trim(),
      ...(runtime.definition.codexPlanAssistantSessions ?? []).map((session) => session.workspace?.trim())
    ]).filter((value): value is string => Boolean(value))
      .map((value) => path.resolve(rootDir, value))
  ])];
}

const speechModelManager = new SpeechModelManager({
  packageRoot,
  rootDir,
  onChange: snapshot => publishManagerEvent("speech_model_management_changed", {
    activeJob: snapshot.activeJob,
    lastJob: snapshot.lastJob
  })
});

function applyManagedAgentThreadDefaults(request: AgentThreadRequest): AgentThreadRequest {
  if (request.action !== "send") return request;
  const model = resolveCodexPlanAssistantTurnModel(
    [...runtimes.values()].flatMap((runtime) => runtime.definition.codexPlanAssistantEnabled === true
      ? (runtime.definition.codexPlanAssistantSessions ?? []).map((session) => ({
          ...session,
          model: normalizeCodexPlanAssistantModel(runtime.definition.codexPlanAssistantModel)
        }))
      : []),
    request.threadId,
    request.model
  );
  return model && !request.model?.trim() ? { ...request, model } : request;
}

function messageProcessingRequirementIdFromSend(request: AgentSendRequest): string | undefined {
  const tracking = request.tracking && typeof request.tracking === "object" && !Array.isArray(request.tracking)
    ? request.tracking as Record<string, unknown>
    : undefined;
  const value = String(tracking?.requirementId || "").trim();
  return value || undefined;
}

function recordMessageProcessingSend(request: AgentSendRequest, result: AgentSendResult): void {
  const requirementId = messageProcessingRequirementIdFromSend(request);
  if (!requirementId) return;
  try {
    const requirement = messageProcessingBoard.recordSend(requirementId, result, String(request.deliveryId || "").trim() || undefined);
    publishManagerEvent("message_processing_board_changed", { requirementId, status: result.status });
    if (requirement.status === "awaiting_send" && result.status === "sent") {
      managerOperationalLog.record("warn", "message_processing_send_channel_mismatch", {
        action: requirementId,
        result: `${result.status}:${result.channel || "unknown"}->${requirement.source.endpoint}`,
        error: requirement.lastError ? { name: "SendChannelMismatch", message: requirement.lastError } : undefined
      });
    }
  } catch (error) {
    managerOperationalLog.record("warn", "message_processing_send_board_update_failed", {
      action: requirementId,
      result: result.status,
      error: managerOperationalError(error, rootDir)
    });
  }
}

async function performAgentSend(request: AgentSendRequest): Promise<AgentCommunicationHttpResponse> {
  const receiptBeforeValidation = readAgentSendReceipt(rootDir, String(request.deliveryId || ""));
  const prepared = prepareAgentSendRequest(request);
  if (!receiptBeforeValidation) {
    assertAgentSendPermission(prepared.sender, runtimeForAgentSendRoute(prepared.routeId)?.definition);
  }
  const validatedSendContext = !receiptBeforeValidation
    ? messageProcessingSendContextReview.validateSend(request)
    : undefined;
  let reviewedReplySource: ReviewedReplySourceEvidence | undefined;
  if (validatedSendContext?.sourceMessageId
    && prepared.channel === "napcat"
    && prepared.target.target === "group") {
    const roleId = String(validatedSendContext.requirement.source.roleId || "").trim();
    if (!roleId) {
      throw new Error(`Cannot recover reviewed source ${validatedSendContext.sourceMessageId}: requirement has no roleId.`);
    }
    const recovered = recoverReviewedMessageProcessingSourceRecord(
      roleDirForApi(roleId),
      validatedSendContext.requirement,
      validatedSendContext.sourceMessageId,
      {
        expectedGroupId: String(prepared.target.groupId || ""),
        expectedInstanceId: String(prepared.target.instanceId || "")
      }
    );
    reviewedReplySource = {
      routeId: recovered.routeId,
      sourceMessageId: recovered.sourceMessageId,
      groupId: recovered.groupId,
      instanceId: recovered.instanceId,
      record: recovered.record,
      dataDirs: [recovered.roleDir],
      reviewedAttachmentIds: recovered.reviewedAttachmentIds
    };
  }

  const replyOptions = {
    rootDir,
    routeRoot,
    rolesRoot,
    speechServiceUrl: speechServiceUrl(),
    publishEvent: publishManagerEvent,
    planStorageReady: () => planStorageStartupStatus().state === "ready",
    appendRolePanelTimeline,
    submitPlanFeedback: submitAgentPlanFeedback,
    runtimes: [...runtimes.values()].map(runtime => {
      const relay = rabiLinkRelayConfigFor(runtime.definition);
      return {
        ...runtime.definition,
        rabiLinkRelay: relay,
        napcatInstances: (runtime.definition.napcatInstances ?? sharedNormalizeNapCatInstances(runtime.definition)).map(instance => ({
          ...instance,
          accessToken: instance.accessToken ?? ""
        }))
      };
    })
  };
  if (!receiptBeforeValidation) {
    validateAgentSendReplyImageDescriptions(request, replyOptions, reviewedReplySource);
  }

  const existingReceipt = readAgentSendReceipt(rootDir, String(request.deliveryId || ""));
  let languageStyleValidation: AgentSendResult["languageStyleValidation"];
  if (!existingReceipt) {
    const styleDecision = await evaluateAgentSendLanguageStyle(request, replyOptions, languageStyleValidator);
    languageStyleValidation = styleDecision.metadata;
    if (styleDecision.blocked) {
      return {
        statusCode: 409,
        body: {
          ok: false,
          status: "style_confirmation_required",
          reason: "Language style validation failed. Review the reasons, then resend the same deliveryId with styleValidation=0 only after confirming the text is intentional.",
          deliveryId: prepared.deliveryId,
          sender: prepared.sender,
          channel: prepared.channel,
          routeId: prepared.routeId,
          target: prepared.target,
          languageStyleValidation
        }
      };
    }
  }

  const deliver = async () => ({
    ...await handleAgentSend(request, replyOptions, reviewedReplySource),
    ...(languageStyleValidation ? { languageStyleValidation } : {})
  });
  const result = await executeIdempotentAgentSend(request, {
    rootDir,
    deliver,
    recover: async () => {
      const inspection = await inspectAgentSendDelivery(request, replyOptions);
      if (inspection.state === "completed") return inspection;
      if (inspection.state === "missing") return { state: "retry" };
      return { state: "uncertain", reason: inspection.reason };
    }
  });
  if (result.body.replyImageDescriptionArchive && result.body.idempotency.duplicate === false) {
    managerOperationalLog.record("info", "agent_reply_image_descriptions_archived", {
      action: String(request.deliveryId || ""),
      result: `sourceMessageId=${result.body.replyImageDescriptionArchive.sourceMessageId}; files=${result.body.replyImageDescriptionArchive.files.length}`
    });
  }
  recordMessageProcessingSend(request, result.body);
  return result;
}


async function dispatchPlanNotificationRequirement(requirement: MessageProcessingRequirement): Promise<void> {
  if (requirement.kind !== "plan_progress_notification") return;
  const target = currentMessageProcessingTarget(requirement);
  const worker = target?.worker;
  if (!target || !worker?.threadId || !worker.workspace) {
    messageProcessingBoard.recordDispatchFailure(requirement.id, "当前 Route 没有可用的主人格或消息处理 Agent 任务；等待配置恢复或人工重新分配。");
    publishManagerEvent("message_processing_board_changed", { requirementId: requirement.id, status: "send_failed" });
    return;
  }
  const runtime = runtimeForMessageProcessingRequirement(requirement);
  if (!runtime) {
    messageProcessingBoard.recordDispatchFailure(requirement.id, "当前 Route 运行实例不可用，未投递计划进展通知。");
    publishManagerEvent("message_processing_board_changed", { requirementId: requirement.id, status: "send_failed" });
    return;
  }
  const messageSource = planMessageSource(
    requirement.plan?.planId,
    requirement.plan?.planTitle
  );
  const outcomeUrl = `http://127.0.0.1:${managerPort}/api/message-processing/requirements/${encodeURIComponent(requirement.id)}/outcome`;
  const sendContextUrl = `http://127.0.0.1:${managerPort}/api/message-processing/requirements/${encodeURIComponent(requirement.id)}/send-context`;
  const sendApiUrl = `http://127.0.0.1:${managerPort}/api/agent/send`;
  const sendRequestTemplate = agentSendRequestTemplateForSource({
    ...(requirement.source.replyContext || {}),
    routeProfileId: requirement.source.routeProfileId || requirement.source.routeId,
    messageProcessingRequirementId: requirement.id
  });
  const prompt = [
    "[计划进展通知需求]",
    `消息处理需求 ID：${requirement.id}`,
    `计划：${requirement.plan?.planTitle || requirement.plan?.planId}`,
    `计划 ID：${requirement.plan?.planId}`,
    `原消息端：${requirement.source.endpoint}`,
    `原会话：${requirement.source.conversationKey}`,
    `原说话人：${requirement.source.sender}`,
    `原消息编号：${requirement.source.messageIds.join(", ") || "无"}`,
    "本次变化：",
    ...(requirement.plan?.changes || []).map((change) => `- ${change}`),
    "",
    "RabiManager 已自动生成一项必须发送的计划进展通知。请结合计划当前内容整理简短、可理解的进展，不要把内部 taskBinding、路径或控制面字段原样发给群成员。",
    `先 POST ${outcomeUrl} 提交 decision=reply，再 GET ${sendContextUrl}?sourceMessageId=<本次拟引用的原消息ID> 读取精确来源和最新双向消息。确认没有他人已经通知、没有新消息改变结论后，POST ${sendContextUrl} 审核确切 proposedSend，并把返回 token 写入 tracking.sendContextReviewToken。`,
    `最后使用 POST ${sendApiUrl}，明确填写 routeId、channel、params、payload、deliveryId，并在 tracking.requirementId 填 ${requirement.id}。不要把来源 replyContext 原样当发送参数。`,
    `发送请求模板：${JSON.stringify(sendRequestTemplate || { error: "当前来源无法生成明确发送目标，请提交 invalid_source，不要猜测。" })}`,
    `当前 replyContext：${JSON.stringify(requirement.source.replyContext || {})}`,
    `如果来源已经失效或同一进展已由别人完整通知，POST ${outcomeUrl} 提交 decision=no_reply 和受支持的原因；其它情况不能静默关闭。`,
    "普通问题和讨论仍由你判断是否参与；这条计划进展通知本身不是可选讨论。"
  ].join("\n");
  try {
    const result = await handleAgentThreadRequest({
      action: "send",
      agentAdapter: worker.agentAdapter ?? (isDshSessionId(worker.threadId) ? "dsh" : "codex"),
      threadId: worker.threadId,
      title: worker.threadName,
      createIfMissing: true,
      cwd: worker.workspace,
      sandbox: "workspace-write",
      messageSource,
      prompt
    }, {
      allowedWorkspaces: agentThreadAllowedWorkspaces(),
      defaultWorkspace: rootDir,
      dshBaseUrl: runtime.definition.dshBaseUrl
    });
    if (result.data.status !== "delivered") {
      throw new Error(String(result.data.warning || result.data.message || "Plan notification was not accepted."));
    }
    const resolved = await persistResolvedMessageProcessingTarget(
      target,
      result.data,
      runtime
    );
    messageProcessingBoard.recordDispatch(requirement.id, resolved.worker);
    publishManagerEvent("message_processing_board_changed", { requirementId: requirement.id, status: "processing" });
  } catch (error) {
    messageProcessingBoard.recordDispatchFailure(requirement.id, error);
    publishManagerEvent("message_processing_board_changed", { requirementId: requirement.id, status: "send_failed" });
  }
}

function runtimeForMessageProcessingRequirement(requirement: MessageProcessingRequirement): GatewayRuntime | undefined {
  const routeIds = [requirement.source.routeId, requirement.source.routeProfileId].filter(Boolean);
  for (const routeId of routeIds) {
    const exact = runtimes.get(String(routeId));
    if (exact) return exact;
  }
  return [...runtimes.values()].find((runtime) =>
    routeIds.some((routeId) => (runtime.definition.routeProfiles ?? []).some((profile) => profile.id === routeId))
  );
}

function currentMessageProcessingWorker(requirement: MessageProcessingRequirement): MessageProcessingRequirement["worker"] {
  return currentMessageProcessingTarget(requirement)?.worker;
}

function currentMessageProcessingTarget(requirement: MessageProcessingRequirement): MessageProcessingDeliveryTarget | undefined {
  const runtime = runtimeForMessageProcessingRequirement(requirement);
  if (!runtime) {
    return requirement.worker
      ? { agentType: "message_processing", worker: requirement.worker }
      : undefined;
  }
  const managedAdapter = primaryMessageProcessingAgentAdapter(runtime.definition);
  const maxAgents = managedAdapter ? runtime.definition.messageProcessingAgents?.[managedAdapter]?.maxAgents : undefined;
  const messageAgentModeEnabled = Boolean(managedAdapter);
  const managedWorker = messageAgentModeEnabled
    ? resolveCurrentMessageAgentWorker(
      messageAgentPoolStatePath(dataDirFor(runtime.definition)),
      requirement.worker,
      maxAgents,
      {
        groupId: requirement.messageGroupId || requirement.id,
        endpoint: requirement.source.endpoint,
        conversationKey: requirement.source.conversationKey,
        sender: requirement.source.sender
      },
      {},
      primaryAgentWorkspace(runtime.definition)
    )
    : undefined;
  return resolveMessageProcessingDeliveryTarget(runtime.definition, managedWorker);
}

function runtimeForMessageProcessingTarget(target: MessageProcessingDeliveryTarget): GatewayRuntime | undefined {
  if (target.agentType === "primary_persona") {
    return [...runtimes.values()].find((runtime) =>
      (String(runtime.definition.codexThreadId || "").trim() === target.worker.threadId
        && String(runtime.definition.codexCwd || "").trim() === target.worker.workspace)
      || (String(runtime.definition.dshSessionId || "").trim() === target.worker.threadId
        && String(runtime.definition.dshCwd || "").trim() === target.worker.workspace)
    );
  }
  return [...runtimes.values()].find((runtime) => {
    const adapter = primaryMessageProcessingAgentAdapter(runtime.definition);
    return readCurrentMessageAgentWorkers(
      messageAgentPoolStatePath(dataDirFor(runtime.definition)),
      adapter ? runtime.definition.messageProcessingAgents?.[adapter]?.maxAgents : undefined,
      primaryAgentWorkspace(runtime.definition)
    ).some((worker) => worker.threadId === target.worker.threadId && worker.agentAdapter === target.worker.agentAdapter);
  });
}

function replaceOpenAgentRequestParties(
  previousThreadId: string,
  previousWorkspace: string | undefined,
  worker: NonNullable<MessageProcessingRequirement["worker"]>
): void {
  const result = agentRequests.reconcileOpenParties((party) => party.threadId === previousThreadId
    && (!previousWorkspace || !party.workspace || sameCodexWorkspace(party.workspace, previousWorkspace))
    ? {
        ...party,
        threadId: worker.threadId,
        threadName: worker.threadName,
        workspace: worker.workspace
      }
    : undefined);
  if (!result.reassigned.length && !result.cancelled.length) return;
  publishManagerEvent("agent_requests_changed", {
    status: "archived_task_binding_replaced",
    previousThreadId,
    threadId: worker.threadId,
    reassignedRequestIds: result.reassigned.map((request) => request.id),
    cancelledRequestIds: result.cancelled.map((request) => request.id)
  });
}

function persistResolvedAgentRequestTarget(
  target: { threadId: string; threadName?: string; workspace?: string },
  result: Record<string, unknown>
): void {
  const previousThreadId = String(result.previousThreadId || "").trim();
  const thread = result.thread && typeof result.thread === "object"
    ? result.thread as { id?: unknown; title?: unknown; cwd?: unknown }
    : undefined;
  const threadId = String(thread?.id || result.threadId || "").trim();
  if (!previousThreadId || previousThreadId !== target.threadId || !threadId || threadId === previousThreadId) return;
  replaceOpenAgentRequestParties(previousThreadId, target.workspace, {
    threadId,
    threadName: String(thread?.title || target.threadName || threadId),
    workspace: String(thread?.cwd || target.workspace || rootDir)
  });
}

async function persistResolvedMessageProcessingTarget(
  target: MessageProcessingDeliveryTarget,
  result: Record<string, unknown>,
  runtime: GatewayRuntime | undefined
): Promise<MessageProcessingDeliveryTarget> {
  const resolved = resolveDeliveredMessageProcessingTarget(target, result);
  if (!resolved.previousThreadId) return resolved.target;
  if (!runtime) {
    throw new Error(`Cannot persist replacement for archived ${target.agentType} task ${resolved.previousThreadId}.`);
  }
  const replacement = resolved.target.worker;
  const primaryWorkspace = primaryAgentWorkspace(runtime.definition);
  if (!sameCodexWorkspace(replacement.workspace, primaryWorkspace)) {
    throw new Error(`Archived ${target.agentType} task replacement returned a workspace different from the Primary Persona.`);
  }
  if (target.agentType === "primary_persona") {
    const primaryAdapter = target.worker.agentAdapter ?? (target.worker.threadId.startsWith("session-") ? "dsh" : "codex");
    const configuredThreadId = String(primaryAgentSessionId(runtime.definition) || "").trim();
    if (configuredThreadId !== resolved.previousThreadId && configuredThreadId !== replacement.threadId) {
      throw new Error(`Primary Persona binding changed before archived task replacement could be saved: ${configuredThreadId}`);
    }
    if (configuredThreadId !== replacement.threadId) {
      if (primaryAdapter === "dsh") {
        runtime.definition.dshSessionId = replacement.threadId;
        runtime.definition.dshSessionName = replacement.threadName;
        runtime.definition.dshCwd = replacement.workspace;
      } else {
        runtime.definition.codexThreadId = replacement.threadId;
        runtime.definition.codexThreadName = replacement.threadName;
        runtime.definition.codexCwd = replacement.workspace;
      }
      await writeAdapterConfigFile(runtime.definition);
    }
  } else {
    const statePath = messageAgentPoolStatePath(dataDirFor(runtime.definition));
    const replaced = replacePersistedMessageAgentWorker(
      statePath,
      resolved.previousThreadId,
      replacement
    );
    const alreadyPersisted = !replaced && readCurrentMessageAgentWorkers(
      statePath,
      primaryMessageProcessingAgentAdapter(runtime.definition)
        ? runtime.definition.messageProcessingAgents?.[primaryMessageProcessingAgentAdapter(runtime.definition)!]?.maxAgents
        : undefined,
      primaryAgentWorkspace(runtime.definition)
    ).some((worker) => worker.threadId === replacement.threadId);
    if (!replaced && !alreadyPersisted) {
      throw new Error(`Message Agent replacement could not be saved: ${resolved.previousThreadId}`);
    }
  }
  messageProcessingBoard.replaceWorkerReferences(resolved.previousThreadId, replacement);
  replaceOpenAgentRequestParties(resolved.previousThreadId, target.worker.workspace, replacement);
  reconcileMessageProcessingAgentRequests();
  publishManagerEvent("codex_binding_replaced", {
    gatewayId: runtime.definition.id,
    agentType: target.agentType,
    previousThreadId: resolved.previousThreadId,
    threadId: replacement.threadId,
    workspace: replacement.workspace
  });
  return resolved.target;
}

function currentMessageProcessingTargetByThreadId(threadId: string): MessageProcessingDeliveryTarget | undefined {
  const historicalTargets = messageProcessingBoard.snapshot().requirements
    .filter((requirement) => requirement.worker?.threadId === threadId)
    .flatMap((requirement) => {
      const target = currentMessageProcessingTarget(requirement);
      return target ? [target] : [];
    });
  const uniqueHistoricalTargets = [...new Map(historicalTargets.map((target) => [
    `${target.agentType}\n${target.worker.threadId}\n${target.worker.workspace}`,
    target
  ])).values()];
  if (uniqueHistoricalTargets.length === 1) return uniqueHistoricalTargets[0];
  if (uniqueHistoricalTargets.length > 1) return undefined;
  const candidates = [...runtimes.values()].flatMap((runtime) => {
    const managedAdapter = primaryMessageProcessingAgentAdapter(runtime.definition);
    const modeEnabled = Boolean(managedAdapter);
    const workers = readCurrentMessageAgentWorkers(
      messageAgentPoolStatePath(dataDirFor(runtime.definition)),
      managedAdapter ? runtime.definition.messageProcessingAgents?.[managedAdapter]?.maxAgents : undefined,
      primaryAgentWorkspace(runtime.definition)
    );
    const matchingWorker = workers.find((worker) => worker.threadId === threadId);
    if (!matchingWorker) return [];
    const target = resolveMessageProcessingDeliveryTarget(
      runtime.definition,
      modeEnabled
        ? {
            threadId: matchingWorker.threadId,
            threadName: matchingWorker.threadName,
            workspace: matchingWorker.workspace
          }
        : undefined
    );
    return target ? [target] : [];
  });
  const unique = [...new Map(candidates.map((target) => [
    `${target.agentType}\n${target.worker.threadId}\n${target.worker.workspace}`,
    target
  ])).values()];
  return unique.length === 1 ? unique[0] : undefined;
}

function reconcileMessageProcessingAgentRequests(): void {
  const knownMessageWorkers = new Set(messageProcessingBoard.snapshot().requirements
    .flatMap((requirement) => requirement.worker?.threadId ? [requirement.worker.threadId] : []));
  const result = agentRequests.reconcileOpenParties((party, record) => {
    const isMessageProcessingParty = party.agentType === "message_processing" || knownMessageWorkers.has(party.threadId);
    if (!isMessageProcessingParty) return undefined;
    const requirement = record.messageProcessingRequirementId
      ? messageProcessingBoard.getRequirement(record.messageProcessingRequirementId)
      : undefined;
    const target = requirement
      ? currentMessageProcessingTarget(requirement)
      : currentMessageProcessingTargetByThreadId(party.threadId);
    if (!target) return null;
    const worker = target.worker;
    const agentType = target.agentType;
    if (worker.threadId === party.threadId && agentType === party.agentType) return undefined;
    return {
      threadId: worker.threadId,
      threadName: worker.threadName,
      workspace: worker.workspace,
      agentType
    };
  });
  if (!result.reassigned.length && !result.cancelled.length) return;
  managerOperationalLog.record("info", "message_agent_request_bindings_reconciled", {
    result: `reassigned=${result.reassigned.length};cancelled=${result.cancelled.length}`,
    action: [...result.reassigned, ...result.cancelled].map((request) => request.id).join(",")
  });
  publishManagerEvent("agent_requests_changed", {
    status: "message_agent_bindings_reconciled",
    reassignedRequestIds: result.reassigned.map((request) => request.id),
    cancelledRequestIds: result.cancelled.map((request) => request.id)
  });
}

export function buildKnowledgeCallbackReminderPrompt(
  requirement: MessageProcessingRequirement,
  pending: KnowledgeRecallMatch[],
  port = managerPort
): string {
  const base = `http://127.0.0.1:${port}/api/message-processing/requirements/${encodeURIComponent(requirement.id)}`;
  return [
    "[计划与记忆命中回调提醒]",
    `消息处理需求 ID：${requirement.id}`,
    `原消息 ID：${requirement.source.messageIds.join(", ") || "无"}`,
    `原消息摘要：${requirement.source.summary || "无"}`,
    "RabiManager 在投递消息后一小时仍未收到以下计划或记忆的最终回调：",
    ...pending.map((item) => `- ${item.type} ${item.id}：${item.title}（GET ${item.endpoint}）`),
    "请逐项读取并处理，然后 POST 对应 knowledge-callback。即使没有变化，也必须回调 result=unchanged 并说明核对依据。",
    "需要更新时先调用计划或记忆 PATCH/POST 接口，再回调 result=updated/created、recordType、recordId、verifiedAt，并确保记录包含原消息 ID。误命中使用 not_relevant；尚需别人处理使用 deferred，并继续跟进。",
    `需求详情：GET ${base}`,
    `回调接口：POST ${base}/knowledge-callback`,
    "群内需要确认或讨论时仍要实际发送并取得 Outbox 回执；不要只完成内部回调。"
  ].join("\n");
}

function scheduleKnowledgeCallbackReminder(requirement: MessageProcessingRequirement): void {
  const service = knowledgeCallbackReminderService;
  if (!service) return;
  void service.schedule(requirement).catch(error => {
    managerOperationalLog.record("warn", "knowledge_callback_reminder_schedule_failed", {
      action: requirement.id,
      error: managerOperationalError(error, rootDir)
    });
  });
}

async function deliverKnowledgeCallbackReminder(requirement: MessageProcessingRequirement): Promise<void> {
  const pending = messageProcessingBoard.pendingKnowledgeMatches(requirement.id);
  if (!pending.length) return;
  const target = currentMessageProcessingTarget(requirement);
  const worker = target?.worker;
  if (!target || !worker?.threadId || !worker.workspace) {
    throw new Error("Knowledge callback reminder has no active Agent target.");
  }
  const runtime = runtimeForMessageProcessingRequirement(requirement);
  if (!runtime) {
    throw new Error("Knowledge callback reminder has no active Route runtime.");
  }
  const messageSource: RabiMessageSource = {
    type: "system",
    eventType: "knowledge_callback_reminder",
    eventName: "知识回调提醒",
    eventId: requirement.id,
    routeName: runtime.definition.name,
    routeId: runtime.definition.id
  };
  const prompt = buildKnowledgeCallbackReminderPrompt(requirement, pending);
  const result = await handleAgentThreadRequest({
    action: "send",
    agentAdapter: worker.agentAdapter ?? (isDshSessionId(worker.threadId) ? "dsh" : "codex"),
    threadId: worker.threadId,
    title: worker.threadName,
    createIfMissing: true,
    cwd: worker.workspace,
    prompt,
    sandbox: "workspace-write",
    messageSource
  }, {
    allowedWorkspaces: agentThreadAllowedWorkspaces(),
    defaultWorkspace: rootDir,
    dshBaseUrl: runtime.definition.dshBaseUrl
  });
  if (result.data.status !== "delivered") {
    throw new Error(String(result.data.warning || result.data.message || "Knowledge callback reminder was not accepted."));
  }
  const resolved = await persistResolvedMessageProcessingTarget(
    target,
    result.data,
    runtime
  );
  messageProcessingBoard.recordWorkerReference(requirement.id, resolved.worker);
  const warning = typeof result.data.warning === "string" ? result.data.warning.trim() : "";
  if (warning) {
    managerOperationalLog.record("warn", "knowledge_callback_reminder_target_replaced", {
      action: `${requirement.id}:${worker.threadId}->${resolved.worker.threadId}`,
      result: warning
    });
  }
}

async function messageProcessingBoardPayload(routeId?: string, limit?: number): Promise<Record<string, unknown>> {
  if (managerReadOnly) return measureSyncPerformanceOperation(
    PERFORMANCE_OPERATIONS.managerMessageBoardSummary,
    () => messageProcessingBoard.boardSummary({ routeId, limit })
  );
  const openStatuses = new Set(["pending_dispatch", "processing", "handed_off", "awaiting_send", "awaiting_approval", "fact_record_pending", "send_failed"]);
  const boardSnapshot = measureSyncPerformanceOperation(
    PERFORMANCE_OPERATIONS.managerMessageBoardSummary,
    () => messageProcessingBoard.boardSummary({ routeId, limit })
  ) as { items?: MessageProcessingRequirement[] };
  const displayItems = (boardSnapshot.items ?? []).map((item) => {
    if (!openStatuses.has(item.status)) return item;
    const worker = currentMessageProcessingWorker(item);
    return worker ? { ...item, worker } : item;
  });
  const candidates = displayItems.filter((item) => item.worker && openStatuses.has(item.status));
  const byThread = new Map<string, MessageProcessingRequirement[]>();
  const workerRuntime = new Map<string, MessageProcessingWorkerRuntimeObservation>();
  for (const item of candidates) {
    const threadId = item.worker!.threadId;
    const current = byThread.get(threadId) || [];
    current.push(item);
    byThread.set(threadId, current);
  }
  await Promise.all([...byThread.entries()].map(async ([threadId, items]) => {
    try {
      const result = await handleAgentThreadRequest({ action: "read", threadId }, {
        allowedWorkspaces: agentThreadAllowedWorkspaces(),
        defaultWorkspace: rootDir
      });
      const thread = result.data.thread as Record<string, unknown> | undefined;
      const rawStatus = String((thread?.status as Record<string, unknown> | undefined)?.type || "").trim();
      const status: MessageProcessingWorkerRuntimeStatus = new Set(["active", "idle", "notLoaded", "unavailable"]).has(rawStatus)
        ? rawStatus as MessageProcessingWorkerRuntimeStatus
        : thread?.active === true
          ? "active"
          : thread?.active === false
            ? "idle"
            : "unavailable";
      workerRuntime.set(threadId, {
        threadName: String(thread?.title || "").trim() || undefined,
        workspace: String(thread?.cwd || "").trim() || undefined,
        status,
        observedAt: new Date().toISOString()
      });
    } catch {
      workerRuntime.set(threadId, { status: "unavailable", observedAt: new Date().toISOString() });
    }
  }));
  const enriched = measureSyncPerformanceOperation(
    PERFORMANCE_OPERATIONS.managerMessageBoardSummary,
    () => messageProcessingBoard.boardSummary({ routeId, limit }, workerRuntime)
  ) as Record<string, unknown> & {
    items?: MessageProcessingRequirement[];
  };
  enriched.items = (enriched.items ?? []).map((item) => {
    if (!openStatuses.has(item.status)) return item;
    const worker = currentMessageProcessingWorker(item);
    const runtime = worker ? workerRuntime.get(worker.threadId) : undefined;
    return worker
      ? {
          ...item,
          worker: {
            ...worker,
            ...(runtime?.threadName ? { threadName: runtime.threadName } : {}),
            ...(runtime?.workspace ? { workspace: runtime.workspace } : {}),
            ...(runtime ? {
              runtimeStatus: runtime.status,
              active: runtime.status === "active" ? true : runtime.status === "idle" ? false : undefined,
              observedAt: runtime.observedAt
            } : {})
          }
        }
      : item;
  });
  return enriched;
}

function setMessageProcessingPlanBaseline(item: MessageProcessingRequirement, roleIdInput?: string, planIdInput?: string): void {
  const roleId = String(roleIdInput || item.source.roleId || "").trim();
  const planId = String(planIdInput || item.plan?.planId || "").trim();
  if (!roleId || !planId) return;
  try {
    const roleDir = roleDirForApi(roleId);
    const plan = getPublishedPlan(roleDir, planId);
    if (plan) messageProcessingBoard.setPlanBaseline(roleId, plan);
    else requestRoleKnowledgeCatalogRefresh(roleDir);
  } catch {
    // The linked requirement remains visible; the next plan update can establish the baseline.
  }
}

async function handleMessageProcessingPlanUpdate(roleDir: string, plan: PlanItem | null): Promise<void> {
  if (!plan) return;
  const normalizedRoleDir = path.resolve(roleDir);
  for (const origin of messageProcessingBoard.planOriginList()) {
    if (origin.planId !== plan.id) continue;
    if (path.resolve(roleDirForApi(origin.roleId)) !== normalizedRoleDir) continue;
    const requirement = messageProcessingBoard.reconcilePlan(origin.key, plan);
    if (!requirement) continue;
    publishManagerEvent("message_processing_board_changed", { requirementId: requirement.id, status: requirement.status });
    await dispatchPlanNotificationRequirement(requirement);
  }
}

async function sendPlanFeedbackToTask(
  roleId: string,
  planId: string,
  dshBaseUrl: string | undefined,
  request: PlanQaTaskRequest | PlanApprovalFeedbackTaskRequest,
  deliveryId = "deliveryId" in request ? request.deliveryId : undefined
): Promise<void> {
  const projection = await currentRoleStorageApplication().queries.plan(roleId, planId, { timeoutMs: 30_000 });
  const plan = projection?.plan;
  if (!plan) {
    throw new Error(`Role plan catalog is unavailable or plan was not found: ${planId}`);
  }
  const result = await handleAgentThreadRequest({
    action: "send",
    agentAdapter: request.agentAdapter,
    threadId: request.threadId,
    title: request.title,
    createIfMissing: request.createIfMissing,
    cwd: request.cwd,
    deliveryId,
    messageSource: planMessageSource(
      planId,
      plan.title
    ),
    prompt: request.prompt,
    sandbox: "workspace-write"
  }, {
    allowedWorkspaces: agentThreadAllowedWorkspaces(),
    defaultWorkspace: rootDir,
    dshBaseUrl
  });
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw new Error(String(result.data.message || "Plan task continuation failed with HTTP " + result.statusCode + "."));
  }
  const thread = result.data.thread as { id?: unknown; title?: unknown; cwd?: unknown } | undefined;
  const resolvedId = String(thread?.id || "").trim();
  if (!resolvedId || resolvedId === request.threadId) return;
  const resolved = {
    id: resolvedId,
    title: typeof thread?.title === "string" ? thread.title : undefined,
    cwd: typeof thread?.cwd === "string" ? thread.cwd : undefined
  };
  await replacePlanTaskBindingForDelivery(currentRoleStorageApplication(), {
    roleId,
    planId,
    deliveryId: String(deliveryId || "").trim(),
    oldSessionId: request.threadId,
    resolved
  });
  const warning = typeof result.data.warning === "string" ? result.data.warning.trim() : "";
  if (warning) {
    managerOperationalLog.record("warn", "plan_task_binding_replaced", {
      action: `${planId}:${request.threadId}->${resolvedId}`,
      result: warning
    });
  }
}

async function ensurePlanSecretaryTarget(
  runtime: GatewayRuntime,
  roleId: string,
  plan: PlanItem,
  eventId: string
): Promise<{ plan: PlanItem; target?: PlanSecretaryTarget }> {
  if (runtime.definition.codexPlanAssistantEnabled !== true) return { plan };
  const assignment = await ensurePlanSecretaryBindingForEvent(currentRoleStorageApplication(), {
    roleId,
    planId: plan.id,
    eventId,
    sessions: runtime.definition.codexPlanAssistantSessions
  });
  return assignment.target ? {
    plan: assignment.plan,
    target: {
      ...assignment.target,
      model: normalizeCodexPlanAssistantModel(runtime.definition.codexPlanAssistantModel)
    }
  } : { plan: assignment.plan };
}

async function sendPlanFeedbackToSecretary(
  runtime: GatewayRuntime,
  roleId: string,
  plan: PlanItem,
  target: PlanApprovalFeedbackSecretaryTarget,
  request: PlanApprovalFeedbackPersonaRequest,
  eventId: string
): Promise<void> {
  const resolved = await resolvePlanSecretaryDeliveryTarget(runtime, roleId, plan, target, eventId);
  const result = await handleAgentThreadRequest({
    action: "send",
    agentAdapter: resolved.target.agentAdapter,
    threadId: resolved.target.threadId,
    title: resolved.target.threadName,
    createIfMissing: true,
    cwd: resolved.target.workspace,
    messageSource: planMessageSource(
      plan.id,
      plan.title
    ),
    prompt: request.text,
    controlBlocks: resolved.initializationPrompt ? [resolved.initializationPrompt] : undefined,
    model: resolved.target.model,
    sandbox: "workspace-write"
  }, {
    allowedWorkspaces: agentThreadAllowedWorkspaces(),
    defaultWorkspace: rootDir,
    dshBaseUrl: runtime.definition.dshBaseUrl
  });
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw new Error(String(result.data.message || "Plan secretary feedback delivery failed with HTTP " + result.statusCode + "."));
  }
  if (resolved.initializationPrompt) {
    await markPlanSecretaryInitialized(runtime, resolved.target.threadId);
  }
}

async function sendPlanTaskCompletionToSecretary(
  runtime: GatewayRuntime,
  target: PlanSecretaryTarget,
  delivery: PlanTaskCompletionDelivery,
  prompt: string
): Promise<void> {
  const resolved = await resolvePlanSecretaryDeliveryTarget(
    runtime,
    delivery.roleId,
    delivery.plan,
    target,
    `completion:${delivery.sourceSessionId}:${delivery.sourceTurnId}`
  );
  const result = await handleAgentThreadRequest({
    action: "send",
    agentAdapter: resolved.target.agentAdapter,
    threadId: resolved.target.threadId,
    title: resolved.target.threadName,
    createIfMissing: true,
    cwd: resolved.target.workspace,
    prompt,
    controlBlocks: resolved.initializationPrompt ? [resolved.initializationPrompt] : undefined,
    model: resolved.target.model,
    sandbox: "workspace-write",
    messageSource: planMessageSource(
      delivery.plan.id,
      delivery.plan.title,
      agentMessageSourceForSession(
        delivery.sourceSessionId,
        delivery.plan.taskBinding?.sessionTitle,
        delivery.plan.taskBinding?.agentType || "codex",
        "计划执行 Agent",
        delivery.sourceCwd
      )
    ),
    sourceThreadId: delivery.sourceSessionId,
    sourceAgentType: "plan_agent",
    responsePolicy: "required",
    responseInstruction: "消费本次阶段结果后，回复计划状态、已采取的下一步和仍需决定的事项"
  }, {
    allowedWorkspaces: agentThreadAllowedWorkspaces(),
    defaultWorkspace: rootDir,
    dshBaseUrl: runtime.definition.dshBaseUrl,
    agentRequests
  });
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw new Error(String(result.data.message || "Plan task completion delivery to secretary failed with HTTP " + result.statusCode + "."));
  }
  if (resolved.initializationPrompt) {
    await markPlanSecretaryInitialized(runtime, resolved.target.threadId);
  }
}

async function markPlanSecretaryInitialized(runtime: GatewayRuntime, threadId: string): Promise<void> {
  let changed = false;
  runtime.definition.codexPlanAssistantSessions = (runtime.definition.codexPlanAssistantSessions ?? []).map((session) => {
    if (session.threadId !== threadId || session.initializedAt) return session;
    changed = true;
    return { ...session, initializedAt: new Date().toISOString() };
  });
  if (changed) await writeAdapterConfigFile(runtime.definition);
}

async function resolvePlanSecretaryDeliveryTarget(
  runtime: GatewayRuntime,
  roleId: string,
  plan: PlanItem,
  target: PlanSecretaryTarget | PlanApprovalFeedbackSecretaryTarget,
  eventId: string
): Promise<{ target: PlanSecretaryTarget; initializationPrompt?: string }> {
  const targetAgentAdapter = "agentAdapter" in target
    ? target.agentAdapter
    : isDshSessionId(target.threadId) ? "dsh" : "codex";
  const ownerWorkspace = targetAgentAdapter === "dsh" ? runtime.definition.dshCwd : runtime.definition.codexCwd;
  if (!sameCodexWorkspace(target.workspace, ownerWorkspace)) {
    throw new Error("Plan secretary session is outside the Primary Persona workspace.");
  }
  const previousSession = (runtime.definition.codexPlanAssistantSessions ?? [])
    .find((session) => session.threadId === target.threadId);
  const result = await handleAgentThreadRequest({
    action: "resolve",
    agentAdapter: targetAgentAdapter,
    threadId: target.threadId,
    title: target.threadName,
    cwd: target.workspace,
    createIfMissing: true,
    lookupMode: "state_db"
  }, {
    allowedWorkspaces: agentThreadAllowedWorkspaces(),
    defaultWorkspace: rootDir,
    dshBaseUrl: runtime.definition.dshBaseUrl
  });
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw new Error(String(result.data.message || "Plan secretary session resolution failed with HTTP " + result.statusCode + "."));
  }
  const thread = result.data.thread as { id?: unknown; title?: unknown; cwd?: unknown } | undefined;
  const threadId = String(thread?.id || "").trim();
  if (!threadId) throw new Error("Plan secretary session resolution did not return a session id.");
  const resolvedWorkspace = String(thread?.cwd || target.workspace);
  if (!sameCodexWorkspace(resolvedWorkspace, ownerWorkspace)) {
    throw new Error("Plan secretary session resolution returned a workspace different from the Primary Persona.");
  }
  const resolvedTarget: PlanSecretaryTarget = {
    agentAdapter: targetAgentAdapter,
    threadId,
    threadName: String(thread?.title || target.threadName),
    workspace: resolvedWorkspace,
    index: previousSession?.index ?? ("index" in target ? target.index : 1),
    model: target.model
  };
  if (threadId === target.threadId) return { target: resolvedTarget };

  const sessions = runtime.definition.codexPlanAssistantSessions ?? [];
  runtime.definition.codexPlanAssistantSessions = sessions.map((session) => session.threadId === target.threadId
    ? {
        ...session,
        ...(targetAgentAdapter === "dsh" ? { agentAdapter: "dsh" as const } : {}),
        threadId,
        threadName: resolvedTarget.threadName,
        workspace: resolvedTarget.workspace,
        initializedAt: undefined
      }
    : session);
  await writeAdapterConfigFile(runtime.definition);
  const bindingProjection = await currentRoleStorageApplication().queries.plan(roleId, plan.id, { timeoutMs: 30_000 });
  const currentBinding = bindingProjection?.plan.secretaryBinding;
  if (currentBinding?.sessionId === target.threadId) {
    await replacePlanSecretaryBindingForEvent(currentRoleStorageApplication(), {
      roleId,
      planId: plan.id,
      eventId,
      oldSessionId: target.threadId,
      binding: {
        ...currentBinding,
        agentType: targetAgentAdapter,
        sessionId: threadId,
        sessionTitle: resolvedTarget.threadName,
        workspace: resolvedTarget.workspace
      }
    });
  }

  const source = primaryAgentMessageSource(runtime.definition);
  const sourceThreadName = String(source.sessionName || runtime.definition.name || runtime.definition.id).trim();
  const count = Math.max(1, sessions.length);
  const index = resolvedTarget.index;
  return {
    target: resolvedTarget,
    initializationPrompt: codexPlanAssistantInitializationPrompt({
      roleId: String(runtime.definition.agentRoleId || ""),
      sourceAgentAdapter: source.agentAdapter === "dsh" ? "dsh" : "codex",
      assistantAgentAdapter: targetAgentAdapter,
      sourceThreadId: source.sessionId,
      sourceThreadName,
      assistantThreadId: threadId,
      assistantThreadName: resolvedTarget.threadName,
      workspace: resolvedTarget.workspace,
      count,
      index,
      managerBaseUrl
    })
  };
}

function runtimeForRoleDelivery(roleId: string, gatewayId: string): GatewayRuntime {
  if (gatewayId) {
    const runtime = runtimes.get(gatewayId);
    if (!runtime) throw new Error(`Gateway not found: ${gatewayId}`);
    if (roleIdForDefinition(runtime.definition) !== roleId) {
      throw new Error(`Gateway ${gatewayId} is not bound to role ${roleId}.`);
    }
    return runtime;
  }
  const matches = [...runtimes.values()].filter((runtime) => roleIdForDefinition(runtime.definition) === roleId);
  if (matches.length === 0) throw new Error(`No gateway is bound to role ${roleId}.`);
  if (matches.length > 1) throw new Error(`Multiple gateways are bound to role ${roleId}; gatewayId is required.`);
  return matches[0];
}

type PangHuIssueLedgerItem = {
  planId?: string;
  signature?: {
    groupId?: string;
    sourceMessageId?: string;
    module?: string;
    summary?: string;
  };
};

function pangHuIssueForPlan(planId: string): PangHuIssueLedgerItem | undefined {
  const ledgerPath = path.join(rootDir, "data", "roles", "XinghaiBuilder", "state", "issue-threads.json");
  try {
    const raw = JSON.parse(fs.readFileSync(ledgerPath, "utf8")) as { items?: unknown };
    const items = Array.isArray(raw.items) ? raw.items : [];
    const item = items.find((candidate) => candidate && typeof candidate === "object" && String((candidate as Record<string, unknown>).planId || "") === planId);
    return item && typeof item === "object" ? item as PangHuIssueLedgerItem : undefined;
  } catch (error) {
    managerOperationalLog.record("warn", "panghu_progress_issue_ledger_read_failed", {
      action: planId,
      error: managerOperationalError(error, rootDir)
    });
    return undefined;
  }
}

function findPangHuProgressIssue(plan: PlanItem): PangHuProgressNotificationDelivery["issue"] | undefined {
  const item = pangHuIssueForPlan(plan.id);
  const groupId = String(item?.signature?.groupId || "").trim();
  const sourceMessageId = String(item?.signature?.sourceMessageId || "").trim();
  if (!groupId || !sourceMessageId) return undefined;
  return {
    groupId,
    sourceMessageId,
    module: String(item?.signature?.module || "").trim() || undefined,
    summary: String(item?.signature?.summary || "").trim() || undefined
  };
}

function pangHuRuntimeForDelivery(delivery: PangHuProgressNotificationDelivery): GatewayRuntime {
  const gatewayId = String(delivery.gatewayId || "").trim();
  if (gatewayId) return runtimeForRoleDelivery(delivery.roleId, gatewayId);
  return runtimeForRoleDelivery(delivery.roleId, "");
}

async function deliverPangHuProgressNotification(delivery: PangHuProgressNotificationDelivery): Promise<PangHuProgressNotificationResult> {
  const runtime = pangHuRuntimeForDelivery(delivery);
  const routeId = runtime.definition.routeProfiles?.[0]?.id || runtime.definition.id;
  const deliveryId = stablePangHuProgressDeliveryId(delivery.plan.id, delivery.sourceSessionId, delivery.sourceTurnId);
  const sourceMessageId = String(delivery.issue.sourceMessageId || "").trim();
  const groupId = String(delivery.issue.groupId || "").trim();
  if (!groupId || !sourceMessageId) return { status: "failed", reason: "issue_source_incomplete", planId: delivery.plan.id, turnId: delivery.sourceTurnId, deliveryId, error: "PangHu issue source group/message identity is incomplete." };
  const replyOptions = {
    rootDir,
    routeRoot,
    rolesRoot,
    speechServiceUrl: speechServiceUrl(),
    publishEvent: publishManagerEvent,
    runtimes: [...runtimes.values()].map((item) => ({
      ...item.definition,
      rabiLinkRelay: rabiLinkRelayConfigFor(item.definition),
      napcatInstances: (item.definition.napcatInstances ?? sharedNormalizeNapCatInstances(item.definition)).map((instance) => ({ ...instance, accessToken: instance.accessToken ?? "" }))
    }))
  };
  const napcatInstances = runtime.definition.napcatInstances ?? sharedNormalizeNapCatInstances(runtime.definition);
  const instance = napcatInstances.find((candidate) => candidate.enabled !== false) || napcatInstances[0];
  const request: AgentSendRequest = {
    deliveryId,
    sender: { agentType: "codex_hook", sessionId: delivery.sourceSessionId },
    routeId,
    channel: "napcat",
    params: {
      target: "group",
      groupId,
      instanceId: instance?.id || "",
      replyToMessageId: sourceMessageId
    },
    payload: { type: "text", text: pangHuProgressMessage(delivery) },
    styleValidation: 0
  };
  const result = await handleAgentSend(request, replyOptions);
  if (result.status !== "sent" || !String(result.sentMessageId || "").trim()) {
    return { status: "failed", reason: "outbox_not_sent", planId: delivery.plan.id, turnId: delivery.sourceTurnId, deliveryId, error: result.reason || `Outbox status=${result.status}` };
  }
  const sentMessageId = String(result.sentMessageId).trim();
  const sent = await getMessage(sentMessageId, { httpUrl: String(instance?.httpUrl || ""), accessToken: String(instance?.accessToken || "") });
  const readbackId = String(sent.messageId || "").trim();
  const rawMessage = String(sent.rawMessage || "");
  const hasSourceQuote = rawMessage.includes(`[CQ:reply,id=${sourceMessageId}]`)
    || (Array.isArray(sent.message) && sent.message.some((segment) => String(segment?.type || "").toLowerCase() === "reply" && String(segment?.data?.id ?? segment?.data?.message_id ?? "") === sourceMessageId));
  if (readbackId !== sentMessageId || String(sent.groupId || "") !== groupId || !hasSourceQuote) {
    return { status: "failed", reason: "platform_reference_readback_incomplete", planId: delivery.plan.id, turnId: delivery.sourceTurnId, deliveryId, sentMessageId, platformReferenceReadback: false, error: `NapCat get_msg readback did not prove sentMessageId=${sentMessageId}, groupId=${groupId}, and quote=${sourceMessageId}.` };
  }
  return { status: "sent", reason: "outbox_sent_and_napcat_reference_readback", planId: delivery.plan.id, turnId: delivery.sourceTurnId, deliveryId, sentMessageId, platformReferenceReadback: true };
}

function deliverPlanTaskCompletion(delivery: PlanTaskCompletionDelivery): Promise<void> {
  return planTaskCompletionDelivery(delivery);
}

const activePlanFeedbackDeliveries = new Set<string>();
const activePlanFeedbackDeliveryFlights = new Map<string, Promise<void>>();
let planFeedbackRecoveryService: PlanFeedbackRecoveryService | undefined;
let planFeedbackDeliveryActive = false;

function planFeedbackDeliveryKey(roleId: string, planId: string, feedbackId: string): string {
  return `${roleId}:${planId}:${feedbackId}`;
}

type CurrentPlanFeedback = Readonly<{
  projection: RoleStoragePlanFeedbackProjection;
  record: PlanFeedbackRecord;
  revision: string;
}>;

function planFeedbackFromProjection(
  projection: RoleStoragePlanFeedbackProjection,
  feedbackId: string
): CurrentPlanFeedback {
  const record = projection.records.find((candidate) => candidate.id === feedbackId);
  if (!record) throw new Error(`Plan feedback not found: ${feedbackId}`);
  const revision = projection.recordRevisions[feedbackId];
  if (!revision) throw new Error(`Plan feedback revision is unavailable: ${feedbackId}`);
  return { projection, record, revision };
}

async function currentPlanFeedback(
  application: RoleStorageApplication,
  roleId: string,
  planId: string,
  feedbackId: string,
  signal?: AbortSignal
): Promise<CurrentPlanFeedback> {
  const projection = await application.queries.planFeedback(roleId, planId, {
    signal,
    timeoutMs: 30_000
  });
  if (!projection) throw new Error(`Plan not found: ${planId}`);
  return planFeedbackFromProjection(projection, feedbackId);
}

function planQaStoragePort(application: RoleStorageApplication): PlanQaStoragePort {
  return Object.freeze({
    query: (roleId, planId, options) => application.queries.planFeedback(roleId, planId, options),
    updatePlan: async (roleId, planId, patch, context) => {
      const committed = await application.commands.updatePlan(roleId, planId, patch, context);
      return {
        plan: committed.projection.plan,
        revision: committed.projection.revision
      };
    },
    updateQaHandling: async (roleId, planId, record, qaHandling, context) => (
      await application.commands.updatePlanFeedbackQaHandling(
        roleId,
        planId,
        record,
        qaHandling,
        context
      )
    ).projection
  });
}

function planFeedbackMutationContext(
  operation: string,
  roleId: string,
  planId: string,
  feedbackId: string,
  expectedRevision: string,
  payload: unknown,
  signal?: AbortSignal
): RoleStorageCommandContext {
  return {
    idempotencyKey: roleStorageOperationKey(
      operation,
      roleId,
      `${planId}:${feedbackId}`,
      expectedRevision,
      JSON.stringify(payload) ?? "null"
    ),
    expectedRevision,
    signal,
    timeoutMs: 30_000
  };
}

function normalizedFeedbackMessage(message?: string): string | undefined {
  return String(message || "").trim() || undefined;
}

async function transitionPlanFeedbackDelivery(
  application: RoleStorageApplication,
  roleId: string,
  planId: string,
  feedbackId: string,
  status: Exclude<PlanFeedbackDeliveryStatus, "record_only">,
  message?: string,
  signal?: AbortSignal
): Promise<CurrentPlanFeedback> {
  const current = await currentPlanFeedback(application, roleId, planId, feedbackId, signal);
  const normalizedMessage = normalizedFeedbackMessage(message);
  if (current.record.deliveryStatus === "record_only" || current.record.deliveryStatus === "delivered") {
    return current;
  }
  if (current.record.deliveryStatus === status && current.record.deliveryMessage === normalizedMessage) {
    return current;
  }
  const committed = await application.commands.updatePlanFeedbackDelivery(
    roleId,
    planId,
    current.record,
    status,
    normalizedMessage,
    planFeedbackMutationContext(
      "manager-feedback-delivery",
      roleId,
      planId,
      feedbackId,
      current.revision,
      { status, message: normalizedMessage },
      signal
    )
  );
  return planFeedbackFromProjection(committed.projection, feedbackId);
}

async function transitionPlanFeedbackPostCommit(
  application: RoleStorageApplication,
  roleId: string,
  planId: string,
  feedbackId: string,
  status: PlanFeedbackPostCommit["status"],
  message?: string,
  signal?: AbortSignal,
  expectedAttempt?: number
): Promise<CurrentPlanFeedback> {
  const current = await currentPlanFeedback(application, roleId, planId, feedbackId, signal);
  const normalizedMessage = normalizedFeedbackMessage(message);
  if (current.record.postCommit?.status === "completed") return current;
  if (expectedAttempt !== undefined && (
    current.record.postCommit?.status !== "processing"
    || current.record.postCommit.attempts !== expectedAttempt
  )) {
    throw new Error(
      `Plan feedback post-commit attempt changed: ${feedbackId}; expected=${expectedAttempt}; `
      + `current=${current.record.postCommit?.attempts ?? "absent"}:${current.record.postCommit?.status ?? "absent"}.`
    );
  }
  if (current.record.postCommit?.status === status && current.record.postCommit.message === normalizedMessage) {
    return current;
  }
  const committed = await application.commands.updatePlanFeedbackPostCommit(
    roleId,
    planId,
    current.record,
    status,
    normalizedMessage,
    planFeedbackMutationContext(
      "manager-feedback-post-commit",
      roleId,
      planId,
      feedbackId,
      current.revision,
      { status, message: normalizedMessage, expectedAttempt },
      signal
    )
  );
  return planFeedbackFromProjection(committed.projection, feedbackId);
}

async function processPlanFeedbackPostCommit(
  roleDir: string,
  roleId: string,
  gatewayId: string,
  inputRecord: PlanFeedbackRecord,
  signal?: AbortSignal,
  application: RoleStorageApplication = currentRoleStorageApplication()
): Promise<{ outcome: "handled" | "ignored"; record: PlanFeedbackRecord }> {
  let current = await currentPlanFeedback(application, roleId, inputRecord.planId, inputRecord.id, signal);
  let record = current.record;
  if (record.postCommit?.status === "completed") {
    return { outcome: record.qaHandling ? "handled" : "ignored", record };
  }
  current = await transitionPlanFeedbackPostCommit(
    application,
    roleId,
    record.planId,
    record.id,
    "processing",
    undefined,
    signal
  );
  record = current.record;
  const processingAttempt = record.postCommit?.attempts;
  if (!processingAttempt) throw new Error(`Plan feedback post-commit attempt is unavailable: ${record.id}`);
  try {
    const qaResult = await consumePlanQaFeedback({
      roleId,
      workflow: ensurePersonaPlanWorkflow(roleDir).workflow,
      storage: planQaStoragePort(application),
      feedback: record,
      signal,
      sendToTask: (request) => {
        const runtime = runtimeForRoleDelivery(
          roleId,
          String(record.gatewayId || gatewayId || "").trim()
        );
        return sendPlanFeedbackToTask(
          roleId,
          record.planId,
          runtime.definition.dshBaseUrl,
          request
        );
      },
      readTaskDelivery: inspectPlanFeedbackDelivery
    });
    if (qaResult.status === "dispatching") {
      throw new Error(`QA feedback ${record.id} is waiting for authoritative delivery readback.`);
    }
    current = await transitionPlanFeedbackPostCommit(
      application,
      roleId,
      record.planId,
      record.id,
      "completed",
      undefined,
      signal,
      processingAttempt
    );
    record = current.record;
    return { outcome: qaResult.outcome === "ignored" ? "ignored" : "handled", record };
  } catch (error) {
    try {
      await transitionPlanFeedbackPostCommit(
        application,
        roleId,
        record.planId,
        record.id,
        "failed",
        error instanceof Error ? error.message : String(error),
        signal,
        processingAttempt
      );
    } catch (transitionError) {
      throw new AggregateError(
        [error, transitionError],
        `Plan feedback post-commit failed and its failure state could not be committed: ${record.id}`
      );
    }
    throw error;
  }
}

function schedulePlanFeedbackPostCommit(
  roleDir: string,
  roleId: string,
  gatewayId: string,
  plan: PlanItem,
  inputRecord: PlanFeedbackRecord,
  application: RoleStorageApplication = currentRoleStorageApplication()
): void {
  if (!inputRecord.postCommit || inputRecord.postCommit.status === "completed") return;
  const deliveryKey = planFeedbackDeliveryKey(roleId, inputRecord.planId, inputRecord.id);
  const postCommitKey = `postcommit:${deliveryKey}`;
  if (activePlanFeedbackDeliveryFlights.has(postCommitKey)) return;
  const flight = new Promise<void>((resolve) => setImmediate(resolve))
    .then(async () => {
      const processed = await processPlanFeedbackPostCommit(roleDir, roleId, gatewayId, inputRecord, undefined, application);
      if (processed.outcome === "ignored"
        && processed.record.deliveryStatus !== "record_only"
        && processed.record.deliveryStatus !== "delivered") {
        await schedulePlanFeedbackDelivery(roleDir, roleId, gatewayId, plan, processed.record, application);
      }
    })
    .catch(() => {})
    .finally(() => {
      publishManagerEvent("plan_feedback_changed", { roleId, planId: inputRecord.planId, feedbackId: inputRecord.id });
      activePlanFeedbackDeliveryFlights.delete(postCommitKey);
    });
  activePlanFeedbackDeliveryFlights.set(postCommitKey, flight);
}

async function runPlanFeedbackDelivery(
  application: RoleStorageApplication,
  _roleDir: string,
  roleId: string,
  gatewayId: string,
  _plan: PlanItem,
  inputRecord: PlanFeedbackRecord
): Promise<PlanFeedbackRecord> {
  let current = await currentPlanFeedback(application, roleId, inputRecord.planId, inputRecord.id);
  let record = current.record;
  let authoritativePlan = current.projection.plan;
  if (record.deliveryStatus === "record_only" || record.deliveryStatus === "delivered") return record;
  if (!planFeedbackDeliveryActive) {
    return (await transitionPlanFeedbackDelivery(
      application,
      roleId,
      record.planId,
      record.id,
      "pending",
      "Manager plan feedback delivery plugin is inactive."
    )).record;
  }
  if (record.deliveryStatus === "failed") {
    current = await transitionPlanFeedbackDelivery(
      application,
      roleId,
      record.planId,
      record.id,
      "pending"
    );
    record = current.record;
    authoritativePlan = current.projection.plan;
  }

  try {
    const runtime = runtimeForRoleDelivery(roleId, gatewayId || String(record.gatewayId || "").trim());
    publishManagerEvent("plan_feedback_changed", { roleId, planId: authoritativePlan.id, feedbackId: record.id });
    const secretaryAssignment = await ensurePlanSecretaryTarget(
      runtime,
      roleId,
      authoritativePlan,
      `feedback:${record.id}`
    );
    const result = await deliverPlanApprovalFeedback({
      roleId,
      managerBaseUrl: `http://127.0.0.1:${managerPort}`,
      plan: secretaryAssignment.plan,
      feedback: record,
      secretary: secretaryAssignment.target
        ? {
            threadId: secretaryAssignment.target.threadId,
            threadName: secretaryAssignment.target.threadName,
            workspace: secretaryAssignment.target.workspace,
            model: secretaryAssignment.target.model
          }
        : undefined,
      sendToTask: (request) => sendPlanFeedbackToTask(
        roleId,
        secretaryAssignment.plan.id,
        runtime.definition.dshBaseUrl,
        request,
        record.id
      ),
      readTaskDelivery: inspectPlanFeedbackDelivery,
      sendToSecretary: (target, request) => sendPlanFeedbackToSecretary(
        runtime,
        roleId,
        secretaryAssignment.plan,
        target,
        request,
        `feedback:${record.id}`
      ),
      sendToPersona: async (request) => {
        const routeProfileId = runtime.definition.routeProfiles?.[0]?.id ?? runtime.definition.id;
        const isNotice = request.kind !== "full_feedback";
        const messageId = isNotice
          ? `plan-feedback-notice-${request.kind}-${record.id}`
          : `plan-feedback-${record.id}`;
        const deliveryAttachments: RolePanelAttachment[] = [
          ...record.attachments,
          ...record.planAttachments.map((attachment) => ({
            kind: attachment.kind === "image" ? "image" as const : "file" as const,
            name: attachment.name,
            path: attachment.path,
            size: attachment.size
          }))
        ];
        const replyContext = {
          runtimeRouteId: runtime.definition.id,
          gatewayId: runtime.definition.id,
          routeProfileId,
          routeKind: "plan_feedback",
          targetType: isNotice ? "plan_feedback_notice" : "plan_feedback",
          adapterType: "planFeedback",
          messageId,
          roleId,
          planId: secretaryAssignment.plan.id,
          planTitle: secretaryAssignment.plan.title,
          planStepId: record.stepId,
          planFeedbackId: record.id,
          planFeedbackResponseId: planFeedbackResponseId(record),
          planFeedbackKind: record.kind,
          planFeedbackAutoDelivered: request.kind === "auto_delivered_notice",
          planFeedbackDeliveryNoticeKind: isNotice ? request.kind : undefined,
          planAttachmentIds: record.planAttachments.map((attachment) => attachment.id)
        };
        await triggerGatewayPlanFeedback(runtime, messageId, request.text, deliveryAttachments, replyContext);
      }
    });
    record = (await transitionPlanFeedbackDelivery(
      application,
      roleId,
      record.planId,
      record.id,
      "delivered",
      result.message
    )).record;
    publishManagerEvent("plan_feedback_changed", { roleId, planId: authoritativePlan.id, feedbackId: record.id });
    return record;
  } catch (error) {
    if (error instanceof RoleStorageApplicationError) throw error;
    const pending = error instanceof PlanFeedbackDeliveryPendingError;
    if (pending) {
      planFeedbackRecoveryService?.allowRetry(roleId, authoritativePlan.id, record.id);
      planFeedbackRecoveryService?.queue("pending delivery readback");
    }
    record = (await transitionPlanFeedbackDelivery(
      application,
      roleId,
      record.planId,
      record.id,
      pending ? "pending" : "failed",
      error instanceof Error ? error.message : String(error)
    )).record;
    publishManagerEvent("plan_feedback_changed", { roleId, planId: authoritativePlan.id, feedbackId: record.id });
    return record;
  }
}

function schedulePlanFeedbackDelivery(
  roleDir: string,
  roleId: string,
  gatewayId: string,
  plan: PlanItem,
  inputRecord: PlanFeedbackRecord,
  application: RoleStorageApplication = currentRoleStorageApplication()
): Promise<PlanFeedbackRecord> {
  const deliveryKey = planFeedbackDeliveryKey(roleId, inputRecord.planId, inputRecord.id);
  const existing = activePlanFeedbackDeliveryFlights.get(deliveryKey);
  if (existing) {
    return existing.then(async () => (
      await currentPlanFeedback(application, roleId, inputRecord.planId, inputRecord.id)
    ).record);
  }
  activePlanFeedbackDeliveries.add(deliveryKey);
  const operation = runPlanFeedbackDelivery(application, roleDir, roleId, gatewayId, plan, inputRecord);
  const flight = operation
    .then(() => undefined, () => undefined)
    .finally(() => {
      activePlanFeedbackDeliveries.delete(deliveryKey);
      activePlanFeedbackDeliveryFlights.delete(deliveryKey);
    });
  activePlanFeedbackDeliveryFlights.set(deliveryKey, flight);
  return operation;
}

async function scheduleAndWaitForPlanFeedbackDelivery(
  roleDir: string,
  roleId: string,
  gatewayId: string,
  plan: PlanItem,
  feedback: PlanFeedbackRecord
): Promise<void> {
  const scheduled = await schedulePlanFeedbackDelivery(roleDir, roleId, gatewayId, plan, feedback);
  if (scheduled.deliveryStatus === "delivered" || scheduled.deliveryStatus === "record_only") return;
  throw new Error(scheduled.deliveryMessage || "Plan feedback delivery did not complete.");
}

async function recoverPlanFeedbackCandidate(
  candidate: PlanFeedbackRecoveryCandidate,
  options: {
    signal?: AbortSignal;
    inspect: (request: PlanFeedbackRecoveryTaskRequest) => Promise<PlanFeedbackDeliveryInspection>;
    schedule: (candidate: PlanFeedbackRecoveryCandidate) => Promise<void>;
  }
): Promise<PlanFeedbackRecoveryOutcome> {
  const application = currentRoleStorageApplication();
  return recoverPlanFeedbackCandidateBase(candidate, {
    ...options,
    query: async (current, signal) => {
      const projection = await application.queries.planFeedback(
        current.roleId,
        current.plan.id,
        { signal, timeoutMs: 30_000 }
      );
      return projection ? { plan: projection.plan, records: projection.records } : null;
    },
    updateDelivery: (current, record, status, message, signal) => transitionPlanFeedbackDelivery(
      application,
      current.roleId,
      record.planId,
      record.id,
      status,
      message,
      signal
    ).then(committed => committed.record),
    postCommit: (current) => processPlanFeedbackPostCommit(
      current.roleDir,
      current.roleId,
      String(current.feedback.gatewayId || "").trim(),
      current.feedback,
      options.signal,
      application
    )
  });
}

function presentedPlanWithFeedback(roleDir: string, plan: PlanItem) {
  return {
    ...presentPlan(plan, ensurePersonaPlanWorkflow(roleDir).workflow),
    approval: planFeedbackSummary(roleDir, plan.id)
  };
}

function triggerGatewayRolePanelMessage(
  runtime: GatewayRuntime,
  messageId: string,
  text: string,
  attachments: RolePanelAttachment[],
  replyContext?: Record<string, unknown>
): Promise<void> {
  return triggerGatewayLocalAgentMessage(runtime, "role-panel", messageId, text, attachments, replyContext);
}

function triggerGatewayPlanFeedback(
  runtime: GatewayRuntime,
  messageId: string,
  text: string,
  attachments: RolePanelAttachment[],
  replyContext: Record<string, unknown>
): Promise<void> {
  return triggerGatewayLocalAgentMessage(runtime, "plan-feedback", messageId, text, attachments, replyContext);
}

function triggerGatewayLocalAgentMessage(
  runtime: GatewayRuntime,
  argumentPrefix: "role-panel" | "plan-feedback",
  messageId: string,
  text: string,
  attachments: RolePanelAttachment[],
  replyContext?: Record<string, unknown>
): Promise<void> {
  const roleId = roleIdForDefinition(runtime.definition);
  const routeProfileId = runtime.definition.routeProfiles?.[0]?.id ?? runtime.definition.id;
  const logLabel = argumentPrefix === "plan-feedback" ? "plan feedback" : "role panel";
  const command = childCommand([
    `--${argumentPrefix}-message=${encodeURIComponent(messageId)}`,
    `--${argumentPrefix}-text=${encodeURIComponent(text)}`,
    `--${argumentPrefix}-role=${encodeURIComponent(roleId)}`,
    `--${argumentPrefix}-gateway=${encodeURIComponent(runtime.definition.id)}`,
    `--${argumentPrefix}-route-profile=${encodeURIComponent(routeProfileId)}`,
    `--${argumentPrefix}-attachments=${encodeURIComponent(JSON.stringify(attachments))}`,
    ...(replyContext ? [`--${argumentPrefix}-reply-context=${encodeURIComponent(JSON.stringify(replyContext))}`] : [])
  ]);
  appendLog(runtime, `${logLabel} requested: ${messageId}`);
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(command.command, command.args, {
      cwd: rootDir,
      env: envFor(runtime.definition),
      shell: command.shell,
      windowsHide: true
    });

    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      action();
    };
    const deadline = setTimeout(() => {
      try { child.kill(); } catch { /* best effort */ }
      finish(() => reject(new Error(`${logLabel} timed out: ${messageId}`)));
    }, 45_000);

    child.stdout.on("data", (data) => {
      for (const line of data.toString("utf8").split(/\r?\n/).filter(Boolean)) {
        appendLog(runtime, `${logLabel}: ${line}`);
      }
    });
    child.stderr.on("data", (data) => {
      for (const line of data.toString("utf8").split(/\r?\n/).filter(Boolean)) {
        appendLog(runtime, `${logLabel} error: ${line}`);
      }
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("exit", (code, signal) => {
      if (code === 0) {
        appendLog(runtime, `${logLabel} completed: ${messageId}`);
        finish(resolve);
        return;
      }
      finish(() => reject(new Error(`${logLabel} failed: code=${code ?? "null"} signal=${signal ?? "null"}`)));
    });
  });
}

function triggerGatewaySpeechMessage(runtime: GatewayRuntime, record: SpeechIngressRecord): Promise<ManagerSpeechDeliveryOutcome> {
  const messageId = record.id;
  const roleId = roleIdForDefinition(runtime.definition);
  const routeProfileId = record.routeProfileId || runtime.definition.routeProfiles?.[0]?.id || runtime.definition.id;
  const command = childCommand([
    `--speech-message=${encodeURIComponent(messageId)}`,
    `--speech-role=${encodeURIComponent(roleId)}`,
    `--speech-gateway=${encodeURIComponent(runtime.definition.id)}`,
    `--speech-route-profile=${encodeURIComponent(routeProfileId)}`
  ]);
  appendLog(runtime, `speech message requested: ${messageId}`);
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdoutText = "";
    const child = spawn(command.command, command.args, {
      cwd: rootDir,
      env: {
        ...envFor(runtime.definition),
        RABIROUTE_SPEECH_MESSAGES_DIR: speechIngressStore.root
      },
      shell: command.shell,
      windowsHide: true
    });
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      action();
    };
    const deadline = setTimeout(() => {
      try { child.kill(); } catch { /* best effort */ }
      finish(() => reject(new SpeechControlError(
        `Speech delivery timed out before the Desktop owner confirmed receipt: ${messageId}`,
        504
      )));
    }, 40_000);
    child.stdout.on("data", (data) => {
      const textChunk = data.toString("utf8");
      stdoutText += textChunk;
      for (const line of textChunk.split(/\r?\n/).filter(Boolean)) {
        if (!line.startsWith(SPEECH_PROCESS_RESULT_MARKER)) appendLog(runtime, `speech: ${line}`);
      }
    });
    child.stderr.on("data", (data) => {
      for (const line of data.toString("utf8").split(/\r?\n/).filter(Boolean)) appendLog(runtime, `speech error: ${line}`);
    });
    child.on("error", (error) => finish(() => reject(new SpeechControlError(
      `Speech delivery process failed to start: ${error instanceof Error ? error.message : String(error)}`,
      502
    ))));
    child.on("close", (code, signal) => {
      finish(() => {
        const terminal = parseSpeechProcessResult(stdoutText);
        if (code === SPEECH_EXIT_DELIVERED && terminal?.status === "delivered") {
          appendLog(runtime, `speech message delivered to Desktop owner: ${messageId}`);
          resolve(terminal);
          return;
        }
        if (code === SPEECH_EXIT_RECORDED && terminal?.status === "recorded") {
          appendLog(runtime, `speech message recorded without Agent delivery: ${messageId}; ${terminal.reason || "keyword policy"}`);
          resolve(terminal);
          return;
        }
        const detail = terminal?.detail
          || `speech message failed: code=${code ?? "null"} signal=${signal ?? "null"}`;
        reject(new SpeechControlError(detail, 502));
      });
    });
  });
}

async function testGatewayAgentDelivery(
  id: string,
  request: { agentAdapterType?: AgentAdapterType }
): Promise<AgentDeliveryTestResult> {
  const runtime = runtimes.get(id);
  if (!runtime) throw new Error(`Gateway not found: ${id}`);
  if (runtime.definition.enabled === false) throw new Error("当前 Route 已停用，不能执行投递测试。");

  const configuredAdapters = normalizeAgentAdapters(runtime.definition.agentAdapters);
  const requestedAdapter = parseAgentAdapterType(request.agentAdapterType);
  const adapter = requestedAdapter
    ?? runtime.definition.primaryAgentAdapter
    ?? configuredAdapters[0];
  if (!adapter || !configuredAdapters.includes(adapter)) {
    throw new Error("目标 Agent 未添加到当前 Route。");
  }
  if (agentAdapterManifest(adapter).maturity === "stub") {
    throw new Error("该 Agent 当前只支持人工接力，无法确认真实投递。");
  }

  const deliveryId = randomUUID();
  const envelope = buildAgentDeliveryTestEnvelope({
    deliveryId,
    gatewayId: id,
    routeName: runtime.definition.name,
    agentAdapterType: adapter
  });
  const command = childCommand([
    `--direct-agent-envelope=${encodeURIComponent(JSON.stringify(envelope))}`,
    `--direct-agent-adapter=${adapter}`,
    `--direct-agent-gateway=${encodeURIComponent(id)}`,
    `--agent-delivery-test=${deliveryId}`
  ]);
  appendLog(runtime, `agent delivery test requested: adapter=${adapter} deliveryId=${deliveryId}`);

  return await new Promise<AgentDeliveryTestResult>((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const child = spawn(command.command, command.args, {
      cwd: rootDir,
      env: envFor(runtime.definition),
      shell: command.shell,
      windowsHide: true
    });
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      action();
    };
    const deadline = setTimeout(() => {
      void stopChildProcessTree(child)
        .catch(() => { child.kill(); })
        .finally(() => finish(() => reject(new Error(`投递测试超时：${deliveryId}`))));
    }, 60_000);
    deadline.unref?.();
    child.stdout.on("data", (data) => {
      const text = data.toString("utf8");
      stdout += text;
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        appendLog(runtime, `agent delivery test: ${line}`);
      }
    });
    child.stderr.on("data", (data) => {
      const text = data.toString("utf8");
      stderr += text;
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        appendLog(runtime, `agent delivery test error: ${line}`);
      }
    });
    child.on("error", error => finish(() => reject(error)));
    child.on("exit", (code, signal) => finish(() => {
      const result = parseAgentDeliveryTestResult(stdout);
      if (code === 0
        && result?.status === "delivered"
        && result.deliveryId === deliveryId
        && result.agentAdapterType === adapter) {
        appendLog(runtime, `agent delivery test delivered: adapter=${adapter} deliveryId=${deliveryId}`);
        resolve(result);
        return;
      }
      const detail = result?.error
        || stderr.trim().split(/\r?\n/).filter(Boolean).at(-1)
        || `agent delivery test failed: code=${code ?? "null"} signal=${signal ?? "null"}`;
      reject(new Error(detail));
    }));
  });
}

function triggerGatewayDirectAgentMessage(id: string, envelope: RabiDeliveryEnvelope): Promise<void> {
  const runtime = runtimes.get(id);
  if (!runtime) {
    throw new Error(`Gateway not found: ${id}`);
  }
  const args = [`--direct-agent-envelope=${encodeURIComponent(JSON.stringify(envelope))}`];
  const command = childCommand(args);
  appendLog(runtime, "remote agent result requested direct delivery");
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(command.command, command.args, {
      cwd: rootDir,
      env: envFor(runtime.definition),
      shell: command.shell,
      windowsHide: true
    });
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      action();
    };
    const deadline = setTimeout(() => {
      void stopChildProcessTree(child)
        .catch(() => { child.kill(); })
        .finally(() => finish(() => reject(new Error("remote agent result delivery timed out after 30000 ms"))));
    }, 30_000);
    deadline.unref?.();
    child.stdout.on("data", (data) => {
      for (const line of data.toString("utf8").split(/\r?\n/).filter(Boolean)) {
        appendLog(runtime, `remote agent result: ${line}`);
      }
    });
    child.stderr.on("data", (data) => {
      for (const line of data.toString("utf8").split(/\r?\n/).filter(Boolean)) {
        appendLog(runtime, `remote agent result error: ${line}`);
      }
    });
    child.on("error", error => finish(() => reject(error)));
    child.on("exit", (code, signal) => finish(() => {
      if (code === 0) {
        appendLog(runtime, "remote agent result delivered to local agent");
        resolve();
        return;
      }
      reject(new Error(`remote agent result delivery failed: code=${code ?? "null"} signal=${signal ?? "null"}`));
    }));
  });
}

function remoteAgentResultEnvelope(task: RemoteAgentTask, event: RemoteAgentTaskEvent): RabiDeliveryEnvelope {
  const lines = [
    `任务 ID：${task.taskId}`,
    `远端设备：${task.deviceId}`,
    `任务类型：${task.taskKind}`,
    `状态：${event.status ?? task.status}`,
    event.summary ? `摘要：${event.summary}` : "",
    event.message ? `消息：${event.message}` : "",
    event.artifactPath ? `产物路径：${event.artifactPath}` : "",
    event.logPath ? `日志路径：${event.logPath}` : "",
    event.error ? `错误：${event.error}` : "",
    "",
    "原始任务：",
    task.message
  ].filter(Boolean);
  return {
    messageSource: {
      type: "system",
      eventType: "remote_agent_task_result",
      eventName: "远端 Agent 任务结果",
      eventId: task.taskId,
      actorType: "远端 Agent",
      actorName: task.threadName || task.deviceId,
      actorId: task.deviceId,
      routeId: task.originGatewayId
    },
    messageContent: lines.join("\n")
  };
}

async function handleRemoteAgentTaskEvent(
  task: RemoteAgentTask,
  event: RemoteAgentTaskEvent,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted) return;
  const runtime = runtimes.get(task.originGatewayId);
  if (runtime) {
    appendLog(runtime, `remote agent task ${task.taskId} ${event.status ?? task.status}: ${event.summary || event.message || event.error || ""}`.trim());
  }
  if (event.status === "completed" || event.status === "failed") {
    if (!runtime) {
      console.warn(`Remote Agent task ${task.taskId} finished but origin gateway was not found: ${task.originGatewayId}`);
      return;
    }
    if (signal.aborted) return;
    await triggerGatewayDirectAgentMessage(task.originGatewayId, remoteAgentResultEnvelope(task, event));
  }
}

function remoteAgentTaskWithGatewayDefaults(request: RemoteAgentTaskRequest): RemoteAgentTaskRequest {
  if (request.deviceId && request.cwd && request.threadName) {
    return request;
  }
  const originGatewayId = String(
    request.originGatewayId
    || request.gatewayId
    || request.originReplyContext?.gatewayId
    || [...runtimes.values()][0]?.definition.id
    || ""
  ).trim();
  const definition = originGatewayId ? runtimes.get(originGatewayId)?.definition : undefined;
  if (!definition) {
    return request;
  }
  return {
    ...request,
    deviceId: request.deviceId || definition.remoteAgentDefaultDeviceId,
    cwd: request.cwd || definition.remoteAgentDefaultCwd,
    threadName: request.threadName || definition.remoteAgentDefaultThreadName
  };
}

function handleRolePanelApi(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
  activeRolesRoot = rolesRoot
): boolean {
  const messageListMatch = requestUrl.pathname.match(/^\/api\/roles\/([^/]+)\/role-panel\/messages$/);
  if (request.method === "GET" && messageListMatch) {
    const roleId = sanitizeRoleId(decodeURIComponent(messageListMatch[1]));
    if (!roleId) {
      jsonResponse(response, 400, { code: -1, message: "Missing role id." });
      return true;
    }
    const limit = Number(requestUrl.searchParams.get("limit") || "120");
    void managerReadWorkerPool.queryRolePanelTimeline(
      activeRolesRoot,
      roleId,
      Number.isFinite(limit) && limit > 0 ? limit : 120
    ).then(messages => jsonResponse(response, 200, { code: 0, roleId, messages }))
      .catch(error => jsonResponse(response, 503, {
        code: -1,
        message: error instanceof Error ? error.message : "Role panel timeline is unavailable."
      }));
    return true;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/role-panel/messages") {
    void readJsonBody<RolePanelMessageRequest>(request)
      .then(async (body) => {
        const gatewayId = sanitizeRoleId(body.gatewayId);
        const runtime = gatewayId ? runtimes.get(gatewayId) : [...runtimes.values()][0];
        if (!runtime) throw new Error(gatewayId ? `Gateway not found: ${gatewayId}` : "No gateway is configured.");
        const text = String(body.text || "").trim();
        const attachments = normalizeRolePanelAttachments(body.attachments);
        if (!text && attachments.length === 0) throw new Error("Missing role panel message text or attachment.");
        const roleId = roleIdForDefinition(runtime.definition);
        return deliverRolePanelMessage({
          runtime,
          roleId,
          sender: "本地用户",
          text,
          attachments,
          messageIdPrefix: "role-panel-user",
          deliver: triggerGatewayRolePanelMessage,
          appendTimeline: appendRolePanelTimeline
        });
      })
      .then((payload) => jsonResponse(response, 202, { code: 0, ...payload }))
      .catch((error) => jsonResponse(
        response,
        error instanceof RolePanelDeliveryError ? error.statusCode : 400,
        { code: -1, status: "failed", message: error instanceof Error ? error.message : String(error) }
      ));
    return true;
  }

  return false;
}

function speechServiceUrl(): string {
  return rabiGlobalConfig.read().rabiLinkRelay.speechServiceUrl;
}

function writeSpeechProxyResponse(response: http.ServerResponse, result: LocalSpeechResponse): void {
  response.writeHead(result.status, {
    "content-type": result.contentType,
    "content-length": String(result.body.byteLength),
    ...result.headers
  });
  response.end(result.body);
}

function writeSpeechJson<T>(
  response: http.ServerResponse,
  operation: Promise<T>,
  successStatus = 200,
  errorStatus = 502
): void {
  void operation
    .then(data => jsonResponse(response, successStatus, { code: 0, data }))
    .catch(error => jsonResponse(response, speechControlErrorStatus(error, errorStatus), {
      code: -1,
      message: speechControlErrorMessage(error)
    }));
}

function writeSpeechRuntimeJson(
  response: http.ServerResponse,
  operation: Promise<unknown>
): void {
  void operation
    .then(data => jsonResponse(response, 200, { code: 0, data }))
    .catch(error => jsonResponse(response, error instanceof SpeechRuntimeControlError ? error.status : 502, {
      code: -1,
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof SpeechRuntimeControlError && error.detail ? { detail: error.detail } : {}),
      ...(error instanceof SpeechRuntimeControlError && error.resolution ? { resolution: error.resolution } : {})
    }));
}

async function inspectPlanFeedbackDelivery(
  request: PlanFeedbackRecoveryTaskRequest
): Promise<"accepted" | "in_progress" | "missing"> {
  const result = await handleAgentThreadRequest({
    action: "read",
    threadId: request.threadId,
    cwd: request.cwd,
    deliveryId: request.deliveryId
  }, {
    allowedWorkspaces: agentThreadAllowedWorkspaces(),
    defaultWorkspace: rootDir
  });
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw new Error(String(result.data.message || `Plan feedback readback failed with HTTP ${result.statusCode}.`));
  }
  const state = (result.data.delivery as { state?: unknown } | undefined)?.state;
  if (state === "accepted" || state === "in_progress" || state === "missing") return state;
  throw new Error("Plan feedback readback returned no authoritative delivery state.");
}

function writeSpeechModelManagerJson(
  response: http.ServerResponse,
  operation: () => unknown,
  successStatus = 200
): void {
  try {
    jsonResponse(response, successStatus, { code: 0, data: operation() });
  } catch (error) {
    jsonResponse(response, error instanceof SpeechModelManagerError ? error.status : 500, {
      code: -1,
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

function handleSpeechApi(request: http.IncomingMessage, requestUrl: URL, response: http.ServerResponse): boolean {
  if (requestUrl.pathname === "/api/speech/model-management/settings") {
    response.setHeader("cache-control", "no-store");
    if (!localModelSettingsRequestAllowed(request)) {
      jsonResponse(response, 403, { code: -1, message: "模型目录设置仅允许本机页面访问。" });
      return true;
    }
    const fail = (error: unknown) => jsonResponse(response,
      error instanceof SpeechModelSettingsError || error instanceof SpeechModelManagerError ? error.status : 500,
      { code: -1, message: error instanceof SpeechModelSettingsError || error instanceof SpeechModelManagerError ? error.message : "模型目录设置操作失败。" });
    if (request.method === "GET") {
      try { jsonResponse(response, 200, { code: 0, data: speechModelManager.directorySettings() }); } catch (error) { fail(error); }
    } else if (request.method === "PATCH") {
      if (managerReadOnly) { jsonResponse(response, 423, { code: -1, message: "Manager is read-only." }); return true; }
      const expectedGeneration = headerValue(request.headers["x-rabiroute-expected-application-generation-id"]).trim();
      const expectedInstance = headerValue(request.headers["x-rabiroute-expected-manager-instance-id"]).trim();
      if (!expectedGeneration || !expectedInstance) {
        jsonResponse(response, 400, { code: -1, message: "Current application generation and Manager instance headers are required." }); return true;
      }
      if (expectedGeneration !== (managerHostIdentity?.applicationGenerationId ?? managerInstanceId) || expectedInstance !== managerInstanceId) {
        jsonResponse(response, 409, { code: -1, message: "Manager lifecycle changed; reload /meta before retrying." }); return true;
      }
      if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
        jsonResponse(response, 415, { code: -1, message: "Expected application/json." }); return true;
      }
      void readJsonBody<unknown>(request).then(body => {
        jsonResponse(response, 200, { code: 0, data: speechModelManager.updateDirectorySettings(body) });
      }).catch(fail);
    } else jsonResponse(response, 405, { code: -1, message: "Method not allowed." });
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/speech/events") {
    proxySpeechEventStream(response, {
      openUpstream: signal => speechControl.eventStream(signal),
      errorMessage: speechControlErrorMessage
    });
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/speech/status") {
    writeSpeechJson(response, speechControl.status(), 200, 500);
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/speech/runtime/start") {
    writeSpeechRuntimeJson(response, speechRuntimeControl.start());
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/speech/runtime/stop") {
    writeSpeechRuntimeJson(response, speechRuntimeControl.stop());
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/speech/model-management") {
    writeSpeechModelManagerJson(response, () => speechModelManager.snapshot());
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/speech/model-management/runtime/install") {
    writeSpeechModelManagerJson(response, () => speechModelManager.installRuntime(), 202);
    return true;
  }
  const modelInstallMatch = requestUrl.pathname.match(/^\/api\/speech\/model-management\/models\/([^/]+)\/install$/);
  if (request.method === "POST" && modelInstallMatch) {
    writeSpeechModelManagerJson(
      response,
      () => speechModelManager.installModel(decodeURIComponent(modelInstallMatch[1] || "")),
      202
    );
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/speech/selection-reader/settings") {
    jsonResponse(response, 200, { code: 0, data: selectionSpeechSettings.read() });
    return true;
  }
  if (request.method === "PUT" && requestUrl.pathname === "/api/speech/selection-reader/settings") {
    writeSpeechJson(
      response,
      readJsonBody<unknown>(request).then(body => selectionSpeechSettings.write(body)),
      200,
      500
    );
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/speech/models") {
    writeSpeechJson(response, speechControl.models().then(models => ({ models })));
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/speech/personas") {
    jsonResponse(response, 200, { code: 0, data: { personas: speechControl.personas() } });
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/speech/speakers") {
    writeSpeechJson(response, speechControl.speakerRegistry(requestUrl.searchParams.get("sessionId") || undefined));
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/speech/speakers") {
    writeSpeechJson(
      response,
      readJsonBody<SpeechSpeakerProfileCreateCommand>(request).then(body => speechControl.createSpeakerProfile(body)),
      200,
      400
    );
    return true;
  }
  if (requestUrl.pathname.startsWith("/api/speech/speakers/")) {
    const speakerId = requestUrl.pathname.slice("/api/speech/speakers/".length);
    if (request.method === "PATCH") {
      writeSpeechJson(
        response,
        readJsonBody<SpeechSpeakerProfileUpdateCommand>(request)
          .then(body => speechControl.updateSpeakerProfile(speakerId, body)),
        200,
        400
      );
      return true;
    }
    if (request.method === "DELETE") {
      writeSpeechJson(response, speechControl.deleteSpeakerProfile(speakerId), 200, 400);
      return true;
    }
  }
  if (request.method === "PUT" && requestUrl.pathname === "/api/speech/speaker-bindings") {
    writeSpeechJson(
      response,
      readJsonBody<SpeechSpeakerBindingCommand>(request).then(body => speechControl.bindSpeaker(body)),
      200,
      400
    );
    return true;
  }
  if (request.method === "PUT" && requestUrl.pathname === "/api/speech/speaker-identities") {
    writeSpeechJson(
      response,
      readJsonBody<SpeechSpeakerIdentityCommand>(request).then(body => speechControl.identifySpeaker(body)),
      200,
      400
    );
    return true;
  }
  if (request.method === "DELETE" && requestUrl.pathname === "/api/speech/speaker-bindings") {
    writeSpeechJson(
      response,
      speechControl.unbindSpeaker(
        requestUrl.searchParams.get("sessionId") || "",
        requestUrl.searchParams.get("recordId") || "",
        requestUrl.searchParams.get("speakerLabel") || ""
      ),
      200,
      400
    );
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/speech/playback/status") {
    writeSpeechJson(response, speechControl.playbackStatus());
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/speech/audio-streams") {
    writeSpeechJson(response, speechControl.audioStreams().then(audioStream => ({ audioStream })));
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/speech/audio-streams/events") {
    writeSpeechJson(response, speechControl.audioStreamEvents({
      limit: Number(requestUrl.searchParams.get("limit") || 200),
      clientId: requestUrl.searchParams.get("clientId") || undefined,
      sourceDeviceId: requestUrl.searchParams.get("sourceDeviceId") || undefined,
      beforeSequence: requestUrl.searchParams.has("beforeSequence")
        ? Number(requestUrl.searchParams.get("beforeSequence"))
        : undefined
    }).then(events => ({ events })));
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/speech/audio-streams/token") {
    writeSpeechJson(response, speechControl.audioStreamToken().then(token => ({ token })), 200, 409);
    return true;
  }
  if (request.method === "PUT" && requestUrl.pathname === "/api/speech/audio-streams/selection") {
    writeSpeechJson(
      response,
      readJsonBody<SpeechAudioStreamSelectionCommand>(request)
        .then(body => speechControl.selectAudioStream(body)),
      200,
      400
    );
    return true;
  }
  if (request.method === "PUT" && requestUrl.pathname === "/api/speech/playback/volume") {
    writeSpeechJson(
      response,
      readJsonBody<SpeechPlaybackVolumeCommand>(request).then(body => speechControl.setPlaybackVolume(body)),
      200,
      400
    );
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/speech/records") {
    writeSpeechJson(response, speechControl.records({
      limit: Number(requestUrl.searchParams.get("limit") || 200),
      kind: requestUrl.searchParams.get("kind") || undefined,
      sessionId: requestUrl.searchParams.get("sessionId") || undefined,
      routeId: requestUrl.searchParams.get("routeId") || undefined,
      since: requestUrl.searchParams.has("since") ? Number(requestUrl.searchParams.get("since")) : undefined,
      until: requestUrl.searchParams.has("until") ? Number(requestUrl.searchParams.get("until")) : undefined,
      sourceDeviceId: requestUrl.searchParams.get("sourceDeviceId") || undefined,
      before: requestUrl.searchParams.has("before") ? Number(requestUrl.searchParams.get("before")) : undefined
    }).then(records => ({ records })));
    return true;
  }
  const speechRecordAudioMatch = requestUrl.pathname.match(/^\/api\/speech\/records\/([^/]+)\/audio$/);
  if (request.method === "GET" && speechRecordAudioMatch) {
    void speechControl.recordAudio(decodeURIComponent(speechRecordAudioMatch[1]))
      .then(result => writeSpeechProxyResponse(response, result))
      .catch(error => jsonResponse(response, speechControlErrorStatus(error, 502), {
        code: -1,
        message: speechControlErrorMessage(error)
      }));
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/speech/microphone/status") {
    writeSpeechJson(response, speechControl.microphoneStatus());
    return true;
  }
  if (request.method === "PUT" && requestUrl.pathname === "/api/speech/microphone/settings") {
    writeSpeechJson(
      response,
      readJsonBody<SpeechMicrophoneSettingsCommand>(request).then(body => speechControl.updateMicrophoneSettings(body)),
      200,
      400
    );
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/speech/microphone/reconcile") {
    writeSpeechJson(response, speechControl.reconcileMicrophone(), 200, 500);
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/speech/microphone/devices") {
    writeSpeechJson(response, speechControl.microphoneDevices().then(devices => ({ devices })));
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/speech/microphone/start") {
    writeSpeechJson(
      response,
      readJsonBody<SpeechMicrophoneStartCommand>(request).then(body => speechControl.startMicrophone(body)),
      200,
      400
    );
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/speech/microphone/stop") {
    writeSpeechJson(response, speechControl.stopMicrophone());
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/speech/playback/stop") {
    writeSpeechJson(response, speechControl.stopPlayback());
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/speech/tts") {
    void readJsonBody<SpeechSynthesisCommand>(request)
      .then(body => speechControl.synthesize(body))
      .then((result) => writeSpeechProxyResponse(response, result))
      .catch(error => jsonResponse(response, speechControlErrorStatus(error), {
        code: -1,
        message: speechControlErrorMessage(error)
      }));
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/speech/asr") {
    const contentType = headerValue(request.headers["content-type"]);
    void readBodyBuffer(request, 27 * 1024 * 1024)
      .then(body => speechControl.transcribe(contentType, body))
      .then((result) => writeSpeechProxyResponse(response, result))
      .catch(error => jsonResponse(response, speechControlErrorStatus(error), {
        code: -1,
        message: speechControlErrorMessage(error)
      }));
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/speech/messages") {
    const recordId = String(requestUrl.searchParams.get("recordId") || "").trim();
    if (recordId) {
      const record = speechIngressStore.read(recordId);
      if (!record) {
        jsonResponse(response, 404, { code: -1, message: `Speech ingress record was not found: ${recordId}` });
      } else {
        jsonResponse(response, 200, {
          code: 0,
          data: { record, deliveries: speechIngressStore.listDeliveryReceipts(record.id) }
        });
      }
      return true;
    }
    const limit = Math.max(1, Math.min(1_000, Math.floor(Number(requestUrl.searchParams.get("limit") || 200) || 200)));
    const sourceDeviceId = String(requestUrl.searchParams.get("sourceDeviceId") || "").trim();
    const messageAdapterType = requestUrl.searchParams.get("messageAdapterType") === "rabilink"
      ? "rabilink"
      : requestUrl.searchParams.get("messageAdapterType") === "speech"
        ? "speech"
        : undefined;
    const before = requestUrl.searchParams.has("before")
      ? Number(requestUrl.searchParams.get("before"))
      : undefined;
    const records = speechIngressStore.query({
      limit,
      sourceDeviceId: sourceDeviceId || undefined,
      messageAdapterType,
      before
    });
    jsonResponse(response, 200, {
      code: 0,
      data: {
        records,
        deliveriesByRecordId: Object.fromEntries(
          records.map(record => [record.id, speechIngressStore.listDeliveryReceipts(record.id)])
        )
      }
    });
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/speech/messages") {
    void readJsonBody<SpeechMessageCommand & { gatewayId?: string }>(request)
      .then(
        body => {
          const host = rabiGlobalConfig.read();
          return speechControl.acceptMessage(hostOwnedSpeechMessageCommand(body, {
            rabiGuid: host.rabiGuid,
            rabiName: host.rabiName,
            fallbackHostName: os.hostname()
          }));
        },
        error => Promise.reject(new SpeechControlError(speechControlErrorMessage(error), 400))
      )
      .then(data => jsonResponse(response, 200, { code: 0, data }))
      .catch(error => jsonResponse(response, speechControlErrorStatus(error, 502), {
        code: -1,
        message: speechControlErrorMessage(error)
      }));
    return true;
  }
  return false;
}

function handleDesktopSettingsApi(request: http.IncomingMessage, requestUrl: URL, response: http.ServerResponse): boolean {
  if (requestUrl.pathname !== "/api/desktop/settings") return false;
  if (request.method === "GET") {
    jsonResponse(response, 200, {
      code: 0,
      data: { ...desktopSettings.read(), autostartConfigured: desktopSettings.autostartConfigured() }
    });
    return true;
  }
  if (request.method === "PATCH" || request.method === "PUT") {
    if (managerReadOnly) {
      jsonResponse(response, 403, { code: -1, message: "Manager is read-only." });
      return true;
    }
    void readJsonBody<Partial<DesktopSettings>>(request)
      .then((body) => {
        const current = desktopSettings.read();
        const screenshot = body && typeof body.screenshot === "object" && !Array.isArray(body.screenshot)
          ? body.screenshot
          : {};
        return desktopSettings.write({
          ...current,
          ...body,
          screenshot: { ...current.screenshot, ...screenshot }
        });
      })
      .then((data) => {
        publishManagerEvent("desktop_settings_changed", { webTheme: data.webTheme });
        return data;
      })
      .then((data) => jsonResponse(response, 200, {
        code: 0,
        data: { ...data, autostartConfigured: true }
      }))
      .catch((error) => jsonResponse(response, 400, {
        code: -1,
        message: error instanceof Error ? error.message : String(error)
      }));
    return true;
  }
  return false;
}

function roleDirForApi(roleId: string): string {
  const safeRoleId = sanitizeRoleId(roleId);
  if (!safeRoleId) {
    throw new Error("Missing role id.");
  }
  return roleFolderPath(rolesRoot, safeRoleId);
}

const roleKnowledgeCatalogRefreshes = new Map<string, Promise<void>>();

function requestRoleKnowledgeCatalogRefresh(roleDir: string): void {
  const key = path.resolve(roleDir);
  if (roleKnowledgeCatalogRefreshes.has(key)) return;
  const refresh = managerCatalogWorkerPool.queryRoleKnowledgeCatalogSnapshot(roleDir, { timeoutMs: 30_000 })
    .then(() => undefined)
    .catch((error) => {
      managerOperationalLog.record("warn", "role_knowledge_catalog_refresh_failed", {
        action: key,
        error: managerOperationalError(error, rootDir)
      });
    })
    .finally(() => {
      if (roleKnowledgeCatalogRefreshes.get(key) === refresh) roleKnowledgeCatalogRefreshes.delete(key);
    });
  roleKnowledgeCatalogRefreshes.set(key, refresh);
}

function roleKnowledgeCacheUnavailable(response: http.ServerResponse, roleId: string): void {
  jsonResponse(response, 503, {
    code: -1,
    error: "cache_unavailable",
    message: `Role knowledge catalog for ${roleId} is warming; retry shortly.`
  });
}

function recalledKnowledgeForMessage(source: RegisterMessageGroupRequirementInput["source"]): KnowledgeRecallMatch[] {
  const roleId = String(source?.roleId || "").trim();
  if (!roleId) return [];
  try {
    const roleDir = roleDirForApi(roleId);
    const snapshot = roleKnowledgeSnapshotFromPublishedCatalog(roleDir, String(source.summary || ""), {
      roleId,
      archiveCompletedPlans: false,
      includePendingConsolidation: false
    });
    if (!snapshot) {
      requestRoleKnowledgeCatalogRefresh(roleDir);
      return [];
    }
    return snapshot.requiredReadItems
      .filter((item): item is typeof item & { type: "plan" | "recent_memory" | "consolidated_memory" } =>
        item.type === "plan" || item.type === "recent_memory" || item.type === "consolidated_memory")
      .map((item) => ({
        id: item.id,
        title: item.title,
        type: item.type,
        endpoint: item.endpoint,
        score: item.score,
        revisionAt: item.revisionAt
      }));
  } catch (error) {
    managerOperationalLog.record("warn", "message_knowledge_recall_failed", {
      action: roleId,
      error: managerOperationalError(error, rootDir)
    });
    return [];
  }
}

function wearableHealthMetrics(requestUrl: URL): WearableHealthMetric[] | undefined {
  const values = requestUrl.searchParams.getAll("metric")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value): value is WearableHealthMetric => (
      value === "heart_rate"
      || value === "sleep_session"
      || value === "sleep_stage"
      || value === "sleep_state"
    ));
  return values.length > 0 ? [...new Set(values)] : undefined;
}

function managerLifecycleFenceHeader(request: http.IncomingMessage, name: string): string {
  const value = request.headers[name];
  if (Array.isArray(value)) return value.length === 1 ? value[0]!.trim() : "";
  const normalized = String(value ?? "").trim();
  return normalized.includes(",") ? "" : normalized;
}

export type WearableHealthApiContext = Readonly<{
  roleDir?: (roleId: string) => string;
  ingest?: typeof ingestWearableHealthObservation;
  lifecycleFence?: Readonly<{
    applicationGenerationId: string;
    managerInstanceId: string;
  }> | null;
}>;

export function handleWearableHealthApi(
  request: http.IncomingMessage,
  pathname: string,
  response: http.ServerResponse,
  context: WearableHealthApiContext = {}
): boolean {
  const route = parseWearableHealthResourceRoute(pathname);
  if (!route) return false;
  try {
    const roleDir = (context.roleDir ?? roleDirForApi)(route.roleId);
    const requestUrl = new URL(request.url || pathname, "http://127.0.0.1");
    const sourceDeviceId = requestUrl.searchParams.get("sourceDeviceId")?.trim() || "";
    if (request.method === "GET" && route.resource === "config") {
      jsonResponse(response, 200, { code: 0, data: readWearableHealthConfig(roleDir) });
      return true;
    }
    if (request.method === "PATCH" && route.resource === "config") {
      void readJsonBody<{ defaultPolicy?: unknown; devices?: unknown }>(request)
        .then((body) => updateWearableHealthConfig(roleDir, body))
        .then((data) => jsonResponse(response, 200, { code: 0, data }))
        .catch((error) => jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
      return true;
    }
    if (request.method === "GET" && route.resource === "state") {
      jsonResponse(response, 200, { code: 0, data: currentWearableHealthState(roleDir, sourceDeviceId) });
      return true;
    }
    if (request.method === "GET" && route.resource === "history") {
      const limit = Number(requestUrl.searchParams.get("limit"));
      jsonResponse(response, 200, {
        code: 0,
        data: queryWearableHealthHistory(roleDir, {
          metrics: wearableHealthMetrics(requestUrl),
          sourceDeviceId,
          from: requestUrl.searchParams.get("from") || undefined,
          to: requestUrl.searchParams.get("to") || undefined,
          limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
          order: requestUrl.searchParams.get("order") === "asc" ? "asc" : "desc"
        })
      });
      return true;
    }
    if (request.method === "GET" && route.resource === "summary") {
      const limit = Number(requestUrl.searchParams.get("limit"));
      jsonResponse(response, 200, {
        code: 0,
        data: summarizeWearableHealth(roleDir, {
          sourceDeviceId,
          from: requestUrl.searchParams.get("from") || undefined,
          to: requestUrl.searchParams.get("to") || undefined,
          limit: Number.isFinite(limit) && limit > 0 ? limit : undefined
        })
      });
      return true;
    }
    if (request.method === "POST" && route.resource === "observations") {
      const lifecycleFence = context.lifecycleFence === undefined
        ? managerHostIdentity
          ? Object.freeze({
            applicationGenerationId: managerHostIdentity.applicationGenerationId,
            managerInstanceId
          })
          : null
        : context.lifecycleFence;
      if (!lifecycleFence) {
        jsonResponse(response, 503, {
          code: -1,
          state: "host_generation_unavailable",
          message: "Wearable observations require a Host-owned Manager generation."
        });
        return true;
      }
      const expectedApplicationGenerationId = managerLifecycleFenceHeader(
        request,
        "x-rabiroute-expected-application-generation-id"
      );
      const expectedManagerInstanceId = managerLifecycleFenceHeader(
        request,
        "x-rabiroute-expected-manager-instance-id"
      );
      if (!expectedApplicationGenerationId || !expectedManagerInstanceId) {
        jsonResponse(response, 400, {
          code: -1,
          state: "invalid_lifecycle_fence",
          message: "Wearable observations require complete Manager lifecycle fencing headers."
        });
        return true;
      }
      if (expectedApplicationGenerationId !== lifecycleFence.applicationGenerationId
        || expectedManagerInstanceId !== lifecycleFence.managerInstanceId) {
        jsonResponse(response, 409, {
          code: -1,
          state: "stale_lifecycle_fence",
          message: "Wearable observation lifecycle identity is stale."
        });
        return true;
      }
      const deliverAlerts = ["1", "true", "yes"].includes(
        (requestUrl.searchParams.get("deliverAlerts") || "").trim().toLowerCase()
      );
      void readJsonBody<Record<string, unknown>>(request)
        .then(async (body) => {
          const nested = body.health && typeof body.health === "object" && !Array.isArray(body.health)
            ? body.health as Record<string, unknown>
            : {};
          const observation = {
            ...body,
            ...nested,
            policy: nested.policy ?? body.policy,
            samples: nested.samples ?? body.samples
          } as WearableHealthObservationInput;
           const data = (context.ingest ?? ingestWearableHealthObservation)(roleDir, observation);
          if (!deliverAlerts || data.alerts.length === 0) return data;
          if (!Number.isInteger(managerPort) || managerPort < 1 || managerPort > 65535) {
            throw new Error("Manager listener is not ready.");
          }
          const deliveries = [];
          for (const alert of data.alerts) {
            const sourceSample = alert.sample;
            const results = await deliverWearableAlert(route.roleId, alert, {
              agentRoleId: route.roleId,
              managerPort,
              sourceDeviceId: sourceSample?.sourceDeviceId || data.state.sourceDeviceId,
              sourceDeviceName: sourceSample?.sourceDeviceName,
              sourceDeviceKind: sourceSample?.sourceDeviceKind,
              transport: sourceSample?.transport || "manager-local"
            });
            deliveries.push({
              alertId: alert.id,
              results
            });
          }
          return { ...data, delivery: { requested: true, results: deliveries } };
        })
        .then((data) => jsonResponse(response, 202, { code: 0, data }))
        .catch((error) => jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
      return true;
    }
    jsonResponse(response, 405, { code: -1, message: "Method not allowed." });
    return true;
  } catch (error) {
    jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) });
    return true;
  }
}

function handleRoleKnowledgeApi(
  request: http.IncomingMessage,
  pathname: string,
  response: http.ServerResponse,
  resolveRoleDir: (roleId: string) => string = roleDirForApi,
  resolveRoleStorageApplication: () => RoleStorageApplication = currentRoleStorageApplication
): boolean {
  if (handleWearableHealthApi(request, pathname, response)) return true;
  if (handlePersonaChatHistoryApi(request, new URL(request.url || pathname, "http://127.0.0.1"), response, resolveRoleDir)) return true;
  if (handlePersonaVoiceTranscriptApi(
    request,
    new URL(request.url || pathname, "http://127.0.0.1"),
    response,
    { roleDir: resolveRoleDir }
  )) return true;
  const conversationSituationsMatch = pathname.match(/^\/(?:api\/)?roles\/([^/]+)\/conversation-situations(?:\/([^/]+))?$/);
  if (conversationSituationsMatch) {
    const roleId = decodeURIComponent(conversationSituationsMatch[1]);
    const situationId = conversationSituationsMatch[2] ? decodeURIComponent(conversationSituationsMatch[2]) : "";
    try {
      const roleDir = resolveRoleDir(roleId);
      if (request.method !== "GET") {
        jsonResponse(response, 405, { code: -1, message: "Method not allowed." });
        return true;
      }
      const requestUrl = new URL(request.url || pathname, "http://127.0.0.1");
      const situations = listConversationSituations(roleDir, Number(requestUrl.searchParams.get("limit") || 20));
      const data = situationId ? situations.find(item => item.id === situationId) : situations;
      if (situationId && !data) {
        jsonResponse(response, 404, { code: -1, message: `Conversation situation not found: ${situationId}` });
        return true;
      }
      jsonResponse(response, 200, { code: 0, data });
      return true;
    } catch (error) {
      jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) });
      return true;
    }
  }
  const identityObservationMatch = pathname.match(/^\/(?:api\/)?roles\/([^/]+)\/identity-relations\/observations$/);
  if (identityObservationMatch) {
    const roleId = decodeURIComponent(identityObservationMatch[1]);
    if (request.method !== "POST") {
      jsonResponse(response, 405, { code: -1, message: "Method not allowed." });
      return true;
    }
    try {
      const roleDir = resolveRoleDir(roleId);
      void readJsonBody<IdentityCandidateObservation>(request)
        .then(body => recordIdentityCandidateObservation(roleDir, body))
        .then(data => {
          publishManagerEvent("identity_relation_changed", {
            roleId,
            kind: "candidate_observation",
            recordId: data.participant.id
          });
          jsonResponse(response, data.appended ? 201 : 200, { code: 0, data });
        })
        .catch(error => jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
      return true;
    } catch (error) {
      jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) });
      return true;
    }
  }
  const identityRelationsMatch = pathname.match(/^\/(?:api\/)?roles\/([^/]+)\/identity-relations$/);
  if (identityRelationsMatch) {
    const roleId = decodeURIComponent(identityRelationsMatch[1]);
    try {
      const roleDir = resolveRoleDir(roleId);
      if (request.method === "GET") {
        const requestUrl = new URL(request.url || pathname, "http://127.0.0.1");
        const platform = requestUrl.searchParams.get("platform")?.trim() || "";
        const endpointIdentityNamespace = requestUrl.searchParams.get("endpointIdentityNamespace")?.trim() || "";
        const senderStableId = requestUrl.searchParams.get("senderStableId")?.trim() || "";
        if (platform || endpointIdentityNamespace || senderStableId) {
          if (!platform || !endpointIdentityNamespace || !senderStableId) {
            throw new Error("platform, endpointIdentityNamespace, and senderStableId must be provided together.");
          }
          jsonResponse(response, 200, {
            code: 0,
            data: {
              path: "identity-relations/events.jsonl",
              context: resolveIdentityRelationContext(roleDir, { platform, endpointIdentityNamespace, senderStableId,
                conversationKey: requestUrl.searchParams.get("conversationKey")?.trim() || undefined,
                projectId: requestUrl.searchParams.get("projectId")?.trim() || undefined })
            }
          });
          return true;
        }
        jsonResponse(response, 200, {
          code: 0,
          data: {
            path: "identity-relations/events.jsonl",
            endpointAccounts: listIdentityEndpointAccounts(roleDir),
            participants: listIdentityParticipants(roleDir),
            relationCards: listIdentityRelationCards(roleDir)
          }
        });
        return true;
      }
      if (request.method === "PUT") {
        void readJsonBody<IdentityRelationPatch>(request)
          .then(body => ({ data: updateIdentityRelation(roleDir, body), kind: body.kind }))
          .then(({ data, kind }) => {
            publishManagerEvent("identity_relation_changed", { roleId, kind, recordId: data.record.id });
            jsonResponse(response, data.appended ? 201 : 200, { code: 0, data });
          })
          .catch(error => jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
        return true;
      }
      jsonResponse(response, 405, { code: -1, message: "Method not allowed." });
      return true;
    } catch (error) {
      jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) });
      return true;
    }
  }
  const voiceIdentityMatch = pathname.match(/^\/(?:api\/)?roles\/([^/]+)\/voice-identities$/);
  if (voiceIdentityMatch) {
    try {
      const roleDir = resolveRoleDir(decodeURIComponent(voiceIdentityMatch[1]));
      if (request.method === "GET") {
        const requestUrl = new URL(request.url || pathname, "http://127.0.0.1");
        const sourceHostId = requestUrl.searchParams.get("sourceHostId")?.trim() || "";
        const voiceprintId = requestUrl.searchParams.get("voiceprintId")?.trim() || "";
        if (sourceHostId || voiceprintId) {
          if (!sourceHostId || !voiceprintId) throw new Error("sourceHostId and voiceprintId must be provided together.");
          const identity = findPersonaVoiceIdentity(roleDir, sourceHostId, voiceprintId);
          if (!identity) {
            jsonResponse(response, 404, { code: -1, message: "Persona voice identity was not found." });
            return true;
          }
          jsonResponse(response, 200, { code: 0, data: { path: "voice/voice-identities.jsonl", identity } });
          return true;
        }
        jsonResponse(response, 200, {
          code: 0,
          data: { path: "voice/voice-identities.jsonl", identities: listPersonaVoiceIdentities(roleDir) }
        });
        return true;
      }
      if (request.method === "PUT") {
        void readJsonBody<PersonaVoiceIdentityPatch>(request)
          .then(body => {
            if (typeof body.sourceHostId !== "string" || !body.sourceHostId.trim()) {
              throw new Error("sourceHostId must be a non-empty string.");
            }
            if (typeof body.voiceprintId !== "string" || !body.voiceprintId.trim()) {
              throw new Error("voiceprintId must be a non-empty string.");
            }
            if (Object.prototype.hasOwnProperty.call(body, "participantId")
              && body.participantId !== null
              && typeof body.participantId !== "string") {
              throw new Error("participantId must be a string, null, or omitted.");
            }
            const hasParticipantPatch = Object.prototype.hasOwnProperty.call(body, "participantId");
            const participantId = typeof body.participantId === "string" ? body.participantId.trim() : "";
            let participantStatus: "confirmed" | "corrected" = "confirmed";
            if (participantId) {
              const participant = listIdentityParticipants(roleDir).find(item => item.id === participantId);
              if (!participant || participant.conflicted || !["confirmed", "corrected"].includes(participant.status)) {
                throw new Error("participantId must reference a confirmed identity in the current persona.");
              }
              participantStatus = participant.status as "confirmed" | "corrected";
            }
            let identityRelationResult: ReturnType<typeof updateIdentityRelation> | undefined;
            if (hasParticipantPatch) {
              const sourceHostId = body.sourceHostId.trim();
              const voiceprintId = body.voiceprintId.trim();
              const endpointIdentityNamespace = `host:${sourceHostId}`;
              const existingAccount = listIdentityEndpointAccounts(roleDir).find(item =>
                item.platform === "voice"
                && item.endpointIdentityNamespace === endpointIdentityNamespace
                && item.senderStableId === voiceprintId
              );
              const retiredPreviousLinks = existingAccount?.participantLinks
                .filter(link => link.participantId !== participantId)
                .map(link => ({ ...link, status: "retired" as const })) ?? [];
              const participantLinks = participantId
                ? [
                    ...retiredPreviousLinks,
                    {
                      participantId,
                      status: participantStatus,
                      confidence: 1,
                      evidenceRefs: [{ note: "人格通过声纹确认界面显式关联到身份。" }]
                    }
                  ]
                : existingAccount?.participantLinks.map(link => ({ ...link, status: "retired" as const })) ?? [];
              if (participantId || existingAccount) {
                identityRelationResult = updateIdentityRelation(roleDir, {
                  kind: "endpoint_account",
                  platform: "voice",
                  endpointIdentityNamespace,
                  senderStableId: voiceprintId,
                  displayName: typeof body.displayName === "string" ? body.displayName.trim() : existingAccount?.displayName,
                  participantLinks
                });
              }
            }
            return { data: updatePersonaVoiceIdentity(roleDir, body), identityRelationResult };
          })
          .then(({ data, identityRelationResult }) => {
            if (identityRelationResult) {
              publishManagerEvent("identity_relation_changed", {
                roleId: decodeURIComponent(voiceIdentityMatch[1]),
                kind: "endpoint_account",
                recordId: identityRelationResult.record.id
              });
            }
            publishManagerEvent("persona_voice_identity_changed", {
              roleId: decodeURIComponent(voiceIdentityMatch[1]),
              appended: data.appended,
              deleted: data.deleted
            });
            jsonResponse(response, data.appended ? 201 : 200, { code: 0, data });
          })
          .catch(error => jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
        return true;
      }
      jsonResponse(response, 405, { code: -1, message: "Method not allowed." });
      return true;
    } catch (error) {
      jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) });
      return true;
    }
  }
  const validationMatch = pathname.match(/^\/(?:api\/)?roles\/([^/]+)\/knowledge-validation$/);
  if (validationMatch) {
    const roleId = decodeURIComponent(validationMatch[1]);
    try {
      if (request.method !== "GET") {
        jsonResponse(response, 405, { code: -1, message: "Method not allowed." });
        return true;
      }
      const roleDir = resolveRoleDir(roleId);
      const validation = validatePublishedRoleKnowledge(roleDir);
      if (!validation) {
        requestRoleKnowledgeCatalogRefresh(roleDir);
        roleKnowledgeCacheUnavailable(response, roleId);
        return true;
      }
      jsonResponse(response, 200, { code: 0, data: validation });
      return true;
    } catch (error) {
      jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) });
      return true;
    }
  }

  const planHistoryMatch = pathname.match(/^\/(?:api\/)?roles\/([^/]+)\/plans\/([^/]+)\/history$/);
  if (planHistoryMatch) {
    const roleId = sanitizeRoleId(decodeURIComponent(planHistoryMatch[1]));
    const planId = decodeURIComponent(planHistoryMatch[2]);
    try {
      if (!roleId) throw new Error("Missing role id.");
      if (request.method !== "GET") {
        jsonResponse(response, 405, { code: -1, message: "Method not allowed." });
        return true;
      }
      const roleDir = resolveRoleDir(roleId);
      void managerCatalogWorkerPool.run<{ plan: PlanItem; records: unknown[] } | null>({
        type: "role_plan_history",
        roleDir,
        planId
      }).then((data) => {
        if (!data) {
          jsonResponse(response, 404, { code: -1, message: `Plan not found: ${planId}` });
          return;
        }
        jsonResponse(response, 200, { code: 0, data: { count: data.records.length, records: data.records } });
      }).catch((error) => jsonResponse(response, error instanceof ManagerReadWorkerError && error.code === "busy" ? 503 : 500, {
        code: -1,
        message: error instanceof Error ? error.message : String(error)
      }));
      return true;
    } catch (error) {
      jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) });
      return true;
    }
  }

  const planFeedbackMatch = pathname.match(/^\/(?:api\/)?roles\/([^/]+)\/plans\/([^/]+)\/feedback$/);
  if (planFeedbackMatch) {
    const roleId = sanitizeRoleId(decodeURIComponent(planFeedbackMatch[1]));
    try {
      if (!roleId) throw new Error("Missing role id.");
      const planId = canonicalLogicalPlanId(decodeURIComponent(planFeedbackMatch[2]));
      const roleDir = resolveRoleDir(roleId);
      if (request.method === "GET") {
        void resolveRoleStorageApplication().queries.planFeedback(roleId, planId).then((data) => {
          if (!data) {
            jsonResponse(response, 404, { code: -1, message: `Plan not found: ${planId}` });
            return;
          }
          response.setHeader("etag", `"${data.planRevision}"`);
          jsonResponse(response, 200, {
            code: 0,
            data: { count: data.records.length, latest: data.records[0], records: data.records }
          });
        }).catch((error) => respondRoleStorageError(response, error));
        return true;
      }
      if (request.method === "POST") {
        const context = roleStorageRequestContext(request, response);
        void readRoleStorageJsonBody<PlanFeedbackRequest>(request, PLAN_FEEDBACK_REQUEST_MAX_BYTES)
          .then(async (body) => ({
            body,
            committed: await resolveRoleStorageApplication().commands.submitPlanFeedback(roleId, planId, {
              feedbackId: body.feedbackId,
              stepId: body.stepId,
              gatewayId: body.gatewayId,
              kind: body.kind,
              author: body.author,
              source: body.source,
              text: body.text,
              notifyAgent: body.notifyAgent,
              planAttachmentIds: body.planAttachmentIds,
              attachments: body.attachments
            }, context)
          }))
          .then(({ body, committed }) => {
            const { record, created, plan: currentPlan } = committed.commit;
            try {
              schedulePlanFeedbackPostCommit(
                roleDir,
                roleId,
                String(body.gatewayId || record.gatewayId || "").trim(),
                currentPlan,
                record,
                resolveRoleStorageApplication()
              );
              if (created) publishManagerEvent("plan_feedback_changed", { roleId, planId, feedbackId: record.id });
            } catch (error) {
              managerOperationalLog.record("warn", "plan_feedback_post_commit_schedule_failed", {
                action: `${roleId}:${planId}:${record.id}`,
                error: managerOperationalError(error, rootDir)
              });
            }
            respondRoleStorageCommit(response, 202, committed.operationId, record, committed.projection.planRevision);
          })
          .catch((error) => respondRoleStorageError(response, error));
        return true;
      }
      jsonResponse(response, 405, { code: -1, message: "Method not allowed." });
      return true;
    } catch (error) {
      jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) });
      return true;
    }
  }

  const consolidationResultMatch = pathname.match(/^\/(?:api\/)?roles\/([^/]+)\/memory\/consolidation-runs\/([^/]+)\/result$/);
  if (consolidationResultMatch) {
    const roleId = decodeURIComponent(consolidationResultMatch[1]);
    const runId = decodeURIComponent(consolidationResultMatch[2]);
    try {
      if (request.method === "POST") {
        const context = roleStorageRequestContext(request, response);
        void readRoleStorageJsonBody<Record<string, unknown>>(request)
          .then((body) => resolveRoleStorageApplication().commands.applyMemoryConsolidation(roleId, runId, body, context))
          .then((committed) => {
            memoryConsolidationScheduler?.noteRunCompleted(runId);
            memoryConsolidationScheduler?.reschedule();
            publishManagerEvent("memory_consolidation_changed", { roleId, runId, status: "completed" });
            respondRoleStorageCommit(response, 200, committed.operationId, committed.commit, committed.projection?.revision);
          })
          .catch((error) => respondRoleStorageError(response, error));
        return true;
      }
      jsonResponse(response, 405, { code: -1, message: "Method not allowed." });
      return true;
    } catch (error) {
      jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) });
      return true;
    }
  }

  const route = parseRoleKnowledgeResourceRoute(pathname);
  if (!route) {
    return false;
  }

  const { roleId, resource, itemId } = route;

  try {
    const roleDir = resolveRoleDir(roleId);
    if (request.method === "GET" && resource === "counts") {
      void managerCatalogWorkerPool.run({ type: "role_knowledge_file_counts", roleDir })
        .then((data) => jsonResponse(response, 200, { code: 0, data }))
        .catch((error) => jsonResponse(response, error instanceof ManagerReadWorkerError && error.code === "busy" ? 503 : 500, {
          code: -1,
          message: error instanceof Error ? error.message : String(error)
        }));
      return true;
    }
    if (request.method === "GET" && resource === "plans") {
      const requestUrl = new URL(request.url || pathname, "http://127.0.0.1");
      const wantsPage = !itemId && requestUrl.searchParams.has("limit");
      const wantsSummary = wantsPage && requestUrl.searchParams.get("detail") === "summary";
      if (itemId) {
        void resolveRoleStorageApplication().queries.plan(roleId, itemId).then((result) => {
          if (!result) {
            jsonResponse(response, 404, { code: -1, message: `Plan not found: ${itemId}` });
            return;
          }
          response.setHeader("etag", `"${result.revision}"`);
          const detail = requestUrl.searchParams.get("detail")?.trim();
          const data = detail === "preview"
            ? { ...previewRolePlan(presentPlan(result.plan, ensurePersonaPlanWorkflow(roleDir).workflow)), approval: result.approval }
            : { ...presentPlan(result.plan, ensurePersonaPlanWorkflow(roleDir).workflow), approval: result.approval };
          jsonResponse(response, 200, { code: 0, data });
        }).catch((error) => respondRoleStorageError(response, error));
        return true;
      }
      const requestedView = requestUrl.searchParams.get("view")?.trim() || undefined;
      if (requestedView && !["current", "plans", "archived"].includes(requestedView)) {
        throw new Error("Invalid plan page view.");
      }
      const requestedSort = requestUrl.searchParams.get("sort")?.trim() || "status";
      if (!["status", "updated", "importance", "urgency"].includes(requestedSort)) {
        throw new Error("Invalid plan page sort.");
      }
      if (wantsPage) {
        void managerKnowledgePageWorkerPool.queryRolePlanPage(roleDir, {
          cursor: requestUrl.searchParams.get("cursor")?.trim() || "",
          limit: normalizeRolePlanPageLimit(requestUrl.searchParams.get("limit")),
          view: requestedView as "current" | "plans" | "archived" | undefined,
          query: requestUrl.searchParams.get("query") || "",
          sort: requestedSort as "status" | "updated" | "importance" | "urgency",
          statuses: requestUrl.searchParams.getAll("status").map((value) => value.trim()).filter(Boolean),
          tags: requestUrl.searchParams.getAll("tag").map((value) => value.trim()).filter(Boolean),
          includeFacets: requestUrl.searchParams.get("facets") !== "0",
          summary: wantsSummary
        })
          .then((data) => jsonResponse(response, 200, { code: 0, data }))
          .catch((error) => jsonResponse(response, error instanceof ManagerReadWorkerError && error.code === "busy" ? 503 : 500, {
            code: -1,
            message: error instanceof Error ? error.message : String(error)
          }));
        return true;
      }
      void managerCatalogWorkerPool.queryRolePlanCatalog(roleDir)
        .then(({ plans, approvalByPlanId }) => {
          const data = presentPlans(plans, ensurePersonaPlanWorkflow(roleDir).workflow).map((plan) => ({
              ...plan,
              approval: approvalByPlanId[plan.id]
            }));
          jsonResponse(response, 200, { code: 0, data });
        })
        .catch((error) => jsonResponse(response, error instanceof ManagerReadWorkerError && error.code === "busy" ? 503 : 500, {
          code: -1,
          message: error instanceof Error ? error.message : String(error)
        }));
      return true;
    }
    if (resource === "plan-statuses") {
      if (request.method === "GET" && !itemId) {
        void resolveRoleStorageApplication().queries.planWorkflow(roleId).then((data) => {
          if (!data) {
            jsonResponse(response, 404, { code: -1, message: `Plan status catalog not found for role: ${roleId}` });
            return;
          }
          response.setHeader("etag", `"${data.revision}"`);
          jsonResponse(response, 200, { code: 0, data: { ...data.workflow, revision: data.revision } });
        }).catch((error) => respondRoleStorageError(response, error));
        return true;
      }
      if (request.method === "POST" && !itemId) {
        const context = roleStorageRequestContext(request, response);
        void readRoleStorageJsonBody<Record<string, unknown>>(request)
          .then((body) => resolveRoleStorageApplication().commands.createPlanStatus(roleId, body, context))
          .then((committed) => {
            publishManagerEvent("plan_status_catalog_changed", { roleId, statusKey: committed.commit.status.key, action: "created" });
            respondRoleStorageCommit(response, 201, committed.operationId, committed.commit, committed.projection.revision);
          })
          .catch((error) => respondRoleStorageError(response, error));
        return true;
      }
      if (request.method === "PATCH" && itemId) {
        const context = roleStorageRequestContext(request, response);
        void readRoleStorageJsonBody<Record<string, unknown>>(request)
          .then((body) => resolveRoleStorageApplication().commands.updatePlanStatus(roleId, itemId, body, context))
          .then((committed) => {
            publishManagerEvent("plan_status_catalog_changed", { roleId, statusKey: committed.commit.status.key, action: "updated" });
            respondRoleStorageCommit(response, 200, committed.operationId, committed.commit, committed.projection.revision);
          })
          .catch((error) => respondRoleStorageError(response, error));
        return true;
      }
      if (request.method === "DELETE" && itemId) {
        const context = roleStorageRequestContext(request, response);
        void readRoleStorageJsonBody<{ replacementKey?: unknown }>(request)
          .then((body) => resolveRoleStorageApplication().commands.deletePlanStatus(
            roleId,
            itemId,
            typeof body.replacementKey === "string" ? body.replacementKey : "",
            context
          ))
          .then((committed) => {
            publishManagerEvent("plan_status_catalog_changed", {
              roleId,
              statusKey: committed.commit.status.key,
              action: "retired",
              migratedPlanIds: committed.commit.migratedPlanIds
            });
            respondRoleStorageCommit(response, 200, committed.operationId, committed.commit, committed.projection.revision);
          })
          .catch((error) => respondRoleStorageError(response, error));
        return true;
      }
      jsonResponse(response, 405, { code: -1, message: "Method not allowed." });
      return true;
    }
    if (request.method === "GET" && resource === "skills") {
      void managerCatalogWorkerPool.run({ type: "role_skill_catalog", roleDir, ...(itemId ? { skillId: itemId } : {}) })
        .then((data) => {
          if (itemId && !data) {
            jsonResponse(response, 404, { code: -1, message: `Skill not found: ${itemId}` });
            return;
          }
          jsonResponse(response, 200, { code: 0, data });
        })
        .catch((error) => jsonResponse(response, error instanceof ManagerReadWorkerError && error.code === "busy" ? 503 : 500, {
          code: -1,
          message: error instanceof Error ? error.message : String(error)
        }));
      return true;
    }
    if (request.method === "GET" && resource === "memory" && !itemId) {
      const requestUrl = new URL(request.url || pathname, "http://127.0.0.1");
      if (requestUrl.searchParams.get("counts") === "1") {
        void managerKnowledgePageWorkerPool.queryRoleMemoryCounts(roleDir)
          .then((data) => jsonResponse(response, 200, { code: 0, data }))
          .catch((error) => jsonResponse(response, error instanceof ManagerReadWorkerError && error.code === "busy" ? 503 : 500, {
            code: -1,
            message: error instanceof Error ? error.message : String(error)
          }));
        return true;
      }
      if (requestUrl.searchParams.has("limit")) {
        const kind = requestUrl.searchParams.get("kind")?.trim() || "recent";
        if (kind !== "recent" && kind !== "consolidated" && kind !== "archived") {
          throw new Error("Invalid memory page kind.");
        }
        void managerKnowledgePageWorkerPool.queryRoleMemoryPage(roleDir, {
          kind,
          cursor: requestUrl.searchParams.get("cursor")?.trim() || "",
          limit: normalizeRoleMemoryPageLimit(requestUrl.searchParams.get("limit")),
          query: requestUrl.searchParams.get("query") || ""
        })
          .then((data) => jsonResponse(response, 200, { code: 0, data }))
          .catch((error) => jsonResponse(response, error instanceof ManagerReadWorkerError && error.code === "busy" ? 503 : 500, {
            code: -1,
            message: error instanceof Error ? error.message : String(error)
          }));
        return true;
      }
      void managerKnowledgePageWorkerPool.queryRoleMemoryOverview(roleDir)
        .then((data) => jsonResponse(response, 200, { code: 0, data }))
        .catch((error) => jsonResponse(response, error instanceof ManagerReadWorkerError && error.code === "busy" ? 503 : 500, {
          code: -1,
          message: error instanceof Error ? error.message : String(error)
        }));
      return true;
    }
    if (request.method === "POST" && resource === "plans" && !itemId) {
      const context = roleStorageRequestContext(request, response);
      void readRoleStorageJsonBody<Record<string, unknown>>(request, PLAN_ATTACHMENT_REQUEST_MAX_BYTES)
        .then((body) => resolveRoleStorageApplication().commands.createPlan(roleId, body, context))
        .then((committed) => respondRoleStorageCommit(
          response,
          201,
          committed.operationId,
          { ...presentPlan(committed.projection.plan, ensurePersonaPlanWorkflow(roleDir).workflow), approval: committed.projection.approval },
          committed.projection.revision
        ))
        .catch((error) => respondRoleStorageError(response, error));
      return true;
    }
    if (request.method === "PATCH" && resource === "plans" && itemId) {
      const context = roleStorageRequestContext(request, response);
      void readRoleStorageJsonBody<Record<string, unknown>>(request, PLAN_ATTACHMENT_REQUEST_MAX_BYTES)
        .then((body) => resolveRoleStorageApplication().commands.updatePlan(roleId, itemId, body, context))
        .then((committed) => respondRoleStorageCommit(
          response,
          200,
          committed.operationId,
          { ...presentPlan(committed.projection.plan, ensurePersonaPlanWorkflow(roleDir).workflow), approval: committed.projection.approval },
          committed.projection.revision
        ))
        .catch((error) => respondRoleStorageError(response, error));
      return true;
    }
    if (request.method === "GET" && resource === "memory/recent") {
      if (itemId) {
        if (managerReadOnly) {
          void managerReadWorkerPool.queryRecentMemoryDetail(roleDir, itemId)
            .then((data) => {
              if (!data) {
                jsonResponse(response, 404, { code: -1, message: `Memory not found: ${itemId}` });
                return;
              }
              jsonResponse(response, 200, { code: 0, data });
            })
            .catch((error) => jsonResponse(response, error instanceof ManagerReadWorkerError && error.code === "busy" ? 503 : 500, {
              code: -1,
              message: error instanceof Error ? error.message : String(error)
            }));
          return true;
        }
        const context = roleStorageRequestContext(request, response);
        void resolveRoleStorageApplication().commands.touchRecentMemory(roleId, itemId, context)
          .then((committed) => respondRoleStorageCommit(
            response,
            200,
            committed.operationId,
            committed.projection.memory,
            committed.projection.revision
          ))
          .catch((error) => respondRoleStorageError(response, error));
        return true;
      }
      void managerReadWorkerPool.queryRoleMemoryCatalog(roleDir, "recent", itemId)
        .then((data) => {
          if (itemId && !data) {
            jsonResponse(response, 404, { code: -1, message: `Memory not found: ${itemId}` });
            return;
          }
          jsonResponse(response, 200, { code: 0, data });
        })
        .catch((error) => jsonResponse(response, error instanceof ManagerReadWorkerError && error.code === "busy" ? 503 : 500, {
          code: -1,
          message: error instanceof Error ? error.message : String(error)
        }));
      return true;
    }
    if (request.method === "GET" && resource === "memory/consolidated") {
      void managerReadWorkerPool.queryRoleMemoryCatalog(roleDir, "consolidated", itemId)
        .then((data) => {
          if (itemId && !data) {
            jsonResponse(response, 404, { code: -1, message: `Consolidated memory not found: ${itemId}` });
            return;
          }
          jsonResponse(response, 200, { code: 0, data });
        })
        .catch((error) => jsonResponse(response, error instanceof ManagerReadWorkerError && error.code === "busy" ? 503 : 500, {
          code: -1,
          message: error instanceof Error ? error.message : String(error)
        }));
      return true;
    }
    if (request.method === "POST" && resource === "memory/recent" && !itemId) {
      const context = roleStorageRequestContext(request, response);
      void readRoleStorageJsonBody<Record<string, unknown>>(request)
        .then((body) => resolveRoleStorageApplication().commands.createRecentMemory(roleId, body, context))
        .then((committed) => {
          memoryConsolidationScheduler?.reschedule();
          respondRoleStorageCommit(response, 201, committed.operationId, committed.projection.memory, committed.projection.revision);
        })
        .catch((error) => respondRoleStorageError(response, error));
      return true;
    }
    if (request.method === "PATCH" && resource === "memory/recent" && itemId) {
      const context = roleStorageRequestContext(request, response);
      void readRoleStorageJsonBody<Record<string, unknown>>(request)
        .then((body) => resolveRoleStorageApplication().commands.updateRecentMemory(roleId, itemId, body, context))
        .then((committed) => {
          memoryConsolidationScheduler?.reschedule();
          respondRoleStorageCommit(response, 200, committed.operationId, committed.projection.memory, committed.projection.revision);
        })
        .catch((error) => respondRoleStorageError(response, error));
      return true;
    }
    if (request.method === "GET" && resource === "memory/consolidation-runs") {
      if (itemId) {
        void resolveRoleStorageApplication().queries.consolidationRun(roleId, itemId)
          .then((data) => {
            if (!data) {
              jsonResponse(response, 404, { code: -1, message: `Consolidation run not found: ${itemId}` });
              return;
            }
            response.setHeader("etag", `"${data.revision}"`);
            jsonResponse(response, 200, { code: 0, data: data.run });
          })
          .catch((error) => respondRoleStorageError(response, error));
        return true;
      }
      void managerCatalogWorkerPool.run({
        type: "role_consolidation_runs",
        roleDir
      }).then((data) => {
        jsonResponse(response, 200, { code: 0, data });
      }).catch((error) => jsonResponse(response, error instanceof ManagerReadWorkerError && error.code === "busy" ? 503 : 500, {
        code: -1,
        message: error instanceof Error ? error.message : String(error)
      }));
      return true;
    }
    if (request.method === "POST" && resource === "memory/consolidation-requests" && !itemId) {
      const context = roleStorageRequestContext(request, response);
      void readRoleStorageJsonBody<Record<string, unknown>>(request)
        .then((body) => resolveRoleStorageApplication().commands.requestMemoryConsolidation(roleId, {
          triggerSource: body.triggerSource === "auto" ? "auto" : "api",
          includeOlderThanHours: typeof body.includeOlderThanHours === "number" ? body.includeOlderThanHours : undefined,
          triggerOlderThanHours: typeof body.triggerOlderThanHours === "number" ? body.triggerOlderThanHours : undefined,
          force: body.force === true
        }, context))
        .then((committed) => respondRoleStorageCommit(
          response,
          201,
          committed.operationId,
          committed.commit,
          committed.projection?.revision
        ))
        .catch((error) => respondRoleStorageError(response, error));
      return true;
    }
    jsonResponse(response, 405, { code: -1, message: "Method not allowed." });
    return true;
  } catch (error) {
    jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) });
    return true;
  }
}

let gatewayDiagnosticsSnapshotService: GatewayDiagnosticsSnapshotService | undefined;

function activeGatewayDiagnosticsSnapshotService(): GatewayDiagnosticsSnapshotService {
  gatewayDiagnosticsSnapshotService ??= new GatewayDiagnosticsSnapshotService({
    capture: () => captureGatewayDiagnosticsWorkerInput(
      runtimes.values(),
      gatewayId => agentStateByGateway.get(gatewayId),
      routeCatalogPersonas()
    ),
    minRefreshIntervalMs: 5_000,
    timeoutMs: 60_000,
    load: (input, options) => managerCatalogWorkerPool.run<GatewayDiagnosticsWorkerResult>({
      type: "gateway_diagnostics_snapshot",
      input
    }, options)
  });
  return gatewayDiagnosticsSnapshotService;
}

function standaloneGatewayPayload(
  includeDiagnostics = true,
  includeConfigDefinitions = includeDiagnostics
): Record<string, unknown> {
  const snapshotService = activeGatewayDiagnosticsSnapshotService();
  snapshotService.requestRefresh();
  const snapshot = snapshotService.read(includeDiagnostics);
  return measureSyncPerformanceOperation(
    includeDiagnostics
      ? PERFORMANCE_OPERATIONS.managerGatewaysBuildDiagnostics
      : PERFORMANCE_OPERATIONS.managerGatewaysBuildSummary,
    () => {
      const cachedById = new Map(snapshot.records.map(record => [String(record.id ?? ""), record]));
      const payload = buildStandaloneGatewayPayload(
        {
          runtimes: runtimes.values(),
          runtimeStatus: runtime => memoryOnlyGatewayRuntimeStatus(
            rootDir,
            runtime,
            cachedById.get(runtime.definition.id)
          ),
          routeDir: path.relative(rootDir, routeRoot).replace(/\\/g, "/"),
          rolesDir: path.relative(rootDir, rolesRoot).replace(/\\/g, "/")
        },
        { includeConfigDefinitions }
      );
      const data = payload.data as Record<string, unknown>;
      return {
        ...payload,
        data: {
          ...data,
          diagnosticsSnapshot: {
            revision: snapshot.revision,
            state: snapshot.state,
            refreshedAt: snapshot.refreshedAt,
            refreshStartedAt: snapshot.refreshStartedAt
          }
        }
      };
    }
  );
}

function localIpv4AddressEntries(): Array<{ name: string; address: string; cidr?: string }> {
  return Object.entries(os.networkInterfaces())
    .flatMap(([name, addresses]) => (addresses ?? [])
      .filter((address) => address.family === "IPv4" && !address.internal)
      .map((address) => ({
        name,
        address: address.address,
        cidr: address.cidr || undefined
      })))
    .sort((left, right) => lanAddressPriority(left.name, left.address) - lanAddressPriority(right.name, right.address)
      || left.name.localeCompare(right.name)
      || left.address.localeCompare(right.address));
}

function networkOptionsPayload(): Record<string, unknown> {
  const localAddresses = localIpv4AddressEntries();
  const adapters = {
    napcat: {
      httpServers: [],
      websocketClients: []
    },
    webhook: {
      listeners: []
    },
    heartbeat: {},
    disabled: {}
  };
  return {
    code: 0,
    data: {
      adapters,
      localAddresses,
      httpServers: [],
      websocketClients: []
    }
  };
}

type WebguiLanAccessPatch = {
  enabled?: boolean;
  regenerateToken?: boolean;
};

function publicWebguiLanAccessPayload(request: http.IncomingMessage): Record<string, unknown> {
  const config = rabiGlobalConfig.read().webguiLan;
  const addresses = localIpv4AddressEntries();
  const canManage = isLocalMachineRemoteAddress(request.socket.remoteAddress, addresses.map(item => item.address));
  const listeningOnLan = managerListensOnLan(managerHost);
  const restartRequired = !managerHostOverride && config.enabled !== listeningOnLan;
  const token = canManage ? config.accessToken : "";
  const urls = addresses.map(({ name, address, cidr }) => ({
    name,
    address,
    cidr,
    url: token
      ? `http://${address}:${managerPort}/#/overview?webgui_token=${encodeURIComponent(token)}`
      : `http://${address}:${managerPort}/#/overview`
  }));
  return {
    code: 0,
    data: {
      enabled: config.enabled,
      tokenConfigured: Boolean(config.accessToken),
      token,
      canManage,
      managerHost,
      managerPort,
      listeningOnLan,
      restartRequired,
      hostManagedByEnvironment: Boolean(managerHostOverride),
      urls
    }
  };
}

function handleWebguiLanAccessApi(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse
): boolean {
  if (requestUrl.pathname !== "/api/webgui-access") return false;
  if (request.method === "GET") {
    jsonResponse(response, 200, publicWebguiLanAccessPayload(request));
    return true;
  }
  if (request.method !== "PATCH" && request.method !== "POST") {
    jsonResponse(response, 405, { code: -1, message: "Method not allowed" });
    return true;
  }
  if (!isLocalMachineRemoteAddress(request.socket.remoteAddress, localIpv4AddressEntries().map(item => item.address))) {
    jsonResponse(response, 403, {
      code: -1,
      message: "局域网 WebGUI 的开关和访问密钥只能在运行 Manager 的 Rabi PC 本机管理。"
    });
    return true;
  }
  void readJsonBody<WebguiLanAccessPatch>(request)
    .then((body) => {
      const current = rabiGlobalConfig.read().webguiLan;
      const enabled = typeof body.enabled === "boolean" ? body.enabled : current.enabled;
      const accessToken = body.regenerateToken === true || (enabled && !current.accessToken)
        ? generateWebguiAccessToken()
        : current.accessToken;
      rabiGlobalConfig.patch({ webguiLan: { enabled, accessToken } });
      return publicWebguiLanAccessPayload(request);
    })
    .then((payload) => jsonResponse(response, 200, payload))
    .catch((error) => jsonResponse(response, 400, {
      code: -1,
      message: error instanceof Error ? error.message : String(error)
    }));
  return true;
}

function managerHealthPayload(): Record<string, unknown> {
  const pluginGeneration = managerPluginGenerationStatus;
  const pluginReadiness = pluginGeneration?.readiness ?? {
    state: "degraded" as const,
    missingCapabilities: ["plugin-kernel-not-ready"]
  };
  const requiredRoutes = runtimes.values().filter(runtime =>
    runtime.definition.enabled === true
    && sharedGatewayMessageAdapterTypes(runtime.definition).length > 0
  );
  const routeCatalogStartup = routeCatalogStartupStatus();
  const routeLifecycle = {
    catalog: routeCatalogStartup,
    required: requiredRoutes.length,
    ready: requiredRoutes.filter(runtime => runtime.readiness === "ready").length,
    starting: requiredRoutes.filter(runtime => runtime.readiness === "starting").length,
    blocked: requiredRoutes.filter(runtime => runtime.readiness === "blocked").map(runtime => runtime.definition.id),
    failed: requiredRoutes.filter(runtime => runtime.readiness === "failed").map(runtime => runtime.definition.id)
  };
  const routesReady = routeCatalogStartup.state === "ready"
    && routeLifecycle.ready === routeLifecycle.required;
  const planStorageStartupSnapshot = planStorageStartupStatus();
  const planStorageStartup = publicPlanStorageStartupSnapshot(planStorageStartupSnapshot);
  const operationalLog = managerOperationalLog.status();
  const backgroundLifecycle = {
    planStorageStartup,
    routeCatalog: routeCatalogStartup,
    memoryConsolidation: memoryConsolidationScheduler?.failureSummary() ?? { backoff: 0, incidents: 0 },
    planFeedbackRecovery: planFeedbackRecoveryService?.failureSummary() ?? { backoff: 0, incidents: 0 },
    operationalLog,
    configWatch: publicManagerWatchBrokerStatus(configWatchLifecycle),
    pluginPackageWatch: publicManagerWatchBrokerStatus(pluginPackageWatchLifecycle)
  };
  const watchIncidentCount = [configWatchLifecycle, pluginPackageWatchLifecycle]
    .filter(status => status.state === "degraded" || status.partial)
    .length;
  const backgroundIncidentCount = backgroundLifecycle.memoryConsolidation.incidents
    + backgroundLifecycle.planFeedbackRecovery.incidents
    + planStorageStartupSnapshot.incidents
    + (routeCatalogStartup.state === "degraded" ? routeCatalogStartup.incidents : 0)
    + (operationalLog.state === "degraded" ? 1 : 0)
    + watchIncidentCount;
  return {
    protocolVersion: 1,
    applicationGenerationId: managerHostIdentity?.applicationGenerationId,
    managerInstanceId: managerInstanceId || undefined,
    managerBaseUrl: managerBaseUrl || undefined,
    health: buildManagerHealthSnapshot({
      pluginReadiness,
      planStorageReady: planStorageStartupSnapshot.state === "ready",
      routesReady,
      routeReadyCount: routeLifecycle.ready,
      routeRequiredCount: routeLifecycle.required,
      blockedRouteIds: routeLifecycle.blocked,
      failedRouteIds: routeLifecycle.failed,
      backgroundIncidentCount
    }),
    pluginReadiness,
    routeLifecycle,
    backgroundLifecycle
  };
}

function metaPayload(): Record<string, unknown> {
  const version = rabiRoutePackageVersion();
  const globalConfig = rabiGlobalConfig.read();
  const healthPayload = managerHealthPayload();
  const pluginGeneration = managerPluginGenerationStatus;
  return {
    version,
    health: healthPayload.health,
    githubUrl: "https://github.com/vb2250158/RabiRoute",
    applicationGenerationId: managerHostIdentity?.applicationGenerationId,
    managerInstanceId: managerInstanceId || undefined,
    managerBaseUrl: managerBaseUrl || undefined,
    managerPort,
    lanDiscovery: managerLanDiscoveryStatus,
    pluginGeneration: pluginGeneration ? {
      id: pluginGeneration.id,
      sequence: pluginGeneration.sequence,
      readiness: healthPayload.pluginReadiness
    } : undefined,
    routeLifecycle: healthPayload.routeLifecycle,
    backgroundLifecycle: healthPayload.backgroundLifecycle,
    managerAutostart: managerShouldAutostart,
    rabiGuid: globalConfig.rabiGuid,
    rabiName: globalConfig.rabiName,
    webguiLan: {
      enabled: globalConfig.webguiLan.enabled,
      tokenConfigured: Boolean(globalConfig.webguiLan.accessToken),
      listeningOnLan: managerListensOnLan(managerHost),
      restartRequired: !managerHostOverride && globalConfig.webguiLan.enabled !== managerListensOnLan(managerHost)
    },
    rabiLinkRelay: publicRabiLinkRelayConfig(rabiLinkRelayConfigForMeta()),
    rabiLinkRelayRuntime: rabiLinkRelayRuntime.status(),
    managerRuntime: managerRuntimeDiagnosticsSummary(),
    performance: performanceMonitoring.store.status(),
    operationalLog: managerOperationalLog.status(),
    messageProcessingPersistence: messageProcessingBoardPersistence.status(),
    readWorkers: managerReadWorkerPool.status(),
    catalogWorkers: managerCatalogWorkerPool.status(),
    agentScanWorkers: agentAdapterCatalogService?.workerStatus() ?? {
      executionMode: "child_process",
      state: "stopped",
      active: 0,
      queued: 0,
      workers: 0,
      workerPids: [],
      spawnedWorkers: 0,
      globalActive: 0,
      globalMaxConcurrency: 0,
      maxConcurrency: 0,
      maxQueue: 0,
      timeoutMs: 0
    },
    performanceWorkers: managerPerformanceWorkerPool.status(),
    httpLimits: managerHttpLimits,
    personaSyncLan: personaSyncLanServer.status(),
    computerName: os.hostname()
  };
}

async function prewarmRolePlanCatalogs(): Promise<boolean> {
  const startedAt = Date.now();
  let roleDirectories: string[] = [];
  try {
    roleDirectories = await managerCatalogWorkerPool.run<string[]>({
      type: "role_directories",
      rolesRoot
    }, { timeoutMs: 30_000 });
    let fulfilled = 0;
    for (const roleDir of roleDirectories) {
      try {
        await managerCatalogWorkerPool.queryRoleKnowledgeCatalogSnapshot(roleDir, { timeoutMs: 30_000 });
        fulfilled += 1;
      } catch (error) {
        managerOperationalLog.record("warn", "role_plan_catalog_prewarm_failed", {
          action: roleDir,
          error: managerOperationalError(error, rootDir)
        });
      }
    }
    managerOperationalLog.record("info", "role_plan_catalogs_prewarmed", {
      durationMs: Date.now() - startedAt,
      result: `roles=${roleDirectories.length}; fulfilled=${fulfilled}`
    });
    return fulfilled === roleDirectories.length;
  } catch (error) {
    managerOperationalLog.record("warn", "role_plan_catalogs_prewarm_failed", {
      durationMs: Date.now() - startedAt,
      result: `roles=${roleDirectories.length}`,
      error: managerOperationalError(error, rootDir)
    });
    return false;
  }
}

function contentTypeFor(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".js" || extension === ".mjs") return "text/javascript; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".json") return "application/json; charset=utf-8";
  if (extension === ".png") return "image/png";
  if (extension === ".svg") return "image/svg+xml; charset=utf-8";
  if (extension === ".woff") return "font/woff";
  if (extension === ".woff2") return "font/woff2";
  return "application/octet-stream";
}

function webuiCacheControl(filePath: string, indexPath: string): string {
  if (filePath === indexPath) return "no-store";
  // Vite names emitted assets with a content hash. They are safe to cache until
  // their URL changes, while index.html must always select the latest bundle.
  return /-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/.test(path.basename(filePath))
    ? "public, max-age=31536000, immutable"
    : "no-cache";
}

function staticWebuiResponse(pathname: string, response: http.ServerResponse): boolean {
  const indexPath = path.join(webuiDistPath, "index.html");
  if (!fs.existsSync(indexPath)) {
    return false;
  }

  const decoded = decodeURIComponent(pathname);
  const normalized = path.normalize(decoded === "/" ? "/index.html" : decoded).replace(/^[/\\]+/, "");
  const candidatePath = path.resolve(webuiDistPath, normalized);
  const relativeToDist = path.relative(webuiDistPath, candidatePath);
  if (relativeToDist.startsWith("..") || path.isAbsolute(relativeToDist)) {
    return false;
  }

  if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) {
    response.writeHead(200, {
      "content-type": contentTypeFor(candidatePath),
      "cache-control": webuiCacheControl(candidatePath, indexPath)
    });
    response.end(fs.readFileSync(candidatePath));
    return true;
  }

  if (path.extname(candidatePath)) {
    return false;
  }

  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(fs.readFileSync(indexPath, "utf8"));
  return true;
}

function htmlResponse(pathname: string, response: http.ServerResponse): void {
  if (staticWebuiResponse(pathname, response)) {
    return;
  }

  response.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
  response.end("RabiRoute WebGUI build is missing. Run `npm run webgui:build` or `npm run build`.");
}

function assetResponse(pathname: string, response: http.ServerResponse): boolean {
  const match = pathname.match(/^\/assets\/([a-zA-Z0-9_.-]+)$/);
  if (!match) {
    return false;
  }

  const assetPath = path.join(packageRoot, "assets", match[1]);
  if (!fs.existsSync(assetPath)) {
    return false;
  }

  const extension = path.extname(assetPath).toLowerCase();
  const contentType = extension === ".png"
    ? "image/png"
    : extension === ".svg"
      ? "image/svg+xml; charset=utf-8"
      : "application/octet-stream";
  response.writeHead(200, { "content-type": contentType });
  response.end(fs.readFileSync(assetPath));
  return true;
}

function handleAgentStateReport(request: http.IncomingMessage, pathname: string, response: http.ServerResponse): boolean {
  if (pathname !== "/api/agent-state") {
    return false;
  }

  void readJsonBody<AgentStateReportRequest>(request)
    .then(async (body) => {
      const gatewayId = sanitizeRoleId(body.gatewayId);
      const adapterType = parseAgentAdapterType(body.adapterType);
      const runtime = gatewayId ? runtimes.get(gatewayId) : undefined;
      if (!gatewayId || !adapterType || !runtime) {
        throw new Error("Invalid agent state report target.");
      }
      const generation = typeof body.generation === "string" ? body.generation.trim() : "";
      const sequence = Number(body.sequence);
      const previous = agentStateByGateway.get(gatewayId) ?? {};
      const previousSequence = Number(previous[adapterType]?.reportSequence ?? 0);
      const reportDecision = agentStateReportDecision(
        runtime.agentStateGeneration,
        generation,
        sequence,
        previousSequence
      );
      if (reportDecision === "invalid-generation") {
        throw new Error("Stale or invalid agent state report generation.");
      }
      if (reportDecision === "out-of-order") {
        jsonResponse(response, 202, { code: 0, ignored: true });
        return;
      }
      previous[adapterType] = {
        ...(previous[adapterType] ?? {}),
        ...(body.state ?? {}),
        agentAdapterType: adapterType,
        reportGeneration: generation,
        reportSequence: sequence,
        updatedAt: new Date().toISOString()
      };
      agentStateByGateway.set(gatewayId, previous);
      if (adapterType === "codex") {
        const bindingUpdate = resolveReportedCodexBindingUpdate(runtime.definition, body.state ?? {});
        if (bindingUpdate) {
          runtime.definition.codexThreadId = bindingUpdate.threadId;
          runtime.definition.codexCwd = bindingUpdate.workspace;
          await writeAdapterConfigFile(runtime.definition);
          publishManagerEvent("codex_binding_replaced", {
            gatewayId,
            previousThreadId: String(body.state?.bindingPreviousThreadId || ""),
            threadId: bindingUpdate.threadId,
            workspace: bindingUpdate.workspace
          });
        }
      }
      jsonResponse(response, 200, { code: 0 });
    })
    .catch((error) => {
      jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) });
    });
  return true;
}

export type PersonaPluginApiContext = {
  rolesRoot?: string;
  roleDir?: (roleId: string) => string;
  roleStorageApplication?: () => RoleStorageApplication;
};

export function handleManagerEventApi(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse
): boolean {
  if (request.method !== "GET" || requestUrl.pathname !== "/api/events") return false;
  openManagerEventStream(request, response);
  return true;
}

export function handlePersonaPluginApi(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
  context: PersonaPluginApiContext = {}
): boolean {
  const activeRolesRoot = context.rolesRoot ?? rolesRoot;
  const resolveRoleDir = context.roleDir ?? roleDirForApi;
  if (handlePersonaMessagingApi(request, requestUrl, response, {
    rootDir,
    rolesRoot: activeRolesRoot,
    personaPresentations: routeCatalogPersonas,
    runtimes: () => [...runtimes.values()],
    authorizeSource: (routeId, personaId, capability) => currentPersonaMessageAuthority().verify(routeId, personaId, capability),
    deliver: triggerGatewayRolePanelMessage,
    appendTimeline: appendRolePanelTimeline
  })) return true;
  if (handlePersonaAvatarApi(request, requestUrl.pathname, response, activeRolesRoot, change => {
    // This is presentation metadata only: version plus a Manager-relative URL, never a role directory path.
    publishManagerEvent("persona_avatar_changed", change);
  })) return true;
  if (handlePersonaDocumentApi(request, requestUrl, response, resolveRoleDir)) return true;
  if (handlePlanAgentStatusApi(request, requestUrl, response, { roleDir: resolveRoleDir })) return true;
  if (handlePlanAttachmentApi(request, requestUrl.pathname, response, resolveRoleDir)) return true;
  if (handleRolePanelApi(request, requestUrl, response, activeRolesRoot)) return true;
  return handleRoleKnowledgeApi(
    request,
    requestUrl.pathname,
    response,
    resolveRoleDir,
    context.roleStorageApplication ?? currentRoleStorageApplication
  );
}

export type StartManagerOptions = {
  instanceLock?: ManagerInstanceLock;
  planStorageStartupLifecycle?: PlanStorageStartupLifecycle;
  routeCatalogStartupLifecycle?: RouteCatalogStartupLifecycle;
};

export async function startManager(options: StartManagerOptions = {}): Promise<void> {
  roleKnowledgeCatalogsReady = false;
  let activeServer!: http.Server;
  let shuttingDown = false;
  const managerStartingRequest = (_request: http.IncomingMessage, response: http.ServerResponse): void => {
    response.statusCode = 503;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.setHeader("retry-after", "1");
    response.end(`${JSON.stringify({
      code: -1,
      state: "starting",
      message: "RabiRoute Manager is starting."
    })}\n`);
  };
  const managerStoppingRequest = (_request: http.IncomingMessage, response: http.ServerResponse): void => {
    response.statusCode = 503;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.setHeader("retry-after", "1");
    response.end(`${JSON.stringify({
      code: -1,
      state: "stopping",
      message: "RabiRoute Manager is stopping."
    })}\n`);
  };
  const managerRuntimeOwner = new ManagerRuntimeOwner<ActiveStorageLifecycleGeneration>({
    fenceIngress(reason) {
      shuttingDown = true;
      activeServer?.removeAllListeners("request");
      activeServer?.on("request", managerStoppingRequest);
      closeManagerEventClients();
      managerOperationalLog.record("info", "manager_ingress_fenced", { result: reason });
    },
    publish(publication) {
      if (activeStorageLifecycleGeneration) {
        throw new Error("A Manager runtime generation is already published.");
      }
      activeServer.removeAllListeners("request");
      activeServer.on("request", publication.requestHandler);
      activeStorageLifecycleGeneration = publication;
    },
    unpublish(publication) {
      if (activeStorageLifecycleGeneration === publication) {
        activeStorageLifecycleGeneration = undefined;
      }
      activeServer.removeListener("request", publication.requestHandler);
    },
    onResourceStopError(owner, error) {
      managerOperationalLog.record("error", "manager_resource_stop_failed", {
        action: owner,
        error: managerOperationalError(error, rootDir)
      });
    }
  });
  const failManagerStartup = async (phase: string, error: unknown): Promise<never> => {
    await managerRuntimeOwner.teardown(phase, error);
    throw error;
  };
  managerRuntimeOwner.register("operational_log_flush", () => managerOperationalLog.flush());
  managerRuntimeOwner.register("data_mutation_audit_sink", () => uninstallDataMutationAuditSink());
  let signalExitScheduled = false;
  const shutdownManager = (reason: string): void => {
    console.log(`gateway-manager shutting down: ${reason}`);
    managerOperationalLog.record("info", "manager_shutdown_requested", { result: reason });
    const teardownFlight = managerRuntimeOwner.teardown(`signal:${reason}`);
    if (signalExitScheduled) return;
    signalExitScheduled = true;
    void teardownFlight.then(
      () => process.exit(process.exitCode ?? 0),
      error => {
        process.exitCode = 1;
        console.error(error);
        process.exit(1);
      }
    );
    const forcedExit = setTimeout(
      () => process.exit(1),
      DEFAULT_MANAGER_RUNTIME_TEARDOWN_TIMEOUT_MS + 1_000
    );
    forcedExit.unref();
  };
  let removeSignalHandlers = (): void => {};
  try {
    removeSignalHandlers = installManagerSignalHandlers(shutdownManager);
    managerRuntimeOwner.register("signal_handlers", () => removeSignalHandlers());
  } catch (error) {
    await failManagerStartup("manager_signal_handler_acquisition", error);
  }
  try {
    const managerCordisRoot = getBuiltinManagerCordisRoot();
    managerRuntimeOwner.register("cordis_root", () => managerCordisRoot.dispose());
    await managerCordisRoot.ensure(
      MANAGER_SHARED_RESOURCES_RUNTIME_KEY,
      mountManagerSharedResourcesRuntime(messageProcessingBoardPersistence)
    );
  } catch (error) {
    await failManagerStartup("manager_shared_resources_acquisition", error);
  }
  activeServer = http.createServer(managerStartingRequest);
  managerRuntimeOwner.register("http_server", () => activeServer.listening
    ? new Promise<void>(resolve => activeServer.close(() => resolve()))
    : Promise.resolve());
  activeServer.requestTimeout = managerHttpLimits.requestTimeoutMs;
  activeServer.headersTimeout = managerHttpLimits.headersTimeoutMs;
  activeServer.keepAliveTimeout = managerHttpLimits.keepAliveTimeoutMs;
  activeServer.maxRequestsPerSocket = managerHttpLimits.maxRequestsPerSocket;
  try {
    const endpoint = await listenManagerEndpoint({
      server: activeServer,
      host: managerHost,
      policy: managerPortPolicy
    });
    managerPort = endpoint.port;
    managerBaseUrl = endpoint.baseUrl;
    managerInstanceId = options.instanceLock?.owner.ownerId ?? randomUUID();
    process.env.GATEWAY_MANAGER_PORT = String(managerPort);
    process.env.GATEWAY_MANAGER_URL = managerBaseUrl;
    configRepository.setManagerPort(managerPort);
  } catch (error) {
    await failManagerStartup("manager_endpoint_acquisition", error);
  }
  const roleStorageApplication = await (async (): Promise<RoleStorageApplication> => {
    try {
      const application = new RoleStorageApplication({
        rolesRoot,
        applicationGenerationId: managerHostIdentity?.applicationGenerationId ?? managerInstanceId,
        managerInstanceId,
        currentIdentity: () => managerInstanceId
          ? Object.freeze({
              applicationGenerationId: managerHostIdentity?.applicationGenerationId ?? managerInstanceId,
              managerInstanceId
            })
          : null
      });
      managerRuntimeOwner.register("role_storage", () => application.stop());
      return application;
    } catch (error) {
      return await failManagerStartup("role_storage_acquisition", error);
    }
  })();
  const {
    planStorageStartupLifecycle,
    routeCatalogStartupLifecycle
  } = await (async (): Promise<{
    planStorageStartupLifecycle: PlanStorageStartupLifecycle;
    routeCatalogStartupLifecycle: RouteCatalogStartupLifecycle;
  }> => {
    try {
      const planLifecycle = options.planStorageStartupLifecycle ?? new PlanStorageStartupLifecycle({
      rolesRoot,
      readOnly: managerReadOnly,
      attemptTimeoutMs: Number(process.env.RABIROUTE_PLAN_STORAGE_STARTUP_TIMEOUT_MS) || undefined,
      retryBaseMs: Number(process.env.RABIROUTE_PLAN_STORAGE_STARTUP_RETRY_BASE_MS) || undefined,
      retryMaxMs: Number(process.env.RABIROUTE_PLAN_STORAGE_STARTUP_RETRY_MAX_MS) || undefined,
      terminateTimeoutMs: Number(process.env.RABIROUTE_PLAN_STORAGE_STARTUP_TERMINATE_TIMEOUT_MS) || undefined,
      onStatus: snapshot => {
        publishManagerEvent("plan_storage_startup_changed", publicPlanStorageStartupSnapshot(snapshot));
        const level = snapshot.state === "degraded" ? "error" : "info";
        managerOperationalLog.record(level, `plan_storage_startup_${snapshot.state}`, {
          durationMs: snapshot.startedAt && snapshot.completedAt
            ? Math.max(0, Date.parse(snapshot.completedAt) - Date.parse(snapshot.startedAt))
            : undefined,
          result: `attempt=${snapshot.attempt}; state=${snapshot.state}; roles=${snapshot.summary?.roles ?? 0}; migrated=${snapshot.summary?.migrated ?? 0}; reconciled=${snapshot.summary?.reconciled ?? 0}; failures=${snapshot.summary?.failures.length ?? 0}`,
          error: snapshot.lastError ? managerOperationalError(new Error([
            snapshot.lastError,
            ...(snapshot.summary?.failures ?? []).slice(0, 10)
          ].join("\n")), rootDir) : undefined
        });
      }
      });
      managerRuntimeOwner.register("plan_storage_startup", () => planLifecycle.stop());
      const routeLifecycle = options.routeCatalogStartupLifecycle ?? new RouteCatalogStartupLifecycle({
      input: () => ({
        rootDir,
        routeRoot,
        rolesRoot,
        managerPort,
        readOnly: managerReadOnly
      }),
      apply: applyRouteCatalogSnapshot,
      attemptTimeoutMs: Number(process.env.RABIROUTE_ROUTE_CATALOG_STARTUP_TIMEOUT_MS) || undefined,
      retryBaseMs: Number(process.env.RABIROUTE_ROUTE_CATALOG_STARTUP_RETRY_BASE_MS) || undefined,
      retryMaxMs: Number(process.env.RABIROUTE_ROUTE_CATALOG_STARTUP_RETRY_MAX_MS) || undefined,
      maxAttempts: Number(process.env.RABIROUTE_ROUTE_CATALOG_STARTUP_MAX_ATTEMPTS) || undefined,
      terminateTimeoutMs: Number(process.env.RABIROUTE_ROUTE_CATALOG_STARTUP_TERMINATE_TIMEOUT_MS) || undefined,
      onStatus: snapshot => {
        publishManagerEvent("route_catalog_startup_changed", snapshot);
      },
      onFailure: (error, snapshot) => {
        managerOperationalLog.record("error", "route_catalog_startup_failed", {
          result: `attempt=${snapshot.attempt}; code=${snapshot.lastErrorCode ?? "unknown"}; Manager control plane stays live`,
          error: managerOperationalError(error, rootDir)
        });
      }
      });
      managerRuntimeOwner.register("route_catalog_startup", () => routeLifecycle.stop());
      return {
        planStorageStartupLifecycle: planLifecycle,
        routeCatalogStartupLifecycle: routeLifecycle
      };
    } catch (error) {
      return await failManagerStartup("startup_lifecycle_acquisition", error);
    }
  })();
  try {
  let managerPluginKernel: GenerationRuntime | undefined;
  const managerPluginProcessLeases = new ProcessLeaseRegistry();
  managerRuntimeOwner.register("manager_plugin_process_leases", () => managerPluginProcessLeases.disposeAll());
  let loadedManagerPluginProfile: LoadedPluginProfile | undefined;
  let managerPluginDiagnostics: readonly unknown[] = [];
  let managerServicesReady = false;
  let managerListenerReady = false;
  let resolveWearableCompanionStartup = (): void => {};
  const wearableCompanionStartupReady = new Promise<void>(resolve => {
    resolveWearableCompanionStartup = resolve;
  });
  let syncActiveRabiLinkRelay = async (): Promise<void> => {};
  let reconcileActiveSpeech = (): void => {};
  let recordManagerHttpRequest = (_pathname: string, _statusCode: number, _durationMs: number, _requestId: string, _responseBytes?: number): void => {};
  let startActiveNapcatSupervisor = (): void => {};
  let stopActiveNapcatSupervisor = async (): Promise<void> => {};
  let activeNapcatControlContext: ReturnType<typeof napcatManagerCtx> | undefined;
  let startActivePlanFeedbackRecovery = (): void => {};
  const managerPluginRoutes = new ManagerPluginRouteRegistry();
  const lanAgentRegistry = new LanAgentRegistry({ statePath: path.join(rootDir, "data", ".runtime", "lan-agent-tasks.json") });
  managerRuntimeOwner.register("lan_agent_registry", () => lanAgentRegistry.close());
  const lanAgentReleaseStore = new LanAgentReleaseStore({ rootDir });
  const webPluginModules = new WebPluginModuleRegistry();
  const wearableCompanionRuntimeIdentity = createWearableCompanionRuntimeIdentity({
    hostOwned: Boolean(managerHostIdentity),
    managerBaseUrl,
    applicationGenerationId: managerHostIdentity?.applicationGenerationId ?? managerInstanceId,
    managerInstanceId,
    runtimeRoot: rootDir,
    explicitPwshPath: process.env.RABIROUTE_PWSH_PATH,
    environment: process.env
  });
  const wearableCompanionWorkerService = new WearableCompanionWorkerService(
    wearableCompanionRuntimeIdentity,
    managerPluginProcessLeases,
    { startupReady: wearableCompanionStartupReady }
  );
  const managerPluginHostServices: readonly HostService[] = Object.freeze([
    Object.freeze({
      capability: "host.manager.wearable-companion-runtime@1",
      value: wearableCompanionRuntimeIdentity
    }),
    Object.freeze({
      capability: "host.manager.wearable-companion@1",
      value: wearableCompanionWorkerService
    }),
    Object.freeze({ capability: "host.manager.http@1", value: Object.freeze({
      ManagerPluginRequestTracker,
      jsonResponse,
      publishManagerEvent,
      readJsonBody,
      registerRoutes(instanceId: string, handlerId: string, handlers: Parameters<typeof registerManagerPluginHandlerRoutes>[3], declarations: Parameters<typeof registerManagerPluginHandlerRoutes>[4]) {
        return registerManagerPluginHandlerRoutes(managerPluginRoutes, instanceId, handlerId, handlers, declarations);
      }
    }) }),
    Object.freeze({ capability: "host.manager.core@1", value: Object.freeze({
      ManagerPluginRequestTracker,
      handleLanAgentApi,
      handleWebguiLanAccessApi,
      jsonResponse,
      lanAgentRegistry,
      lanAgentReleaseStore,
      managerPluginRoutes,
      rabiGlobalConfig,
      readJsonBody,
      registerManagerPluginHandlerRoutes,
      webguiTokenMatches,
    }) }),
    Object.freeze({ capability: "host.manager.persona@1", value: Object.freeze({
      ManagerPluginRequestTracker,
      handleLanguageStyleApi,
      handlePersonaPluginApi,
      handlePersonaSyncApi,
      languageStyleValidator,
      managerPluginRoutes,
      personaSyncRouteContext,
      personaSyncService,
      planStorageStartup: Object.freeze({
        snapshot: () => planStorageStartupLifecycle.snapshot(),
        onReady: (listener: Parameters<PlanStorageStartupLifecycle["onReady"]>[0]) => planStorageStartupLifecycle.onReady(listener)
      }),
      registerManagerPluginHandlerRoutes,
      get personaSyncAutoReconciler() { return personaSyncAutoReconciler; },
      set personaSyncAutoReconciler(value) { personaSyncAutoReconciler = value; },
    }) }),
    Object.freeze({ capability: "host.manager.speech@1", value: Object.freeze({
      ManagerPluginRequestTracker,
      handleSpeechApi,
      managerPluginRoutes,
      managerReadOnly,
      reconcileSpeechMicrophone,
      registerManagerPluginHandlerRoutes,
      speechControl,
      speechModelManager,
      speechRuntimeControl,
      get managerServicesReady() { return managerServicesReady; },
      set managerServicesReady(value) { managerServicesReady = value; },
      get reconcileActiveSpeech() { return reconcileActiveSpeech; },
      set reconcileActiveSpeech(value) { reconcileActiveSpeech = value; },
    }) }),
    Object.freeze({ capability: "host.manager.performance@1", value: Object.freeze({
      ManagerPluginRequestTracker,
      PerformanceApi,
      managerPerformanceWorkerPool,
      managerPluginRoutes,
      managerReadOnly,
      performanceMonitoring,
      rabiGlobalConfig,
      registerManagerPluginHandlerRoutes,
      runtimes,
      get recordManagerHttpRequest() { return recordManagerHttpRequest; },
      set recordManagerHttpRequest(value) { recordManagerHttpRequest = value; },
    }) }),
    Object.freeze({ capability: "host.manager.bilibili-history@1", value: Object.freeze({
      BilibiliHistoryBridge,
      ManagerPluginRequestTracker,
      configRepository,
      managerPluginRoutes,
      managerReadOnly,
      path,
      registerManagerPluginHandlerRoutes,
      rootDir,
    }) }),
    Object.freeze({ capability: "host.manager.route-control@1", value: Object.freeze({
      ManagerPluginRequestTracker,
      dataDirFor,
      ensureDataDirs,
      handleRabiApi,
      jsonResponse,
      loadRuntimes,
      managerHost,
      managerPluginRoutes,
      get managerPort() { return managerPort; },
      get applicationGenerationId() { return managerHostIdentity?.applicationGenerationId ?? managerInstanceId; },
      get managerInstanceId() { return managerInstanceId; },
      path,
      rabiGlobalConfig,
      rabiRoutePackageVersion,
      readConfig,
      readJsonBody,
      readManagerConfig,
      registerManagerPluginHandlerRoutes,
      rootDir,
      runtimeStatus,
      runtimes,
      routeCatalogVersion,
      routeCatalogPersonas,
      syncRunningGateways,
      writeConfig,
      writeManagerConfig,
      get agentAdapterCatalogService() { return agentAdapterCatalogService; },
      set agentAdapterCatalogService(value) { agentAdapterCatalogService = value; },
      get rolesRoot() { return rolesRoot; },
      set rolesRoot(value) { rolesRoot = value; },
      get routeRoot() { return routeRoot; },
      set routeRoot(value) { routeRoot = value; },
      get syncActiveRabiLinkRelay() { return syncActiveRabiLinkRelay; },
      set syncActiveRabiLinkRelay(value) { syncActiveRabiLinkRelay = value; },
    }) }),
    Object.freeze({ capability: "host.manager.agent-state-control@1", value: Object.freeze({
      ManagerPluginRequestTracker,
      handleAgentStateReport,
      managerPluginRoutes,
      registerManagerPluginHandlerRoutes,
    }) }),
    Object.freeze({ capability: "host.manager.gateway-runtime@1", value: Object.freeze({
      ManagerPluginRequestTracker,
      dataDirFor,
      handleGatewayControlApi,
      jsonResponse,
      listGatewayDeliveryReplayAttempts,
      loadRuntimes,
      managerPluginRoutes,
      managerReadOnly,
      manualTriggerProcesses,
      networkOptionsPayload,
      readJsonBody,
      registerManagerPluginHandlerRoutes,
      removeGatewayConfig,
      replayGatewayDelivery,
      requestWeixinLogin,
      restartGateway,
      routeCatalogVersion,
      runtimeStatus,
      runtimes,
      sharedGatewayAdapterTypes,
      standaloneGatewayPayload,
      startGateway,
      stopAllGatewaysAndWait,
      stopGateway,
      syncRunningGateways,
      triggerGatewayManualRule,
      testAgentDelivery: testGatewayAgentDelivery,
      writeConfig,
      acquireGatewayRuntimePluginLease: () => gatewayRuntimePluginLease.acquire(),
      get managerServicesReady() { return managerServicesReady; },
      set managerServicesReady(value) { managerServicesReady = value; },
    }) }),
    Object.freeze({ capability: "host.manager.rabilink-relay@1", value: Object.freeze({
      createDirectVideoReceiver: () => new RabiDirectVideo(path.join(rootDir, "data", "rabilink", "video")),
      createDirectVideoRoutes: (receiver: RabiDirectVideo) => createDirectVideoRoutes(receiver, managerReadOnly, readJsonBody, jsonResponse),
      ManagerPluginRequestTracker,
      registerManagerPluginHandlerRoutes,
      managerPluginRoutes,
      personaSyncLanServer,
      rabiLinkRelayRuntime,
      syncRabiLinkRelayRuntime,
      get managerListenerReady() { return managerListenerReady; },
      set managerListenerReady(value) { managerListenerReady = value; },
      get syncActiveRabiLinkRelay() { return syncActiveRabiLinkRelay; },
      set syncActiveRabiLinkRelay(value) { syncActiveRabiLinkRelay = value; },
    }) }),
    Object.freeze({ capability: "host.manager.memory-consolidation@1", value: Object.freeze({
      createMemoryConsolidationScheduler,
      managerReadOnly,
      manualTriggerProcesses,
      get managerListenerReady() { return managerListenerReady; },
      set managerListenerReady(value) { managerListenerReady = value; },
      get memoryConsolidationScheduler() { return memoryConsolidationScheduler; },
      set memoryConsolidationScheduler(value) { memoryConsolidationScheduler = value; },
    }) }),
    Object.freeze({ capability: "host.manager.fennenote-output@1", value: Object.freeze({
      FenneNoteOutputService,
      ManagerPluginRequestTracker,
      fenneNotePlaybackToken,
      fenneNotePlaybackUrl,
      fenneNoteReplyToken,
      fenneNoteReplyUrl,
      managerPluginRoutes,
      registerManagerPluginHandlerRoutes,
    }) }),
    Object.freeze({ capability: "host.manager.message-processing-control@1", value: Object.freeze({
      ManagerPluginRequestTracker,
      handleMessageProcessingApi,
      managerOperationalLog,
      managerPluginRoutes,
      messageProcessingBoard,
      messageProcessingBoardPayload,
      messageProcessingSendContextReview,
      publishManagerEvent,
      recalledKnowledgeForMessage,
      registerManagerPluginHandlerRoutes,
      roleDirForApi,
      rootDir,
      scheduleKnowledgeCallbackReminder,
      setMessageProcessingPlanBaseline,
      verifyCriticalProjectFactRecord,
    }) }),
    Object.freeze({ capability: "host.manager.message-processing-automation@1", value: Object.freeze({
      KnowledgeCallbackReminderService,
      MessageProcessingAutomationService,
      agentRequests,
      deliverAgentRequestReminder,
      deliverKnowledgeCallbackReminder,
      handleMessageProcessingPlanUpdate,
      managerOperationalError,
      managerOperationalLog,
      managerReadOnly,
      messageProcessingBoard,
      recordAgentRequestReminderFailure,
      rootDir,
      subscribePlanUpdates,
      get knowledgeCallbackReminderService() { return knowledgeCallbackReminderService; },
      set knowledgeCallbackReminderService(value) { knowledgeCallbackReminderService = value; },
      get messageProcessingAutomationService() { return messageProcessingAutomationService; },
      set messageProcessingAutomationService(value) { messageProcessingAutomationService = value; },
    }) }),
    Object.freeze({ capability: "host.manager.plan-feedback-delivery@1", value: Object.freeze({
      ManagerReadWorkerError,
      PlanFeedbackRecoveryService,
      activePlanFeedbackDeliveryFlights,
      inspectPlanFeedbackDelivery,
      managerOperationalError,
      managerOperationalLog,
      managerReadOnly,
      managerReadWorkerPool,
      planFeedbackFailureStatePath: path.join(
        projectDirectoryLayout(rootDir).runtimeStateRoot,
        "background-failure-circuits",
        "plan-feedback-recovery.json"
      ),
      publishManagerEvent,
      recoverPlanFeedbackCandidate,
      rootDir,
      scheduleAndWaitForPlanFeedbackDelivery,
      get managerListenerReady() { return managerListenerReady; },
      set managerListenerReady(value) { managerListenerReady = value; },
      get planFeedbackDeliveryActive() { return planFeedbackDeliveryActive; },
      set planFeedbackDeliveryActive(value) { planFeedbackDeliveryActive = value; },
      get planFeedbackRecoveryService() { return planFeedbackRecoveryService; },
      set planFeedbackRecoveryService(value) { planFeedbackRecoveryService = value; },
      get rolesRoot() { return rolesRoot; },
      set rolesRoot(value) { rolesRoot = value; },
      get startActivePlanFeedbackRecovery() { return startActivePlanFeedbackRecovery; },
      set startActivePlanFeedbackRecovery(value) { startActivePlanFeedbackRecovery = value; },
    }) }),
    Object.freeze({ capability: "host.manager.message-adapter-control@1", value: Object.freeze({
      ManagerPluginRequestTracker,
      MessageAdapterControlService,
      MessageAdapterScanProviderRegistry,
      adapterRuntimes,
      checkHttpEndpoint,
      fenneNotePlaybackUrl,
      handleMessageAdapterControlApi,
      jsonResponse,
      managerPluginRoutes,
      napcatManagerCtx,
      napcatScanHealthPayload,
      readGatewayStatus,
      registerBuiltinMessageAdapterScanProviders,
      registerManagerPluginHandlerRoutes,
      remoteAgentMessageAdapterScanResult,
      rootDir,
      routeCallbackEndpoint,
      routeHasRecentMessages,
      scanNapcatEndpoint,
      speechControl,
      xiaomiHomeHealthForScan,
      standaloneGatewayPayload,
    }) }),
    Object.freeze({ capability: "host.manager.agent-adapter-catalog@1", value: Object.freeze({
      jsonResponse,
      managerPluginRoutes,
      mountAgentAdapterCatalogPlugin,
      registerManagerPluginHandlerRoutes,
      rootDir,
      runtimes,
      get agentAdapterCatalogService() { return agentAdapterCatalogService; },
      set agentAdapterCatalogService(value) { agentAdapterCatalogService = value; },
    }) }),
    Object.freeze({ capability: "host.manager.agent-communication@1", value: Object.freeze({
      ManagerPluginRequestTracker,
      agentRequests,
      agentSendReceiptResponse,
      codexHookContextService,
      createAgentCommunicationRoutes,
      findAgentSendTraces,
      handleCodexHookApi,
      jsonResponse,
      managerPluginRoutes,
      performAgentSend,
      publishManagerEvent,
      readJsonBody,
      refreshAgentRequestReminderTimers,
      registerManagerPluginHandlerRoutes,
      rootDir,
    }) }),
    Object.freeze({ capability: "host.manager.copilot-control@1", value: Object.freeze({
      CopilotControlService,
      ManagerPluginRequestTracker,
      agentManagerApiCtx,
      createAgentProviderControlRouteHandler,
      getCopilotStatus,
      jsonResponse,
      managerPluginRoutes,
      publishManagerEvent,
      registerManagerPluginHandlerRoutes,
    }) }),
    Object.freeze({ capability: "host.manager.astrbot-control@1", value: Object.freeze({
      ManagerPluginRequestTracker,
      createAgentProviderControlRouteHandler,
      jsonResponse,
      managerPluginRoutes,
      readJsonBody,
      registerManagerPluginHandlerRoutes,
      testAstrbotLoginEndpoint,
    }) }),
    Object.freeze({ capability: "host.manager.marvis-control@1", value: Object.freeze({
      ManagerPluginRequestTracker,
      agentManagerApiCtx,
      createAgentProviderControlRouteHandler,
      jsonResponse,
      managerPluginRoutes,
      openMarvis,
      readJsonBody,
      registerManagerPluginHandlerRoutes,
    }) }),
    Object.freeze({ capability: "host.manager.agent-thread-control@1", value: Object.freeze({
      agentRequests,
      agentThreadRequestFailureData,
      agentThreadRequestOptions,
      applyManagedAgentThreadDefaults,
      createAgentThreadControlRoutes,
      handleAgentThreadRequest,
      jsonResponse,
      managerOperationalError,
      managerOperationalLog,
      managerPluginRoutes,
      messageProcessingBoard,
      publishManagerEvent,
      readJsonBody,
      refreshAgentRequestReminderTimers,
      registerManagerPluginHandlerRoutes,
      rootDir,
      setMessageProcessingPlanBaseline,
    }) }),
    Object.freeze({ capability: "host.manager.napcat-control@1", value: Object.freeze({
      ManagerPluginRequestTracker,
      addManagedNapcatInstance,
      checkNapcatHealthWithBackfill,
      configureNapcatOneBot,
      ensureNapcatInstanceReady,
      handleNapcatControlApi,
      jsonResponse,
      launchNapcatInstanceEndpoint,
      managerPluginRoutes,
      napcatManagerCtx,
      readNapcatLoginPanel,
      readJsonBody,
      registerManagerPluginHandlerRoutes,
      removeManagedNapcatInstance,
      repairAllNapcatInstances,
      restartNapcatInstanceEndpoint,
      runNapcatLoginAction,
      runWindowsTaskkill,
      stopChildProcessTree,
      get activeNapcatControlContext() { return activeNapcatControlContext; },
      set activeNapcatControlContext(value) { activeNapcatControlContext = value; },
      get managerListenerReady() { return managerListenerReady; },
      set managerListenerReady(value) { managerListenerReady = value; },
      get startActiveNapcatSupervisor() { return startActiveNapcatSupervisor; },
      set startActiveNapcatSupervisor(value) { startActiveNapcatSupervisor = value; },
      get stopActiveNapcatSupervisor() { return stopActiveNapcatSupervisor; },
      set stopActiveNapcatSupervisor(value) { stopActiveNapcatSupervisor = value; },
    }) }),
    Object.freeze({ capability: "host.manager.remote-agent@1", value: Object.freeze({
      ManagerPluginRequestTracker,
      RemoteAgentHub,
      appendLog,
      appendMessageContextToDir,
      handleRemoteAgentPluginApi,
      handleRemoteAgentTaskEvent,
      jsonResponse,
      managerHost,
      managerPluginRoutes,
      managerPort,
      path,
      readJsonBody,
      registerManagerPluginHandlerRoutes,
      remoteAgentPublicHost,
      remoteAgentTaskWithGatewayDefaults,
      roleDirForDefinition,
      rootDir,
      runtimes,
      get remoteAgentHub() { return remoteAgentHub; },
      set remoteAgentHub(value) { remoteAgentHub = value; },
    }) }),
    Object.freeze({ capability: "host.manager.napcat-supervisor@1", value: Object.freeze({
      NapcatSupervisorService,
      autoLoginNapcatInstancesOnRabiStart,
      get routeCatalogReady() { return routeCatalogStartupLifecycle.snapshot().state === "ready"; },
      managerReadOnly,
      managerShouldAutostart,
      get activeNapcatControlContext() { return activeNapcatControlContext; },
      set activeNapcatControlContext(value) { activeNapcatControlContext = value; },
      get managerListenerReady() { return managerListenerReady; },
      set managerListenerReady(value) { managerListenerReady = value; },
      get startActiveNapcatSupervisor() { return startActiveNapcatSupervisor; },
      set startActiveNapcatSupervisor(value) { startActiveNapcatSupervisor = value; },
      get stopActiveNapcatSupervisor() { return stopActiveNapcatSupervisor; },
      set stopActiveNapcatSupervisor(value) { stopActiveNapcatSupervisor = value; },
    }) }),
    Object.freeze({ capability: "host.manager.diagnostics@1", value: Object.freeze({
      PERFORMANCE_OPERATIONS,
      createDiagnosticsRoutes,
      jsonResponse,
      managerPluginRoutes,
      measureSyncPerformanceOperation,
      metaPayload,
      registerManagerPluginHandlerRoutes,
      runtimeStatusWithRoleInfoCache: runtimeStatus,
      runtimes,
    }) }),
    Object.freeze({ capability: "host.manager.desktop@1", value: Object.freeze({
      adapterConfigPath,
      createDesktopControlRoutes,
      desktopConfigFilePayload,
      ensureDataDirs,
      ensurePersonaConfigFile,
      ensureRoleFile,
      ensureRoleFolder,
      handleDesktopSettingsApi,
      jsonResponse,
      managerPluginRoutes,
      registerManagerPluginHandlerRoutes,
      rootDir,
      runtimes,
      writeAdapterConfigFile,
      get rolesRoot() { return rolesRoot; },
      set rolesRoot(value) { rolesRoot = value; },
      get routeRoot() { return routeRoot; },
      set routeRoot(value) { routeRoot = value; },
    }) }),
    Object.freeze({ capability: "host.manager.desktop-pet@1", value: Object.freeze({
      ManagerPluginRequestTracker,
      desktopSettings,
      handleDesktopPetApi,
      managerPluginRoutes,
      publishManagerEvent,
      registerManagerPluginHandlerRoutes,
      resolveRoleDir: roleDirForApi,
    }) }),
    Object.freeze({ capability: "host.manager.yeyu-gamer@1", value: Object.freeze({
      ManagerPluginRequestTracker,
      createYeYuGamerManagerRouteHandler,
      jsonResponse,
      managerPluginRoutes,
      readJsonBody,
      registerManagerPluginHandlerRoutes,
    }) }),
    Object.freeze({ capability: "host.manager.xiaomi-home@1", value: Object.freeze({
      ManagerPluginRequestTracker,
      XiaomiHomeManagerApiClient,
      XiaomiHomeArtifactStore,
      XiaomiHomeEventMonitor,
      XiaomiHomeClipCaptureWorker,
      XiaomiHomeArtifactAccess,
      XiaomiHomeRuntimeController,
      XiaomiHomeSettingsStore,
      createXiaomiHomeManagerRouteHandler,
      deliverXiaomiHomeEvent,
      webguiLanRequestAllowed,
      lifecycleFence: Object.freeze({
        applicationGenerationId: managerHostIdentity?.applicationGenerationId ?? managerInstanceId,
        managerInstanceId
      }),
      jsonResponse,
      managerPluginRoutes,
      readJsonBody,
      registerManagerPluginHandlerRoutes,
    }) }),
  ]);
  const configuredPluginProfile = process.env.RABIROUTE_PLUGIN_PROFILE?.trim();
  const managerPluginProfilePath = configuredPluginProfile
    ? path.resolve(configuredPluginProfile)
    : path.join(packageRoot, "dist", "plugins", "profiles", "desktop.json");
  const configuredPackageRoots = (process.env.RABIROUTE_PLUGIN_PACKAGE_ROOTS ?? "")
    .split(path.delimiter)
    .map(value => value.trim())
    .filter(Boolean)
    .map(value => path.resolve(value));
  const builtinPluginPackageRoot = path.join(packageRoot, "dist", "plugins", "packages");
  const managerPluginPackageRoots = Object.freeze([...new Set([
    builtinPluginPackageRoot,
    ...configuredPackageRoots
  ])]);
  const managerPluginPackageCatalog = new PluginPackageCatalog(managerPluginPackageRoots, {
    trustedInProcessRoots: [builtinPluginPackageRoot]
  });
  try {
  managerPluginKernel = new GenerationRuntime({
    host: "manager",
    hostServices: managerPluginHostServices,
    grantedPermissions: identity => loadedManagerPluginProfile?.grants(identity) ?? [],
    applicationIdentity: {
      applicationGenerationId: managerHostIdentity?.applicationGenerationId ?? managerInstanceId,
      managerInstanceId
    },
    executor: createFullPluginExecutor(managerPluginProcessLeases),
    onRuntimeFailure: event => {
      managerPluginGenerationStatus = Object.freeze({
        id: event.generation.id,
        sequence: event.generation.sequence,
        readiness: event.generation.readiness
      });
      managerPluginDiagnostics = event.generation.records.filter(record => record.status !== "active");
      if (loadedManagerPluginProfile) webPluginModules.update(loadedManagerPluginProfile, event.generation);
      const active = event.generation.records.filter(record => record.status === "active").map(record => record.identity.instanceId);
      const waiting = event.generation.records.filter(record => record.status === "waiting_dependency").map(record => record.identity.instanceId);
      const failed = event.generation.records.filter(record => record.status === "failed").map(record => record.identity.instanceId);
      managerOperationalLog.record("error", "plugin_runtime_failed", {
        result: `plugin=${event.identity.instanceId}; code=${event.error.code}`,
        error: managerOperationalError(event.error, rootDir)
      });
      publishManagerEvent("plugin_reconciliation_changed", {
        reason: "runtime failure",
        state: "runtime_failed",
        active,
        waiting,
        failed,
        diagnostics: managerPluginDiagnostics
      });
      publishManagerEvent("plugin_catalog_changed", {
        reason: "runtime failure",
        generation: event.generation.id,
        revision: {
          plugins: event.generation.sequence,
          contributions: event.generation.contributions.revision
        }
      });
    }
  });
  managerRuntimeOwner.register("manager_plugin_kernel", () => managerPluginKernel?.dispose() ?? Promise.resolve());
  } catch (error) {
    await failManagerStartup("manager_plugin_kernel_construction", error);
  }
  let managerPluginReconciliationTail: Promise<void> = Promise.resolve();
  const reconcileManagerPlugins = (
    reason: string,
    options: Readonly<{ readyOnly?: boolean }> = {}
  ): Promise<void> => {
    const reconciliation = managerPluginReconciliationTail.then(async () => {
      const previousProfile = loadedManagerPluginProfile;
      const loaded = await loadPluginProfile({
        profilePath: managerPluginProfilePath,
        packageCatalog: managerPluginPackageCatalog,
        runtimeRoot: path.join(rootDir, "data", "plugins", ".runtime"),
        host: "manager"
      });
      // GenerationRuntime resolves grants while executing switch(). Keep the matching
      // profile snapshot installed for that whole serialized transaction.
      loadedManagerPluginProfile = loaded;
      try {
        const candidates = options.readyOnly
          ? selectReadyPluginCandidates(
            loaded.candidates,
            loaded.profile.readyRequires,
            managerPluginHostServices.map(service => service.capability)
          )
          : loaded.candidates;
        const result = await managerPluginKernel!.switch(candidates, {
          readyRequires: loaded.profile.readyRequires
        });
        managerPluginGenerationStatus = Object.freeze({
          id: result.generation.id,
          sequence: result.generation.sequence,
          readiness: result.generation.readiness
        });
        webPluginModules.update(loaded, result.generation);
        const active = result.generation.records.filter(record => record.status === "active").map(record => record.identity.instanceId);
        const waiting = result.generation.records.filter(record => record.status === "waiting_dependency").map(record => record.identity.instanceId);
        const failed = result.generation.records.filter(record => record.status === "failed").map(record => record.identity.instanceId);
        managerPluginDiagnostics = result.generation.records.filter(record => record.status !== "active");
        publishManagerEvent("plugin_reconciliation_changed", { reason, state: "idle", active, waiting, failed, diagnostics: managerPluginDiagnostics });
        publishManagerEvent("plugin_catalog_changed", {
          reason,
          generation: result.generation.id,
          revision: { plugins: result.generation.sequence, contributions: result.generation.contributions.revision }
        });
      } catch (error) {
        loadedManagerPluginProfile = previousProfile;
        throw error;
      }
    });
    managerPluginReconciliationTail = reconciliation.catch(() => {});
    return reconciliation;
  };

  try {
    await reconcileManagerPlugins("manager startup required capabilities", { readyOnly: true });
    const readiness = managerPluginKernel!.current().readiness;
    if (readiness.missingCapabilities.length > 0) {
      throw new Error(`Required Manager capabilities failed to activate: ${readiness.missingCapabilities.join(", ")}`);
    }
  } catch (error) {
    await failManagerStartup("manager_plugin_startup", error);
  }
  let configWatcher: ConfigWatcher | null = null;
  let pluginPackageWatcher: PluginPackageWatcher | null = null;
  let managerResourcesStopped = false;

  function stopManagerResources(): void {
    if (managerResourcesStopped) return;
    managerResourcesStopped = true;
    gatewayDiagnosticsSnapshotService?.stop();
    gatewayDiagnosticsSnapshotService = undefined;
    closeManagerEventClients();
  }
  managerRuntimeOwner.register("request_scoped_resources", () => stopManagerResources());
  managerRuntimeOwner.register("manual_trigger_processes", () => manualTriggerProcesses.stopAll());

  try {
  managerServicesReady = true;
  if (managerReadOnly) {
    console.log("Manager read-only mode enabled: startup reconciliation and mutating HTTP methods are disabled.");
  }

  const handleManagerRequest = (request: http.IncomingMessage, response: http.ServerResponse): void => {
    const requestId = randomUUID();
    const requestStartedAt = Date.now();
    const method = request.method ?? "UNKNOWN";
    let pathname = "/";
    return runWithOperationContext(createOperationContext({
      traceId: requestId,
      spanId: requestId,
      requestId,
      source: "http",
      actor: { kind: "system", id: "manager-http" }
    }), () => {
    managerRequestContexts.set(response, {
      requestId,
      method,
      pathname: () => pathname,
      startedAt: requestStartedAt
    });
    response.setHeader("x-rabiroute-request-id", requestId);
    response.once("finish", () => {
      const durationMs = Math.max(0, Date.now() - requestStartedAt);
      const mutating = !["GET", "HEAD", "OPTIONS"].includes(method);
      const failed = response.statusCode >= 400;
      const slow = durationMs >= 2_000;
      const context = managerRequestContexts.get(response);
      recordManagerHttpRequest(
        pathname,
        response.statusCode,
        durationMs,
        requestId,
        context?.responseBytes
      );
      if (!mutating && !failed && !slow) return;
      managerOperationalLog.record(failed ? "warn" : slow ? "warn" : "info", "http_request_completed", {
        requestId,
        method,
        pathname,
        statusCode: response.statusCode,
        durationMs,
        result: failed ? "failed" : "completed"
      });
    });
    try {
      const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
      pathname = requestUrl.pathname;
      if (handleManagerLanDiscoveryRequest(request, requestUrl, response, {
        enabled: !managerReadOnly
          && managerListensOnLan(managerHost)
          && rabiGlobalConfig.read().webguiLan.enabled,
        document: () => {
          const config = rabiGlobalConfig.read();
          return Object.freeze({
            protocolVersion: MANAGER_DISCOVERY_PROTOCOL_VERSION,
            applicationGenerationId: managerHostIdentity?.applicationGenerationId ?? managerInstanceId,
            managerInstanceId,
            guid: config.rabiGuid,
            name: config.rabiName,
            computerName: os.hostname(),
            deviceType: "RabiRoute Manager" as const,
            version: rabiRoutePackageVersion()
          });
        },
        jsonResponse
      })) {
        return;
      }
      if (handleRoleContextProjectionRequest(request, requestUrl, response, {
        identity: {
          applicationGenerationId: managerHostIdentity?.applicationGenerationId ?? managerInstanceId,
          managerInstanceId
        },
        isLoopback: isLoopbackRemoteAddress,
        verifyCapability: (routeId, roleId, capability) =>
          currentPersonaMessageAuthority().verify(routeId, roleId, capability),
        readJsonBody,
        resolve: body => {
          const roleDir = roleDirForApi(body.roleId);
          return roleKnowledgeSnapshotFromPublishedCatalog(roleDir, String(body.signalText || ""), {
            roleId: body.roleId,
            includePendingConsolidation: body.includePendingConsolidation,
            consolidationTrigger: body.consolidationTrigger,
            archiveCompletedPlans: true,
            touchViewedAt: true
          });
        },
        requestRefresh: roleId => requestRoleKnowledgeCatalogRefresh(roleDirForApi(roleId)),
        jsonResponse
      })) {
        return;
      }
      if (!webguiLanRequestAllowed(request, requestUrl)) {
        response.setHeader("cache-control", "no-store");
        response.setHeader("www-authenticate", "Bearer realm=\"RabiRoute WebGUI\"");
        jsonResponse(response, 401, {
          code: -1,
          error: "WEBGUI_TOKEN_REQUIRED",
          message: "局域网访问需要有效的 RabiRoute WebGUI 访问密钥。请使用控制台生成的完整访问链接。"
        });
        return;
      }
      if (managerReadOnly && !managerReadOnlyRequestAllowed(request.method, pathname)) {
        jsonResponse(response, 423, {
          code: -1,
          message: "Manager is running in read-only acceptance mode."
        });
        return;
      }
      if (handleManagerHostLifecycleRequest(request, requestUrl, response, {
        identity: managerHostIdentity,
        shutdown: reason => shutdownManager(reason),
        jsonResponse
      })) {
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/health") {
        jsonResponse(response, 200, managerHealthPayload());
        return;
      }
      const routeCatalogRejection = routeCatalogStartupUnavailable(
        request.method,
        requestUrl.pathname,
        routeCatalogStartupLifecycle.snapshot()
      );
      if (routeCatalogRejection) {
        response.setHeader("cache-control", "no-store");
        response.setHeader("retry-after", String(routeCatalogRejection.retryAfterSeconds));
        jsonResponse(response, routeCatalogRejection.statusCode, routeCatalogRejection.body);
        return;
      }
      const planStorageRejection = planStorageStartupUnavailable(
        request.method,
        requestUrl.pathname,
        planStorageStartupLifecycle.snapshot()
      );
      if (planStorageRejection) {
        response.setHeader("retry-after", String(planStorageRejection.retryAfterSeconds));
        jsonResponse(response, planStorageRejection.statusCode, planStorageRejection.body);
        return;
      }
      const pluginReadiness = managerPluginGenerationStatus?.readiness;
      const missingCapabilities = pluginReadiness?.missingCapabilities ?? [];
      if (missingCapabilities.length > 0
        && !["GET", "HEAD", "OPTIONS"].includes(request.method ?? "")
        && requestUrl.pathname !== "/api/plugins/reconciliation") {
        jsonResponse(response, 503, {
          code: -1,
          error: "MANAGER_REQUIRED_CAPABILITY_UNAVAILABLE",
          message: `Manager required plugin capabilities are unavailable: ${missingCapabilities.join(", ")}`
        });
        return;
      }
      if (managerPluginRoutes.handle(request, requestUrl, response)) {
        return;
      }
      if (handleManagerEventApi(request, requestUrl, response)) {
        return;
      }
      if (handlePluginCatalogApi(request, requestUrl, response, {
        runtime: managerPluginKernel!,
        reconciliation: {
          diagnostics: () => managerPluginDiagnostics,
          reconcile: async () => {
            await reconcileManagerPlugins("manual API request");
            return managerPluginKernel!.current();
          }
        },
        webModules: {
          list: async () => webPluginModules.list(),
          read: (id, rev, relativePath) => webPluginModules.read(id, rev, relativePath)
        }
      })) {
        return;
      }
      if (request.method === "GET" && assetResponse(requestUrl.pathname, response)) {
        return;
      }
      if (isManagerControlRequestPath(requestUrl.pathname)) {
        jsonResponse(response, 404, { code: -1, message: "Manager API route not found." });
        return;
      }
      htmlResponse(requestUrl.pathname, response);
    } catch (error) {
      managerOperationalLog.record("error", "http_request_exception", {
        requestId,
        method,
        pathname,
        statusCode: 500,
        durationMs: Math.max(0, Date.now() - requestStartedAt),
        result: "exception",
        error: managerOperationalError(error, rootDir)
      });
      jsonResponse(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
    });
  };

  activeServer.requestTimeout = managerHttpLimits.requestTimeoutMs;
  activeServer.headersTimeout = managerHttpLimits.headersTimeoutMs;
  activeServer.keepAliveTimeout = managerHttpLimits.keepAliveTimeoutMs;
  activeServer.maxRequestsPerSocket = managerHttpLimits.maxRequestsPerSocket;
  const detachLanAgentUpgrade = lanAgentRegistry.attach(activeServer, {
    getToken: () => rabiGlobalConfig.read().webguiLan.accessToken,
    enabled: () => rabiGlobalConfig.read().webguiLan.enabled
  });
  managerRuntimeOwner.register("lan_agent_upgrade", () => detachLanAgentUpgrade());

  let planDependentBackgroundStarted = false;
  let planDependentBackgroundFlight: Promise<void> | undefined;
  let roleKnowledgeRetryTimer: NodeJS.Timeout | undefined;
  managerRuntimeOwner.register("role_knowledge_startup_retry", () => {
    if (roleKnowledgeRetryTimer) clearTimeout(roleKnowledgeRetryTimer);
    roleKnowledgeRetryTimer = undefined;
  });
  const startPlanDependentBackground = (): void => {
    if (planDependentBackgroundStarted || planDependentBackgroundFlight || shuttingDown || managerReadOnly) return;
    if (planStorageStartupLifecycle.snapshot().state !== "ready") return;
    if (routeCatalogStartupLifecycle.snapshot().state !== "ready") return;
    planDependentBackgroundFlight = (async () => {
      roleKnowledgeCatalogsReady = await prewarmRolePlanCatalogs();
      if (shuttingDown) return;
      if (!roleKnowledgeCatalogsReady) {
        roleKnowledgeRetryTimer = setTimeout(() => {
          roleKnowledgeRetryTimer = undefined;
          startPlanDependentBackground();
        }, 2_000);
        roleKnowledgeRetryTimer.unref();
        return;
      }
      planDependentBackgroundStarted = true;
      syncRunningGateways();
      void reconcilePersistedPlanSecretaryWorkspaces();
      startActivePlanFeedbackRecovery();
      memoryConsolidationScheduler?.start();
    })().finally(() => {
      planDependentBackgroundFlight = undefined;
    });
  };
  planStorageStartupLifecycle.onReady(() => startPlanDependentBackground());
  routeCatalogStartupLifecycle.onReady(() => {
    syncRunningGateways();
    startActiveNapcatSupervisor();
    if (!planDependentBackgroundStarted) {
      startPlanDependentBackground();
    } else {
      memoryConsolidationScheduler?.reschedule();
    }
  });
  const lanDiscoveryEnabled = !managerReadOnly
    && managerListensOnLan(managerHost)
    && rabiGlobalConfig.read().webguiLan.enabled;
  if (lanDiscoveryEnabled) {
    try {
      const managerLanDiscoveryFlight = startManagerDiscoveryPublisher({
        port: managerPort,
        applicationGenerationId: managerHostIdentity?.applicationGenerationId ?? managerInstanceId,
        managerInstanceId,
        onStatus: status => { managerLanDiscoveryStatus = status; }
      });
      managerRuntimeOwner.register("manager_lan_discovery", async () => {
        const publisher = await managerLanDiscoveryFlight.catch(() => undefined);
        await publisher?.stop();
      });
      await managerLanDiscoveryFlight;
      if (shuttingDown) return;
    } catch (error) {
      if (shuttingDown) return;
      managerLanDiscoveryStatus = Object.freeze({
        state: "failed",
        serviceType: "_rabiroute._tcp.local",
        port: managerPort,
        message: error instanceof Error ? error.message : String(error)
      });
      managerOperationalLog.record("warn", "manager_lan_discovery_failed", {
        result: `port=${managerPort}`,
        error: managerOperationalError(error, rootDir)
      });
    }
  } else {
    managerLanDiscoveryStatus = Object.freeze({
      state: "disabled",
      serviceType: "_rabiroute._tcp.local"
    });
  }

  activeGatewayDiagnosticsSnapshotService().requestRefresh({ force: true });
  void syncActiveRabiLinkRelay().catch(error => {
    managerOperationalLog.record("warn", "rabilink_relay_startup_failed", {
      result: "Manager control plane stays live",
      error: managerOperationalError(error, rootDir)
    });
  });
  startActiveNapcatSupervisor();
  if (!managerReadOnly) reconcileActiveSpeech();

  try {
    configWatcher = managerShouldAutostart && managerConfigWatcherEnabled()
      ? startConfigWatcher(reconcileManagerPlugins, () => syncActiveRabiLinkRelay())
      : null;
    if (configWatcher) {
      const acquiredConfigWatcher = configWatcher;
      managerRuntimeOwner.register("config_watcher", () => acquiredConfigWatcher.close());
    }
    if (!configWatcher) {
      configWatchLifecycle = disabledManagerWatchBrokerStatus();
      console.log("Route config event watcher disabled by RABIROUTE_MANAGER_AUTOSTART=0");
    }
  } catch (error) {
    configWatchLifecycle = Object.freeze({
      ...disabledManagerWatchBrokerStatus(),
      state: "degraded",
      partial: true,
      errors: [error instanceof Error ? error.message : String(error)]
    });
  }
  try {
    pluginPackageWatcher = startPluginPackageWatcher(
      [...managerPluginPackageRoots, path.dirname(managerPluginProfilePath)],
      reconcileManagerPlugins
    );
    const acquiredPluginPackageWatcher = pluginPackageWatcher;
    managerRuntimeOwner.register("plugin_package_watcher", () => acquiredPluginPackageWatcher.close());
  } catch (error) {
    pluginPackageWatchLifecycle = Object.freeze({
      ...disabledManagerWatchBrokerStatus(),
      state: "degraded",
      partial: true,
      errors: [error instanceof Error ? error.message : String(error)]
    });
  }
  if (managerRuntimeOwner.isTearingDown()) return;
  managerRuntimeOwner.publish(Object.freeze({
    roleStorage: roleStorageApplication,
    planStorage: planStorageStartupLifecycle,
    routeCatalog: routeCatalogStartupLifecycle,
    requestHandler: handleManagerRequest
  }));
  console.log(`gateway-manager listening on http://${managerHost}:${managerPort}`);
  console.log(`roles: ${rolesRoot}`);
  console.log(`route: ${routeRoot}`);
  managerOperationalLog.record("info", "manager_listening", {
    result: `host=${managerHost}; port=${managerPort}; readOnly=${managerReadOnly}`
  });
  managerListenerReady = true;
  if (managerHostIdentity) {
    console.log(managerReadyLine({
      protocolVersion: 1,
      applicationGenerationId: managerHostIdentity.applicationGenerationId,
      managerInstanceId,
      pid: process.pid,
      baseUrl: managerBaseUrl,
      readyAt: new Date().toISOString()
    }));
    resolveWearableCompanionStartup();
  }
  void reconcileManagerPlugins("post-ready optional activation").catch(error => {
    managerOperationalLog.record("warn", "plugin_post_ready_activation_failed", {
      result: "Required Manager control plane remains live",
      error: managerOperationalError(error, rootDir)
    });
  });
  // Publish the fenced control plane before any NAS recovery worker can start.
  planStorageStartupLifecycle.start();
  routeCatalogStartupLifecycle.start();
  } catch (error) {
    await failManagerStartup("manager_request_startup", error);
  }
  } catch (error) {
    if (managerRuntimeOwner.isTearingDown()) throw error;
    await failManagerStartup("manager_runtime_construction", error);
  }
}
