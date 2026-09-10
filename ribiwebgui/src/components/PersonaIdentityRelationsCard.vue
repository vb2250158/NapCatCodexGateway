<script setup lang="ts">
import { userFacingError } from "../userFacingError";
import { computed, ref, watch } from "vue";
import {
  personaIdentityRelationClient,
  type IdentityEndpointAccount,
  type IdentityEvidenceRef,
  type IdentityParticipant,
  type IdentityParticipantLink,
  type IdentityRelationCard,
  type IdentityRelationStatus,
  type IdentitySpeakingHabit,
  type IdentitySpeakingHabitDimension,
  type ConversationSituationSnapshot
} from "../persona/personaIdentityRelationClient";
import type { PersonaVoiceIdentity } from "../persona/personaVoiceIdentityClient";

const props = withDefaults(defineProps<{
  roleId: string;
  version?: number;
  voiceIdentities?: PersonaVoiceIdentity[];
  unidentifiedVoiceCount?: number;
}>(), { version: 0, voiceIdentities: () => [], unidentifiedVoiceCount: 0 });

const emit = defineEmits<{
  unlinkVoice: [identity: PersonaVoiceIdentity];
  participantsChange: [participants: IdentityParticipant[]];
  accountsChange: [accounts: IdentityEndpointAccount[]];
}>();

type ParticipantForm = {
  participantId: string;
  participantKind: IdentityParticipant["kind"];
  displayName: string;
  aliasesText: string;
  speakingHabits: SpeakingHabitForm[];
  status: IdentityRelationStatus;
  evidenceRefs: IdentityEvidenceRef[];
  evidenceNote: string;
};
type SpeakingHabitForm = {
  dimension: IdentitySpeakingHabitDimension;
  description: string;
  confidence?: number;
  messageIdsText: string;
  evidenceRefs: IdentityEvidenceRef[];
  evidenceNote: string;
};
type AccountLinkForm = IdentityParticipantLink & {
  evidenceNote: string;
};
type AccountForm = {
  platform: string;
  endpointIdentityNamespace: string;
  senderStableId: string;
  displayName: string;
  isSelf: boolean;
  participantLinks: AccountLinkForm[];
};
type RelationForm = {
  relationId: string;
  subjectParticipantId: string;
  targetKind: IdentityRelationCard["targetKind"];
  targetId: string;
  relationship: string;
  status: IdentityRelationStatus;
  conversationKeysText: string;
  projectIdsText: string;
  evidenceRefs: IdentityEvidenceRef[];
  evidenceNote: string;
};

const loading = ref(false);
const loaded = ref(false);
const error = ref("");
const notice = ref("");
const saving = ref(false);
const endpointAccounts = ref<IdentityEndpointAccount[]>([]);
const participants = ref<IdentityParticipant[]>([]);
const relationCards = ref<IdentityRelationCard[]>([]);
const situations = ref<ConversationSituationSnapshot[]>([]);
const situationsLoading = ref(false);
const situationsLoaded = ref(false);
const situationDialog = ref(false);
const maintenanceDialog = ref(false);
const identityQuery = ref("");
const showAllRecognized = ref(false);
const activeUnidentifiedChannel = ref("");
const identityWorkspaceDialog = ref(false);
const activeIdentityParticipantId = ref("");
const identityParticipantBaseline = ref("");
const workspaceAccountEditorOpen = ref(false);
const workspaceRelationEditorOpen = ref(false);
const participantDialog = ref(false);
const accountDialog = ref(false);
const participantEditing = ref(false);
const accountEditing = ref(false);
const relationEditing = ref(false);
const participantForm = ref<ParticipantForm>(emptyParticipantForm());
const accountForm = ref<AccountForm>(emptyAccountForm());
const relationForm = ref<RelationForm>(emptyRelationForm());

const statusOptions = [
  { title: "可能关联：共用或待核对", value: "candidate" },
  { title: "已确认", value: "confirmed" },
  { title: "已纠正", value: "corrected" },
  { title: "已停用", value: "retired" }
];
const participantKindOptions = [
  { title: "个人", value: "person" },
  { title: "组织", value: "organization" },
  { title: "自动化主体", value: "automated" },
  { title: "未知", value: "unknown" }
];
const speakingHabitDimensionOptions: Array<{ title: string; value: IdentitySpeakingHabitDimension }> = [
  { title: "句首习惯", value: "sentence_opening" },
  { title: "句子长度", value: "sentence_length" },
  { title: "判断表达方式", value: "stance_expression" },
  { title: "情绪出现条件", value: "emotion_threshold" },
  { title: "比喻来源", value: "analogy_source" },
  { title: "标点偏好", value: "punctuation" },
  { title: "与读者的关系", value: "reader_relationship" },
  { title: "价值判断偏好", value: "value_preference" },
  { title: "信息排列顺序", value: "information_order" },
  { title: "回避表达", value: "avoidance" },
  { title: "自然错误与不完美", value: "imperfection" },
  { title: "场景变化范围", value: "scene_boundary" }
];
const preferredChannelOrder = ["qq", "weixin", "wecom", "feishu", "rabilink", "voice", "wearable", "fennenote", "xiaoai", "rolepanel", "remoteagent", "webhook", "heartbeat", "other"];
const relationTargetOptions = [
  { title: "参与者", value: "participant" },
  { title: "组织", value: "organization" },
  { title: "项目", value: "project" }
];
const participantOptions = computed(() => participants.value
  .filter(item => !item.conflicted && item.status !== "retired")
  .map(item => ({
  title: item.displayName ? `${item.displayName} · ${item.id}` : item.id,
  value: item.id
})));
const conflictCount = computed(() => [
  ...endpointAccounts.value,
  ...participants.value,
  ...relationCards.value,
  ...props.voiceIdentities
].filter(item => item.conflicted).length);
const awaitingParticipantIds = computed(() => new Set(endpointAccounts.value.flatMap(account =>
  account.conflicted ? [] : account.participantLinks
    .filter(link => link.status === "candidate")
    .map(link => link.participantId)
)));
const awaitingCount = computed(() => participants.value.filter(item =>
  !item.conflicted && item.status === "candidate" && item.kind === "unknown" && awaitingParticipantIds.value.has(item.id)
).length);
const sortedParticipants = computed(() => [...participants.value].sort((left, right) => {
  if (Boolean(left.conflicted) !== Boolean(right.conflicted)) return left.conflicted ? -1 : 1;
  if (isAwaitingParticipant(left) !== isAwaitingParticipant(right)) return isAwaitingParticipant(left) ? -1 : 1;
  return right.updatedAt.localeCompare(left.updatedAt);
}));
const sortedAccounts = computed(() => [...endpointAccounts.value].sort((left, right) => {
  if (Boolean(left.conflicted) !== Boolean(right.conflicted)) return left.conflicted ? -1 : 1;
  return right.updatedAt.localeCompare(left.updatedAt);
}));
const sortedRelations = computed(() => [...relationCards.value].sort((left, right) => {
  if (Boolean(left.conflicted) !== Boolean(right.conflicted)) return left.conflicted ? -1 : 1;
  return right.updatedAt.localeCompare(left.updatedAt);
}));
const recognizedParticipants = computed(() => sortedParticipants.value.filter(item =>
  !item.conflicted && (item.status === "confirmed" || item.status === "corrected")
));
const activeIdentityParticipant = computed(() => participants.value.find(item => item.id === activeIdentityParticipantId.value));
const activeIdentityAccounts = computed(() => {
  const participantId = activeIdentityParticipantId.value;
  if (!participantId) return [];
  return sortedAccounts.value.filter(account => account.participantLinks.some(link => link.participantId === participantId));
});
const activeIdentityRelations = computed(() => {
  const participantId = activeIdentityParticipantId.value;
  return participantId ? sortedRelations.value.filter(item => item.subjectParticipantId === participantId) : [];
});
const activeIdentityVoices = computed(() => activeIdentityParticipantId.value
  ? voiceprintsForParticipant(activeIdentityParticipantId.value)
  : []);
const identityParticipantDirty = computed(() => identityWorkspaceDialog.value
  && participantFormSignature(participantForm.value) !== identityParticipantBaseline.value);
const maintenanceParticipants = computed(() => sortedParticipants.value.filter(item =>
  item.conflicted || item.status === "candidate" || item.status === "retired"
));
const filteredRecognizedParticipants = computed(() => {
  const query = identityQuery.value.trim().toLocaleLowerCase();
  if (!query) return recognizedParticipants.value;
  return recognizedParticipants.value.filter(item => [item.displayName, item.id, ...item.aliases]
    .filter(Boolean)
    .some(value => String(value).toLocaleLowerCase().includes(query)));
});
const visibleRecognizedParticipants = computed(() => showAllRecognized.value || identityQuery.value.trim()
  ? filteredRecognizedParticipants.value
  : filteredRecognizedParticipants.value.slice(0, 6));
const hiddenRecognizedCount = computed(() => Math.max(0, filteredRecognizedParticipants.value.length - visibleRecognizedParticipants.value.length));
const recognizedParticipantIds = computed(() => new Set(recognizedParticipants.value.map(item => item.id)));
function sharedRecognizedLinks(account: IdentityEndpointAccount): IdentityParticipantLink[] {
  if (account.conflicted) return [];
  const hasUniqueOwner = account.participantLinks.some(link =>
    (link.status === "confirmed" || link.status === "corrected")
    && recognizedParticipantIds.value.has(link.participantId)
  );
  if (hasUniqueOwner) return [];
  const links = account.participantLinks.filter(link =>
    link.status === "candidate" && recognizedParticipantIds.value.has(link.participantId)
  );
  return links.length > 1 ? links : [];
}
function isSharedRecognizedAccount(account: IdentityEndpointAccount): boolean {
  return sharedRecognizedLinks(account).length > 1;
}
const unidentifiedAccounts = computed(() => sortedAccounts.value.filter(account => {
  if (account.conflicted) return true;
  if (isSharedRecognizedAccount(account)) return false;
  const recognizedLinks = account.participantLinks.filter(link =>
    (link.status === "confirmed" || link.status === "corrected")
    && recognizedParticipantIds.value.has(link.participantId)
  );
  return recognizedLinks.length !== 1;
}));
const unidentifiedAccountGroups = computed(() => {
  const groups = new Map<string, IdentityEndpointAccount[]>();
  for (const account of unidentifiedAccounts.value) {
    const channel = endpointChannel(account.platform);
    groups.set(channel, [...(groups.get(channel) ?? []), account]);
  }
  const order = [...groups.keys()].sort((left, right) => {
    const leftIndex = preferredChannelOrder.indexOf(left);
    const rightIndex = preferredChannelOrder.indexOf(right);
    if (leftIndex < 0 && rightIndex < 0) return left.localeCompare(right);
    if (leftIndex < 0) return 1;
    if (rightIndex < 0) return -1;
    return leftIndex - rightIndex;
  });
  return order.flatMap(channel => {
    const accounts = groups.get(channel) ?? [];
    return accounts.length ? [{ channel, accounts }] : [];
  });
});
const unidentifiedChannels = computed(() => [
  ...unidentifiedAccountGroups.value.map(group => ({
    channel: group.channel,
    count: group.accounts.length + (group.channel === "voice" ? props.unidentifiedVoiceCount : 0)
  })),
  ...(props.unidentifiedVoiceCount > 0 && !unidentifiedAccountGroups.value.some(group => group.channel === "voice")
    ? [{ channel: "voice", count: props.unidentifiedVoiceCount }]
    : [])
]);
const currentUnidentifiedGroup = computed(() => unidentifiedAccountGroups.value.find(group => group.channel === activeUnidentifiedChannel.value));
const totalUnidentifiedCount = computed(() => unidentifiedAccounts.value.length + props.unidentifiedVoiceCount);

function emptyParticipantForm(): ParticipantForm {
  return {
    participantId: "",
    participantKind: "person",
    displayName: "",
    aliasesText: "",
    speakingHabits: [],
    status: "candidate",
    evidenceRefs: [],
    evidenceNote: ""
  };
}

function speakingHabitForm(item?: IdentitySpeakingHabit): SpeakingHabitForm {
  return item ? {
    dimension: item.dimension,
    description: item.description,
    confidence: item.confidence,
    messageIdsText: item.evidenceRefs.map(ref => ref.messageId).filter(Boolean).join(", "),
    evidenceRefs: item.evidenceRefs.map(ref => ({ ...ref })),
    evidenceNote: ""
  } : {
    dimension: "sentence_opening",
    description: "",
    confidence: undefined,
    messageIdsText: "",
    evidenceRefs: [],
    evidenceNote: ""
  };
}

function participantFormFrom(item: IdentityParticipant): ParticipantForm {
  return {
    participantId: item.id,
    participantKind: item.kind,
    displayName: item.displayName || "",
    aliasesText: item.aliases.join(", "),
    speakingHabits: (item.speakingHabits ?? []).map(habit => speakingHabitForm(habit)),
    status: item.status,
    evidenceRefs: item.evidenceRefs.map(ref => ({ ...ref })),
    evidenceNote: ""
  };
}

function participantFormSignature(form: ParticipantForm): string {
  return JSON.stringify({
    participantId: form.participantId.trim(),
    participantKind: form.participantKind,
    displayName: form.displayName.trim(),
    aliases: listFromText(form.aliasesText),
    speakingHabits: form.speakingHabits.map(habit => ({
      dimension: habit.dimension,
      description: habit.description.trim(),
      confidence: habit.confidence == null ? undefined : Number(habit.confidence),
      messageIds: listFromText(habit.messageIdsText),
      evidenceNote: habit.evidenceNote.trim()
    })),
    status: form.status,
    evidenceNote: form.evidenceNote.trim()
  });
}

function emptyAccountForm(): AccountForm {
  return { platform: "", endpointIdentityNamespace: "", senderStableId: "", displayName: "", isSelf: false, participantLinks: [] };
}

function emptyRelationForm(): RelationForm {
  return {
    relationId: "", subjectParticipantId: "", targetKind: "participant", targetId: "", relationship: "",
    status: "candidate", conversationKeysText: "", projectIdsText: "", evidenceRefs: [], evidenceNote: ""
  };
}

function listFromText(value: string): string[] {
  return [...new Set(value.split(/[\n,，]/).map(item => item.trim()).filter(Boolean))];
}

function compactTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().replace("T", " ").slice(0, 16) : value;
}

function statusLabel(value: IdentityRelationStatus): string {
  return ({ candidate: "候选", confirmed: "已确认", corrected: "已纠正", retired: "已停用" })[value];
}

function speakingHabitDimensionLabel(value: IdentitySpeakingHabitDimension): string {
  return speakingHabitDimensionOptions.find(item => item.value === value)?.title || value;
}

function isAwaitingParticipant(item: IdentityParticipant): boolean {
  return !item.conflicted && item.status === "candidate" && item.kind === "unknown" && awaitingParticipantIds.value.has(item.id);
}

function statusColor(value: IdentityRelationStatus): string | undefined {
  return ({ candidate: "warning", confirmed: "success", corrected: "secondary", retired: undefined })[value];
}

function participantName(id: string): string {
  const participant = participants.value.find(item => item.id === id);
  return participant?.displayName || participant?.id || id;
}

function endpointChannel(platform: string): string {
  const normalized = platform.trim().toLowerCase();
  if (["napcat", "qq", "onebot"].includes(normalized)) return "qq";
  if (["weixin", "wechat"].includes(normalized)) return "weixin";
  if (["wecom", "wxwork"].includes(normalized)) return "wecom";
  if (normalized === "feishu") return "feishu";
  if (["speech", "voice", "voiceprint"].includes(normalized)) return "voice";
  return normalized || "other";
}

function channelLabel(channel: string): string {
  return ({
    qq: "QQ", weixin: "微信", wecom: "企业微信", feishu: "飞书", voice: "声纹",
    rabilink: "RabiLink", wearable: "穿戴设备", webhook: "Webhook", fennenote: "FenneNote",
    xiaoai: "小爱同学", rolepanel: "人格面板", remoteagent: "远程 Agent", heartbeat: "心跳",
    other: "其他消息端"
  } as Record<string, string>)[channel] || channel;
}

function channelIcon(channel: string): string {
  return ({
    qq: "mdi-qqchat",
    weixin: "mdi-wechat",
    wecom: "mdi-briefcase-account-outline",
    feishu: "mdi-message-text-outline",
    voice: "mdi-account-voice",
    rabilink: "mdi-cellphone-link",
    wearable: "mdi-watch-variant",
    webhook: "mdi-webhook",
    fennenote: "mdi-note-text-outline",
    xiaoai: "mdi-speaker-wireless",
    rolepanel: "mdi-view-dashboard-outline",
    remoteagent: "mdi-robot-outline",
    heartbeat: "mdi-heart-pulse",
    other: "mdi-access-point"
  } as Record<string, string>)[channel] || "mdi-access-point";
}

function participantInitial(item: IdentityParticipant): string {
  return (item.displayName || item.id).trim().slice(0, 1).toLocaleUpperCase();
}

function participantById(id: string): IdentityParticipant | undefined {
  return participants.value.find(item => item.id === id);
}

function visibleAliases(item: IdentityParticipant): string[] {
  const displayName = (item.displayName || "").trim().toLocaleLowerCase();
  return item.aliases.filter(alias => alias.trim().toLocaleLowerCase() !== displayName).slice(0, 3);
}

function speakingHabitSummary(item: IdentityParticipant): string {
  return (item.speakingHabits ?? []).slice(0, 2)
    .map(habit => `${speakingHabitDimensionLabel(habit.dimension)}：${habit.description}`)
    .join("；");
}

function accountsForParticipant(participantId: string, channel: string): IdentityEndpointAccount[] {
  return sortedAccounts.value.filter(account =>
    !account.conflicted
    && endpointChannel(account.platform) === channel
    && account.participantLinks.some(link =>
      link.participantId === participantId
      && ((link.status === "confirmed" || link.status === "corrected")
        || (link.status === "candidate" && isSharedRecognizedAccount(account)))
    )
  );
}

function isSharedAccountForParticipant(account: IdentityEndpointAccount, participantId: string): boolean {
  return isSharedRecognizedAccount(account)
    && sharedRecognizedLinks(account).some(link => link.participantId === participantId);
}

function hasVoiceAccount(identity: PersonaVoiceIdentity): boolean {
  if (!identity.participantId) return false;
  return sortedAccounts.value.some(account =>
    !account.conflicted
    && endpointChannel(account.platform) === "voice"
    && account.senderStableId === identity.voiceprintId
    && (!identity.sourceHostId || account.endpointIdentityNamespace.includes(identity.sourceHostId))
    && account.participantLinks.some(link =>
      link.participantId === identity.participantId
      && (link.status === "confirmed" || link.status === "corrected")
    )
  );
}

function voiceprintsForParticipant(participantId: string): PersonaVoiceIdentity[] {
  return props.voiceIdentities.filter(identity =>
    !identity.conflicted
    && identity.participantId === participantId
    && !hasVoiceAccount(identity)
  );
}

function channelRowsForParticipant(participantId: string): Array<{
  channel: string;
  accounts: IdentityEndpointAccount[];
  voices: PersonaVoiceIdentity[];
}> {
  const voices = voiceprintsForParticipant(participantId);
  const channels = new Set(sortedAccounts.value
    .filter(account => account.participantLinks.some(link => link.participantId === participantId))
    .map(account => endpointChannel(account.platform)));
  if (voices.length) channels.add("voice");
  const orderedChannels = [...channels].sort((left, right) => {
    const leftIndex = preferredChannelOrder.indexOf(left);
    const rightIndex = preferredChannelOrder.indexOf(right);
    if (leftIndex < 0 && rightIndex < 0) return left.localeCompare(right);
    if (leftIndex < 0) return 1;
    if (rightIndex < 0) return -1;
    return leftIndex - rightIndex;
  });
  return orderedChannels.flatMap(channel => {
    const accounts = accountsForParticipant(participantId, channel);
    const channelVoices = channel === "voice" ? voices : [];
    return accounts.length || channelVoices.length ? [{ channel, accounts, voices: channelVoices }] : [];
  });
}

function relationsForParticipant(participantId: string): IdentityRelationCard[] {
  return sortedRelations.value.filter(item =>
    item.subjectParticipantId === participantId
    && (item.status === "candidate" || item.status === "confirmed" || item.status === "corrected")
  );
}

function relationTargetLabel(item: IdentityRelationCard): string {
  if (item.targetKind === "participant") return participantName(item.targetId);
  if (item.targetKind === "project") return item.targetId;
  return item.targetId;
}

function relationLabel(item: IdentityRelationCard): string {
  return `${relationTargetLabel(item)} · ${item.relationship}`;
}

function accountValue(account: IdentityEndpointAccount): string {
  return account.displayName && account.displayName !== account.senderStableId
    ? `${account.displayName}（${account.senderStableId}）`
    : account.senderStableId;
}

function cardChannelValue(row: { accounts: IdentityEndpointAccount[]; voices: PersonaVoiceIdentity[] }): string {
  const count = row.accounts.length + row.voices.length;
  if (count !== 1) return `${count} 个`;
  if (row.accounts[0]) return accountValue(row.accounts[0]);
  return compactIdentifier(row.voices[0]?.voiceprintId || "");
}

function identityDetailCounts(item: IdentityParticipant): string {
  const accountCount = activeCountForParticipant(item.id);
  const habitCount = item.speakingHabits?.length ?? 0;
  const relationCount = relationsForParticipant(item.id).length;
  return `${accountCount} 个账号 · ${habitCount} 条说话习惯 · ${relationCount} 条关系`;
}

function activeCountForParticipant(participantId: string): number {
  return channelRowsForParticipant(participantId)
    .reduce((total, row) => total + row.accounts.length + row.voices.length, 0);
}

function accountLinkForParticipant(account: IdentityEndpointAccount, participantId: string): IdentityParticipantLink | undefined {
  return account.participantLinks.find(link => link.participantId === participantId);
}

function evidenceCount(refs: IdentityEvidenceRef[]): number {
  return refs.filter(ref => Object.values(ref).some(Boolean)).length;
}

function hasMultipleActiveAccountLinks(account: IdentityEndpointAccount): boolean {
  return account.participantLinks.filter(link => link.status !== "retired").length > 1;
}

function relationScopeSummary(item: IdentityRelationCard): string {
  const parts = [];
  if (item.scope.conversationKeys.length) parts.push(`${item.scope.conversationKeys.length} 个会话`);
  if (item.scope.projectIds.length) parts.push(`${item.scope.projectIds.length} 个项目`);
  return parts.length ? `适用于 ${parts.join("、")}` : "未限制适用范围";
}

function unlinkVoiceFromWorkspace(identity: PersonaVoiceIdentity): void {
  if (!window.confirm(`解除声纹 ${compactIdentifier(identity.voiceprintId)} 与当前身份的关联吗？`)) return;
  emit("unlinkVoice", identity);
}

function compactIdentifier(value: string): string {
  return value.length <= 18 ? value : `${value.slice(0, 10)}…${value.slice(-5)}`;
}

function recordSummary(record: IdentityEndpointAccount | IdentityParticipant | IdentityRelationCard): string {
  if ("platform" in record) return `${record.platform} / ${record.endpointIdentityNamespace} / ${record.senderStableId}`;
  if ("kind" in record) return `${record.displayName || record.id} · ${statusLabel(record.status)}`;
  return `${record.relationship} · ${record.targetKind}:${record.targetId}`;
}

function appendEvidence(existing: IdentityEvidenceRef[], note: string): IdentityEvidenceRef[] {
  const normalized = note.trim();
  return normalized ? [...existing, { note: normalized }] : existing;
}

async function refresh(): Promise<void> {
  if (!props.roleId || loading.value) return;
  loading.value = true;
  error.value = "";
  try {
    const result = await personaIdentityRelationClient.list(props.roleId);
    endpointAccounts.value = result.endpointAccounts;
    emit("accountsChange", result.endpointAccounts);
    participants.value = result.participants;
    emit("participantsChange", result.participants);
    relationCards.value = result.relationCards;
    loaded.value = true;
  } catch (caught) {
    error.value = userFacingError(caught);
  } finally {
    loading.value = false;
  }
}

async function refreshSituations(): Promise<void> {
  if (!props.roleId || situationsLoading.value) return;
  situationsLoading.value = true;
  try {
    situations.value = await personaIdentityRelationClient.listSituations(props.roleId);
    situationsLoaded.value = true;
  } catch (caught) {
    error.value = userFacingError(caught);
  } finally {
    situationsLoading.value = false;
  }
}

async function openSituationRecords(): Promise<void> {
  situationDialog.value = true;
  if (!situationsLoaded.value) await refreshSituations();
}

function situationTopic(item: ConversationSituationSnapshot): string {
  if (item.topic.projectCandidates.length === 0) return "没有可核对的项目线索";
  return item.topic.projectCandidates.map(project => `${project.status === "confirmed" ? "已确认" : "候选"} ${project.projectId}（${project.relationship}）`).join("；");
}

function openParticipant(item?: IdentityParticipant): void {
  participantEditing.value = Boolean(item);
  participantForm.value = item ? participantFormFrom(item) : emptyParticipantForm();
  participantDialog.value = true;
}

function prepareAccountForm(item?: IdentityEndpointAccount): void {
  accountEditing.value = Boolean(item);
  accountForm.value = item ? {
    platform: item.platform,
    endpointIdentityNamespace: item.endpointIdentityNamespace,
    senderStableId: item.senderStableId,
    displayName: item.displayName || "",
    isSelf: item.isSelf === true,
    participantLinks: item.participantLinks.map(link => ({
      ...link,
      evidenceRefs: link.evidenceRefs.map(ref => ({ ...ref })),
      evidenceNote: ""
    }))
  } : emptyAccountForm();
}

function openAccount(item?: IdentityEndpointAccount): void {
  prepareAccountForm(item);
  accountDialog.value = true;
}

function prepareRelationForm(item?: IdentityRelationCard): void {
  relationEditing.value = Boolean(item);
  relationForm.value = item ? {
    relationId: item.id,
    subjectParticipantId: item.subjectParticipantId,
    targetKind: item.targetKind,
    targetId: item.targetId,
    relationship: item.relationship,
    status: item.status,
    conversationKeysText: item.scope.conversationKeys.join(", "),
    projectIdsText: item.scope.projectIds.join(", "),
    evidenceRefs: item.evidenceRefs,
    evidenceNote: ""
  } : emptyRelationForm();
}

function openIdentityWorkspace(item: IdentityParticipant): void {
  activeIdentityParticipantId.value = item.id;
  participantEditing.value = true;
  participantForm.value = participantFormFrom(item);
  identityParticipantBaseline.value = participantFormSignature(participantForm.value);
  workspaceAccountEditorOpen.value = false;
  workspaceRelationEditorOpen.value = false;
  identityWorkspaceDialog.value = true;
}

function openParticipantReference(participantId: string): void {
  const item = participantById(participantId);
  if (!item) return;
  if (!item.conflicted && (item.status === "confirmed" || item.status === "corrected")) {
    openIdentityWorkspace(item);
    return;
  }
  openParticipant(item);
}

function requestCloseIdentityWorkspace(): void {
  const hasUncommittedEditor = workspaceAccountEditorOpen.value || workspaceRelationEditorOpen.value;
  if ((identityParticipantDirty.value || hasUncommittedEditor)
    && !window.confirm("当前身份还有未保存的修改，仍然关闭吗？")) return;
  identityWorkspaceDialog.value = false;
  activeIdentityParticipantId.value = "";
  identityParticipantBaseline.value = "";
  workspaceAccountEditorOpen.value = false;
  workspaceRelationEditorOpen.value = false;
}

function openIdentityAccountEditor(item?: IdentityEndpointAccount): void {
  prepareAccountForm(item);
  if (!item && activeIdentityParticipantId.value) {
    accountForm.value.participantLinks = [{
      participantId: activeIdentityParticipantId.value,
      status: activeIdentityParticipant.value?.status === "corrected" ? "corrected" : "confirmed",
      confidence: 1,
      evidenceRefs: [],
      evidenceNote: ""
    }];
  }
  workspaceRelationEditorOpen.value = false;
  workspaceAccountEditorOpen.value = true;
}

function openIdentityRelationEditor(item?: IdentityRelationCard): void {
  prepareRelationForm(item);
  if (!item) relationForm.value.subjectParticipantId = activeIdentityParticipantId.value;
  workspaceAccountEditorOpen.value = false;
  workspaceRelationEditorOpen.value = true;
}

function addSpeakingHabit(): void {
  participantForm.value.speakingHabits.push(speakingHabitForm());
}

function removeSpeakingHabit(index: number): void {
  participantForm.value.speakingHabits.splice(index, 1);
}

function addAccountLink(): void {
  accountForm.value.participantLinks.push({ participantId: "", status: "candidate", evidenceRefs: [], evidenceNote: "" });
}

function removeAccountLink(index: number): void {
  accountForm.value.participantLinks.splice(index, 1);
}

function speakingHabitEvidenceRefs(form: SpeakingHabitForm): IdentityEvidenceRef[] {
  const existingByMessageId = new Map(form.evidenceRefs
    .filter(ref => ref.messageId)
    .map(ref => [ref.messageId as string, ref]));
  const withoutMessageId = form.evidenceRefs.filter(ref => !ref.messageId).map(ref => ({ ...ref }));
  const messageRefs = listFromText(form.messageIdsText)
    .map(messageId => ({ ...(existingByMessageId.get(messageId) ?? {}), messageId }));
  return appendEvidence([...withoutMessageId, ...messageRefs], form.evidenceNote);
}

function speakingHabitsFromForm(): IdentitySpeakingHabit[] | undefined {
  for (const [index, habit] of participantForm.value.speakingHabits.entries()) {
    if (!habit.description.trim()) {
      error.value = `第 ${index + 1} 条说话习惯缺少说明。`;
      return undefined;
    }
    if (listFromText(habit.messageIdsText).length === 0) {
      error.value = `第 ${index + 1} 条说话习惯至少需要一条已确认作者的消息 ID。`;
      return undefined;
    }
  }
  return participantForm.value.speakingHabits.map(habit => ({
    dimension: habit.dimension,
    description: habit.description.trim(),
    confidence: habit.confidence == null ? undefined : Number(habit.confidence),
    evidenceRefs: speakingHabitEvidenceRefs(habit)
  }));
}

async function persistParticipant(): Promise<boolean> {
  if (!props.roleId || saving.value) return false;
  const speakingHabits = speakingHabitsFromForm();
  if (!speakingHabits) return false;
  saving.value = true;
  error.value = "";
  try {
    await personaIdentityRelationClient.update(props.roleId, {
      kind: "participant",
      participantId: participantForm.value.participantId.trim() || undefined,
      participantKind: participantForm.value.participantKind,
      displayName: participantForm.value.displayName.trim(),
      aliases: listFromText(participantForm.value.aliasesText),
      speakingHabits,
      status: participantForm.value.status,
      evidenceRefs: appendEvidence(participantForm.value.evidenceRefs, participantForm.value.evidenceNote)
    });
    notice.value = "身份已写入当前人格。";
    await refresh();
    return true;
  } catch (caught) {
    error.value = userFacingError(caught);
    return false;
  } finally {
    saving.value = false;
  }
}

async function saveParticipant(): Promise<void> {
  if (await persistParticipant()) participantDialog.value = false;
}

async function saveIdentityParticipant(): Promise<void> {
  if (!await persistParticipant()) return;
  const refreshed = activeIdentityParticipant.value;
  if (refreshed) {
    participantForm.value = participantFormFrom(refreshed);
    identityParticipantBaseline.value = participantFormSignature(participantForm.value);
  }
}

async function persistAccount(): Promise<boolean> {
  if (!props.roleId || saving.value) return false;
  saving.value = true;
  error.value = "";
  try {
    await personaIdentityRelationClient.update(props.roleId, {
      kind: "endpoint_account",
      platform: accountForm.value.platform.trim(),
      endpointIdentityNamespace: accountForm.value.endpointIdentityNamespace.trim(),
      senderStableId: accountForm.value.senderStableId.trim(),
      displayName: accountForm.value.displayName.trim(),
      isSelf: accountForm.value.isSelf,
      participantLinks: accountForm.value.participantLinks.map(link => ({
        participantId: link.participantId,
        status: link.status,
        confidence: link.confidence == null ? undefined : Number(link.confidence),
        evidenceRefs: appendEvidence(link.evidenceRefs, link.evidenceNote)
      }))
    });
    notice.value = "消息端账号映射已写入当前人格。";
    await refresh();
    return true;
  } catch (caught) {
    error.value = userFacingError(caught);
    return false;
  } finally {
    saving.value = false;
  }
}

async function saveAccount(): Promise<void> {
  if (await persistAccount()) accountDialog.value = false;
}

async function saveIdentityAccount(): Promise<void> {
  if (await persistAccount()) workspaceAccountEditorOpen.value = false;
}

async function persistRelation(): Promise<boolean> {
  if (!props.roleId || saving.value) return false;
  saving.value = true;
  error.value = "";
  try {
    await personaIdentityRelationClient.update(props.roleId, {
      kind: "relation_card",
      relationId: relationForm.value.relationId.trim() || undefined,
      subjectParticipantId: relationForm.value.subjectParticipantId,
      targetKind: relationForm.value.targetKind,
      targetId: relationForm.value.targetId.trim(),
      relationship: relationForm.value.relationship.trim(),
      status: relationForm.value.status,
      scope: {
        conversationKeys: listFromText(relationForm.value.conversationKeysText),
        projectIds: listFromText(relationForm.value.projectIdsText)
      },
      evidenceRefs: appendEvidence(relationForm.value.evidenceRefs, relationForm.value.evidenceNote)
    });
    notice.value = "关系已写入当前人格。";
    await refresh();
    return true;
  } catch (caught) {
    error.value = userFacingError(caught);
    return false;
  } finally {
    saving.value = false;
  }
}

async function saveIdentityRelation(): Promise<void> {
  if (await persistRelation()) workspaceRelationEditorOpen.value = false;
}

watch(() => props.roleId, () => {
  endpointAccounts.value = [];
  participants.value = [];
  relationCards.value = [];
  situations.value = [];
  situationsLoaded.value = false;
  identityQuery.value = "";
  showAllRecognized.value = false;
  activeUnidentifiedChannel.value = "";
  identityWorkspaceDialog.value = false;
  activeIdentityParticipantId.value = "";
  identityParticipantBaseline.value = "";
  workspaceAccountEditorOpen.value = false;
  workspaceRelationEditorOpen.value = false;
  loaded.value = false;
  error.value = "";
  notice.value = "";
  if (props.roleId) void refresh();
}, { immediate: true });

watch(() => props.version, () => {
  if (props.roleId && loaded.value) void refresh();
});

watch(unidentifiedChannels, channels => {
  if (!channels.some(item => item.channel === activeUnidentifiedChannel.value)) {
    activeUnidentifiedChannel.value = channels[0]?.channel || "";
  }
}, { immediate: true });
</script>

<template>
  <v-card class="app-card glass-card section-card identity-relations-card">
    <div class="section-title-row">
      <div>
        <div class="section-title">身份定位</div>
        <div class="section-note">先看已经知道谁是谁，再处理仍不认识的消息端账号。身份记录不会自动带来项目归属、委托或执行权限。</div>
      </div>
      <div class="identity-relations-toolbar">
        <v-chip color="success" variant="tonal">{{ recognizedParticipants.length }} 位已识别</v-chip>
        <v-chip :color="totalUnidentifiedCount ? 'warning' : undefined" variant="tonal">{{ totalUnidentifiedCount }} 个待识别账号</v-chip>
        <v-chip v-if="conflictCount" color="warning" variant="tonal">{{ conflictCount }} 个冲突</v-chip>
        <v-btn size="small" variant="text" prepend-icon="mdi-history" @click="openSituationRecords">情景记录</v-btn>
        <v-btn size="small" variant="text" prepend-icon="mdi-refresh" :loading="loading" @click="refresh">刷新</v-btn>
      </div>
    </div>

    <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-3">{{ error }}</v-alert>
    <v-alert v-if="notice" type="success" variant="tonal" density="compact" class="mb-3">{{ notice }}</v-alert>
    <v-progress-linear v-if="loading" indeterminate color="secondary" class="mb-3" />

    <div class="identity-primary-panels">
      <v-card variant="flat" class="identity-panel identity-recognized-panel">
      <div class="section-title-row compact-row">
        <div>
          <div class="section-title small-title">已识别身份</div>
          <div class="section-note">按人归类。点击一张人物卡，即可在同一处查看和编辑这个身份的全部资料。</div>
        </div>
        <div class="identity-panel-actions">
          <v-text-field
            v-if="recognizedParticipants.length > 6"
            v-model="identityQuery"
            class="identity-search"
            density="compact"
            hide-details
            clearable
            prepend-inner-icon="mdi-magnify"
            label="查找身份"
          />
          <v-btn size="small" color="secondary" variant="tonal" prepend-icon="mdi-account-plus" @click="openParticipant()">新增身份</v-btn>
        </div>
      </div>
      <div v-if="loaded && recognizedParticipants.length === 0" class="empty-state compact-empty">
        <div><strong>还没有已识别身份</strong><span>确认一个人后，他在不同消息端的账号会汇总到同一张卡片。</span></div>
      </div>
      <div v-else-if="visibleRecognizedParticipants.length === 0" class="empty-state compact-empty">
        <div><strong>没有匹配的身份</strong><span>换一个名字、别名或身份 ID 再试。</span></div>
      </div>
      <div v-else class="identity-person-grid">
        <button
          v-for="item in visibleRecognizedParticipants"
          :key="item.id"
          type="button"
          class="identity-person-card"
          :aria-label="`打开${item.displayName || item.id}的身份详情`"
          @click="openIdentityWorkspace(item)"
          @keydown.enter.prevent="openIdentityWorkspace(item)"
          @keydown.space.prevent="openIdentityWorkspace(item)"
        >
          <div class="identity-person-head">
            <div class="identity-person-avatar" data-no-i18n>{{ participantInitial(item) }}</div>
            <div class="identity-person-title min-w-0">
              <div class="d-flex ga-2 align-center flex-wrap">
                <strong data-no-i18n>{{ item.displayName || item.id }}</strong>
                <v-chip v-if="item.status === 'corrected'" size="x-small" color="secondary" variant="tonal">已纠正</v-chip>
              </div>
              <div v-if="visibleAliases(item).length" class="identity-person-aliases" data-no-i18n>{{ visibleAliases(item).join('、') }}</div>
            </div>
            <v-icon class="identity-card-chevron" size="20">mdi-chevron-right</v-icon>
          </div>

          <div v-if="channelRowsForParticipant(item.id).length" class="identity-channel-rows">
            <div v-for="row in channelRowsForParticipant(item.id).slice(0, 3)" :key="row.channel" class="identity-channel-row">
              <span class="identity-channel-label"><v-icon size="15">{{ channelIcon(row.channel) }}</v-icon>{{ channelLabel(row.channel) }}</span>
              <span class="identity-card-channel-value" data-no-i18n>{{ cardChannelValue(row) }}</span>
            </div>
          </div>
          <div v-else class="identity-no-channel">尚未关联消息端账号</div>

          <div v-if="speakingHabitSummary(item)" class="identity-speaking-habit-summary">
            <v-icon size="14">mdi-fingerprint</v-icon><span>{{ speakingHabitSummary(item) }}</span>
          </div>
          <div class="identity-card-footer">
            <span>{{ identityDetailCounts(item) }}</span>
            <strong>查看与编辑</strong>
          </div>
        </button>
      </div>
      <div v-if="hiddenRecognizedCount" class="identity-show-more">
        <v-btn size="small" variant="text" append-icon="mdi-chevron-down" @click="showAllRecognized = true">查看全部 {{ filteredRecognizedParticipants.length }} 位身份</v-btn>
      </div>
      <div v-else-if="showAllRecognized && recognizedParticipants.length > 6 && !identityQuery.trim()" class="identity-show-more">
        <v-btn size="small" variant="text" append-icon="mdi-chevron-up" @click="showAllRecognized = false">收起身份列表</v-btn>
      </div>
      </v-card>

      <v-card variant="flat" class="identity-panel identity-unrecognized-panel">
      <div class="section-title-row compact-row">
        <div>
          <div class="section-title small-title">未识别身份</div>
          <div class="section-note">按消息端分类核对。QQ、微信和声纹只展示各自能确认的线索，不因同名自动合并。</div>
        </div>
        <div class="identity-panel-actions">
          <v-btn
            v-if="maintenanceParticipants.length"
            size="small"
            color="warning"
            variant="tonal"
            prepend-icon="mdi-account-alert-outline"
            @click="maintenanceDialog = true"
          >{{ maintenanceParticipants.length }} 条身份记录待处理</v-btn>
          <slot name="unidentified-actions" />
          <v-chip :color="totalUnidentifiedCount ? 'warning' : undefined" variant="tonal">{{ totalUnidentifiedCount }} 个账号</v-chip>
        </div>
      </div>
      <div v-if="loaded && unidentifiedChannels.length === 0" class="empty-state compact-empty identity-empty-state">
        <div><strong>当前没有未识别账号</strong><span>新的陌生账号出现后，会自动进入对应的消息端分类。</span></div>
      </div>
      <template v-else>
        <v-tabs v-model="activeUnidentifiedChannel" class="identity-channel-tabs" density="compact" color="secondary" show-arrows>
          <v-tab v-for="channel in unidentifiedChannels" :key="channel.channel" :value="channel.channel">
            <v-icon start>{{ channelIcon(channel.channel) }}</v-icon>{{ channelLabel(channel.channel) }}<span>{{ channel.count }}</span>
          </v-tab>
        </v-tabs>

        <div v-if="currentUnidentifiedGroup" class="identity-unrecognized-grid">
          <article v-for="account in currentUnidentifiedGroup.accounts" :key="account.id" class="identity-endpoint-card">
            <div class="identity-endpoint-card-main">
              <div class="min-w-0">
                <div class="d-flex ga-2 align-center flex-wrap">
                  <strong data-no-i18n>{{ account.displayName || account.senderStableId }}</strong>
                  <v-chip size="x-small" :color="account.conflicted ? 'warning' : 'secondary'" variant="tonal">{{ account.conflicted ? '有冲突' : '待识别' }}</v-chip>
                </div>
                <div class="identity-endpoint-id" data-no-i18n>{{ account.senderStableId }}</div>
              </div>
              <v-btn size="small" color="secondary" variant="tonal" @click="openAccount(account)">确认身份</v-btn>
            </div>
            <div v-if="account.participantLinks.length" class="identity-candidate-links">
              <span>候选</span>
              <v-chip
                v-for="link in account.participantLinks"
                :key="link.participantId"
                size="small"
                variant="outlined"
                @click="openParticipantReference(link.participantId)"
              >{{ participantName(link.participantId) }} · {{ statusLabel(link.status) }}</v-chip>
            </div>
          </article>
        </div>
        <slot
          v-if="activeUnidentifiedChannel === 'voice'"
          name="voice-endpoint"
          :participants="participants"
          :accounts="currentUnidentifiedGroup?.accounts ?? []"
        />
      </template>
      </v-card>
    </div>
  </v-card>

  <v-dialog v-model="situationDialog" max-width="900">
    <v-card class="app-card identity-support-dialog">
      <v-card-title class="identity-dialog-title">
        <div><strong>情景记录</strong><span>用于核对人格怎样理解已投递消息，不会自动创建计划、任务或项目记忆。</span></div>
        <v-btn icon="mdi-close" variant="text" @click="situationDialog = false" />
      </v-card-title>
      <v-card-text>
        <div class="d-flex justify-end mb-3"><v-btn size="small" variant="text" prepend-icon="mdi-refresh" :loading="situationsLoading" @click="refreshSituations">刷新记录</v-btn></div>
        <v-progress-linear v-if="situationsLoading" indeterminate color="secondary" class="mb-3" />
        <div v-if="situationsLoaded && situations.length === 0" class="empty-state compact-empty"><div><strong>还没有可回看的情景</strong><span>人格收到可定位的消息后，这里会显示不含聊天正文的判断记录。</span></div></div>
        <v-expansion-panels v-else variant="accordion">
          <v-expansion-panel v-for="item in situations" :key="item.id">
            <v-expansion-panel-title>
              <div class="d-flex ga-2 align-center flex-wrap"><strong>{{ item.topic.kind === 'project_discussion' ? '项目讨论' : '未判定项目' }}</strong><v-chip size="small" color="success" variant="tonal">可参与讨论</v-chip><v-chip size="small" color="warning" variant="tonal">不可管理项目记录</v-chip><span class="section-note">{{ compactTime(item.createdAt) }}</span></div>
            </v-expansion-panel-title>
            <v-expansion-panel-text>
              <div><strong>项目线索：</strong>{{ situationTopic(item) }}</div>
              <div class="mt-2"><strong>当前立场：</strong>{{ item.agentPosition === 'informed_peer' ? '知情同事，可围绕现场给出建议。' : '旁观理解，不把未知话题归入任何项目。' }}</div>
              <div class="mt-2"><strong>限制：</strong>{{ item.decisions.reason }}</div>
              <div v-if="item.evidence.unresolved.length" class="mt-2 text-warning"><strong>待确认：</strong>{{ item.evidence.unresolved.join('；') }}</div>
              <details class="mt-3 text-caption"><summary>查看技术定位信息</summary><div class="mt-2" data-no-i18n>会话：{{ item.conversationId || '无稳定会话键' }} · Route：{{ item.routeId }} · 消息：{{ item.messageIds.join('、') || '无稳定消息 ID' }}</div></details>
            </v-expansion-panel-text>
          </v-expansion-panel>
        </v-expansion-panels>
      </v-card-text>
    </v-card>
  </v-dialog>

  <v-dialog
    v-model="identityWorkspaceDialog"
    max-width="1040"
    scrollable
    persistent
    content-class="identity-workspace-dialog-shell"
  >
    <v-card v-if="activeIdentityParticipant" class="app-card identity-workspace-card">
      <v-card-title class="identity-workspace-header">
        <div class="identity-workspace-hero">
          <div class="identity-person-avatar identity-workspace-avatar" data-no-i18n>{{ participantInitial(activeIdentityParticipant) }}</div>
          <div class="min-w-0">
            <div class="d-flex ga-2 align-center flex-wrap">
              <strong data-no-i18n>{{ activeIdentityParticipant.displayName || activeIdentityParticipant.id }}</strong>
              <v-chip size="small" :color="statusColor(activeIdentityParticipant.status)" variant="tonal">{{ statusLabel(activeIdentityParticipant.status) }}</v-chip>
            </div>
            <span>在一个界面中查看和编辑基本信息、消息端账号、说话习惯与关系。</span>
          </div>
        </div>
        <v-btn icon="mdi-close" variant="text" aria-label="关闭身份详情" @click="requestCloseIdentityWorkspace" />
      </v-card-title>

      <v-card-text class="identity-workspace-body">
        <v-alert v-if="error" type="error" variant="tonal" density="compact">{{ error }}</v-alert>
        <v-alert v-if="notice" type="success" variant="tonal" density="compact">{{ notice }}</v-alert>

        <section class="identity-workspace-section">
          <div class="identity-workspace-section-head">
            <div>
              <strong>基本信息</strong>
              <span>名字、别名和确认状态会作为这个人的共同身份资料。</span>
            </div>
          </div>
          <div class="form-grid">
            <v-text-field v-model="participantForm.displayName" label="身份名字" />
            <v-select v-model="participantForm.participantKind" :items="participantKindOptions" label="类型" />
            <v-text-field v-model="participantForm.aliasesText" class="full-span" label="别名" hint="用逗号分隔。" persistent-hint />
            <v-select v-model="participantForm.status" :items="statusOptions" label="状态" />
            <v-textarea v-model="participantForm.evidenceNote" label="本次核对说明（可选）" rows="2" hint="只写简短可核对依据，不要粘贴私人聊天正文。" persistent-hint />
          </div>
          <details class="identity-technical-details">
            <summary>技术信息与已有依据</summary>
            <div class="identity-technical-grid">
              <div><span>身份 ID</span><code data-no-i18n>{{ participantForm.participantId }}</code></div>
              <div><span>最后更新</span><code data-no-i18n>{{ compactTime(activeIdentityParticipant.updatedAt) }}</code></div>
              <div><span>已有核对依据</span><code>{{ evidenceCount(activeIdentityParticipant.evidenceRefs) }} 条</code></div>
            </div>
          </details>
        </section>

        <section class="identity-workspace-section">
          <div class="identity-workspace-section-head">
            <div>
              <strong>说话习惯</strong>
              <span>用于共用账号等模糊场景的辅助核对，不能单独确认发言者。</span>
            </div>
            <v-btn size="small" variant="tonal" prepend-icon="mdi-plus" @click="addSpeakingHabit">添加说话习惯</v-btn>
          </div>
          <div v-if="participantForm.speakingHabits.length === 0" class="identity-inline-empty">还没有经过核对的说话习惯。</div>
          <div v-else class="identity-habit-list">
            <div v-for="(habit, index) in participantForm.speakingHabits" :key="index" class="identity-habit-card">
              <div class="identity-inline-editor-head">
                <strong>说话习惯 {{ index + 1 }}</strong>
                <v-btn size="small" variant="text" color="error" prepend-icon="mdi-delete-outline" @click="removeSpeakingHabit(index)">移除</v-btn>
              </div>
              <div class="form-grid">
                <v-select v-model="habit.dimension" :items="speakingHabitDimensionOptions" label="观察维度" />
                <v-text-field v-model.number="habit.confidence" type="number" min="0" max="1" step="0.05" label="置信度（可选）" />
                <v-textarea v-model="habit.description" class="full-span" label="习惯说明" rows="2" />
                <v-text-field v-model="habit.messageIdsText" class="full-span" label="证据消息 ID" hint="至少填写一条作者已经确认的消息 ID；用逗号分隔。" persistent-hint />
                <v-textarea v-model="habit.evidenceNote" class="full-span" label="本次补充说明（可选）" rows="2" />
              </div>
              <div v-if="evidenceCount(habit.evidenceRefs)" class="section-note">已保留 {{ evidenceCount(habit.evidenceRefs) }} 条原有依据。</div>
            </div>
          </div>
        </section>

        <section class="identity-workspace-section">
          <div class="identity-workspace-section-head">
            <div>
              <strong>消息端账号</strong>
              <span>QQ、微信、声纹和其它消息端都归在这里；共用账号会保留所有可能使用者。</span>
            </div>
            <v-btn size="small" variant="tonal" prepend-icon="mdi-link-plus" @click="openIdentityAccountEditor()">添加账号</v-btn>
          </div>

          <div v-if="activeIdentityAccounts.length === 0 && activeIdentityVoices.length === 0" class="identity-inline-empty">这个身份还没有关联消息端账号。</div>
          <div v-else class="identity-workspace-record-list">
            <article v-for="account in activeIdentityAccounts" :key="account.id" class="identity-workspace-record">
              <div class="identity-workspace-record-icon"><v-icon size="19">{{ channelIcon(endpointChannel(account.platform)) }}</v-icon></div>
              <div class="min-w-0">
                <div class="d-flex ga-2 align-center flex-wrap">
                  <strong data-no-i18n>{{ account.displayName || account.senderStableId }}</strong>
                  <v-chip v-if="account.conflicted" size="x-small" color="warning" variant="tonal">有冲突</v-chip>
                  <v-chip v-if="hasMultipleActiveAccountLinks(account)" size="x-small" color="secondary" variant="tonal">共用</v-chip>
                  <v-chip
                    v-if="accountLinkForParticipant(account, activeIdentityParticipant.id)"
                    size="x-small"
                    :color="statusColor(accountLinkForParticipant(account, activeIdentityParticipant.id)!.status)"
                    variant="tonal"
                  >{{ statusLabel(accountLinkForParticipant(account, activeIdentityParticipant.id)!.status) }}</v-chip>
                </div>
                <span data-no-i18n>{{ channelLabel(endpointChannel(account.platform)) }} · {{ accountValue(account) }}</span>
              </div>
              <v-btn size="small" variant="text" prepend-icon="mdi-pencil-outline" @click="openIdentityAccountEditor(account)">编辑</v-btn>
              <details class="identity-technical-details identity-record-details">
                <summary>账号技术信息</summary>
                <div class="identity-technical-grid">
                  <div><span>平台</span><code data-no-i18n>{{ account.platform }}</code></div>
                  <div><span>消息端命名空间</span><code data-no-i18n>{{ account.endpointIdentityNamespace }}</code></div>
                  <div><span>稳定发送者 ID</span><code data-no-i18n>{{ account.senderStableId }}</code></div>
                  <div><span>当前身份的关联依据</span><code>{{ evidenceCount(accountLinkForParticipant(account, activeIdentityParticipant.id)?.evidenceRefs ?? []) }} 条</code></div>
                  <div><span>最后更新</span><code data-no-i18n>{{ compactTime(account.updatedAt) }}</code></div>
                </div>
              </details>
            </article>

            <article v-for="voice in activeIdentityVoices" :key="voice.identityKey" class="identity-workspace-record">
              <div class="identity-workspace-record-icon"><v-icon size="19">mdi-account-voice</v-icon></div>
              <div class="min-w-0">
                <div class="d-flex ga-2 align-center flex-wrap">
                  <strong data-no-i18n>{{ voice.displayName || '声纹账号' }}</strong>
                  <v-chip v-if="voice.conflicted" size="x-small" color="warning" variant="tonal">有冲突</v-chip>
                  <v-chip v-else-if="voice.isUser === true" size="x-small" color="success" variant="tonal">当前人格</v-chip>
                  <v-chip v-else-if="voice.isUser === false" size="x-small" variant="tonal">其他人</v-chip>
                </div>
                <span data-no-i18n>{{ compactIdentifier(voice.voiceprintId) }}<template v-if="voice.sourceHostName"> · {{ voice.sourceHostName }}</template></span>
              </div>
              <v-btn size="small" variant="text" color="error" prepend-icon="mdi-link-off" @click="unlinkVoiceFromWorkspace(voice)">解除关联</v-btn>
              <details class="identity-technical-details identity-record-details">
                <summary>声纹账号信息</summary>
                <div class="identity-technical-grid">
                  <div><span>处理主机</span><code data-no-i18n>{{ voice.sourceHostName || voice.sourceHostId }}</code></div>
                  <div><span>声纹 ID</span><code data-no-i18n>{{ voice.voiceprintId }}</code></div>
                  <div><span>关系说明</span><code>{{ voice.relationship || '未填写' }}</code></div>
                  <div><span>别名</span><code data-no-i18n>{{ voice.aliases.join('、') || '未填写' }}</code></div>
                  <div><span>备注</span><code>{{ voice.notes || '未填写' }}</code></div>
                  <div><span>最后更新</span><code data-no-i18n>{{ compactTime(voice.updatedAt) }}</code></div>
                </div>
              </details>
            </article>
          </div>

          <div v-if="workspaceAccountEditorOpen" class="identity-inline-editor">
            <div class="identity-inline-editor-head">
              <div>
                <strong>{{ accountEditing ? '编辑消息端账号' : '添加消息端账号' }}</strong>
                <span>账号身份键只用于定位消息来源，不代表项目归属或授权。</span>
              </div>
              <v-btn size="small" variant="text" @click="workspaceAccountEditorOpen = false">取消编辑</v-btn>
            </div>
            <v-alert type="info" variant="tonal" density="compact" class="mb-3">共用账号可以保留多个“可能关联”，但不能同时确认成多个唯一人物。每条关联的核对说明分别保存，不会复制给其他候选。</v-alert>
            <div class="form-grid">
              <v-text-field v-model="accountForm.displayName" label="消息显示名（可选）" />
              <v-switch v-model="accountForm.isSelf" label="这是当前人格自身账号" color="success" inset hide-details />
            </div>
            <details class="identity-technical-details" :open="!accountEditing">
              <summary>账号身份键</summary>
              <div class="form-grid mt-3">
                <v-text-field v-model="accountForm.platform" label="平台" :readonly="accountEditing" placeholder="napcat / weixin / feishu / voice" />
                <v-text-field v-model="accountForm.endpointIdentityNamespace" label="消息端命名空间" :readonly="accountEditing" placeholder="bot:12345" />
                <v-text-field v-model="accountForm.senderStableId" class="full-span" label="稳定发送者 ID" :readonly="accountEditing" />
              </div>
            </details>
            <div class="identity-inline-subsection-head">
              <div><strong>身份关联</strong><span>编辑共用账号时必须保留其他使用者的真实候选。</span></div>
              <v-btn size="small" variant="tonal" prepend-icon="mdi-plus" @click="addAccountLink">添加关联</v-btn>
            </div>
            <div v-if="accountForm.participantLinks.length === 0" class="identity-inline-empty">至少添加一个身份关联。</div>
            <div v-for="(link, index) in accountForm.participantLinks" :key="index" class="identity-link-editor">
              <div class="form-grid">
                <v-select v-model="link.participantId" :items="participantOptions" label="身份" />
                <v-select v-model="link.status" :items="statusOptions" label="关联状态" />
                <v-text-field v-model.number="link.confidence" type="number" min="0" max="1" step="0.05" label="置信度（可选）" />
                <v-btn class="align-self-center" size="small" variant="text" color="error" prepend-icon="mdi-delete-outline" @click="removeAccountLink(index)">移除关联</v-btn>
                <v-textarea v-model="link.evidenceNote" class="full-span" label="这条关联的核对说明（可选）" rows="2" />
              </div>
              <div v-if="evidenceCount(link.evidenceRefs)" class="section-note">已保留 {{ evidenceCount(link.evidenceRefs) }} 条原有依据。</div>
            </div>
            <div class="identity-inline-editor-actions">
              <v-btn variant="text" @click="workspaceAccountEditorOpen = false">取消</v-btn>
              <v-btn color="secondary" :loading="saving" @click="saveIdentityAccount">保存账号</v-btn>
            </div>
          </div>
        </section>

        <section class="identity-workspace-section">
          <div class="identity-workspace-section-head">
            <div>
              <strong>关系</strong>
              <span>统一记录这个身份与人、组织或项目之间的关系；当前消息里的临时角色仍由情景记录表示。</span>
            </div>
            <v-btn size="small" variant="tonal" prepend-icon="mdi-account-network-outline" @click="openIdentityRelationEditor()">添加关系</v-btn>
          </div>

          <div v-if="activeIdentityRelations.length === 0" class="identity-inline-empty">这个身份还没有关系记录。</div>
          <div v-else class="identity-workspace-record-list">
            <article v-for="relation in activeIdentityRelations" :key="relation.id" class="identity-workspace-record">
              <div class="identity-workspace-record-icon"><v-icon size="19">mdi-account-network-outline</v-icon></div>
              <div class="min-w-0">
                <div class="d-flex ga-2 align-center flex-wrap">
                  <strong>{{ relationLabel(relation) }}</strong>
                  <v-chip size="x-small" :color="relation.conflicted ? 'warning' : statusColor(relation.status)" variant="tonal">{{ relation.conflicted ? '有冲突' : statusLabel(relation.status) }}</v-chip>
                </div>
                <span>{{ relationScopeSummary(relation) }}</span>
              </div>
              <v-btn size="small" variant="text" prepend-icon="mdi-pencil-outline" @click="openIdentityRelationEditor(relation)">编辑</v-btn>
              <details class="identity-technical-details identity-record-details">
                <summary>关系范围与依据</summary>
                <div class="identity-technical-grid">
                  <div><span>关系对象类型</span><code data-no-i18n>{{ relation.targetKind }}</code></div>
                  <div><span>关系对象 ID</span><code data-no-i18n>{{ relation.targetId }}</code></div>
                  <div><span>适用会话</span><code data-no-i18n>{{ relation.scope.conversationKeys.join('、') || '未限制' }}</code></div>
                  <div><span>适用项目</span><code data-no-i18n>{{ relation.scope.projectIds.join('、') || '未限制' }}</code></div>
                  <div><span>核对依据</span><code>{{ evidenceCount(relation.evidenceRefs) }} 条</code></div>
                  <div><span>最后更新</span><code data-no-i18n>{{ compactTime(relation.updatedAt) }}</code></div>
                </div>
              </details>
            </article>
          </div>

          <div v-if="workspaceRelationEditorOpen" class="identity-inline-editor">
            <div class="identity-inline-editor-head">
              <div>
                <strong>{{ relationEditing ? '编辑关系' : '添加关系' }}</strong>
                <span>当前消息里的临时角色由情景记录表示，不需要另建一类关系。</span>
              </div>
              <v-btn size="small" variant="text" @click="workspaceRelationEditorOpen = false">取消编辑</v-btn>
            </div>
            <div class="form-grid">
              <v-text-field :model-value="participantName(relationForm.subjectParticipantId)" label="当前身份" readonly />
              <v-select v-model="relationForm.targetKind" :items="relationTargetOptions" label="关系对象类型" />
              <v-select v-if="relationForm.targetKind === 'participant'" v-model="relationForm.targetId" :items="participantOptions" label="关系对象" />
              <v-text-field v-else v-model="relationForm.targetId" label="关系对象 ID" />
              <v-text-field v-model="relationForm.relationship" label="关系说明" placeholder="例如：同事、参与项目讨论" />
              <v-select v-model="relationForm.status" :items="statusOptions" label="状态" />
              <v-textarea v-model="relationForm.evidenceNote" class="full-span" label="本次核对说明（可选）" rows="2" />
            </div>
            <details class="identity-technical-details">
              <summary>适用范围与技术信息</summary>
              <div class="form-grid mt-3">
                <v-text-field v-model="relationForm.relationId" label="关系 ID" :readonly="relationEditing" hint="留空时自动生成。" persistent-hint />
                <v-text-field v-model="relationForm.conversationKeysText" label="适用会话（可选）" hint="用逗号分隔；留空表示不按会话限制。" persistent-hint />
                <v-text-field v-model="relationForm.projectIdsText" class="full-span" label="适用项目（可选）" hint="用逗号分隔；留空表示不按项目限制。" persistent-hint />
              </div>
            </details>
            <div class="identity-inline-editor-actions">
              <v-btn variant="text" @click="workspaceRelationEditorOpen = false">取消</v-btn>
              <v-btn color="secondary" :loading="saving" @click="saveIdentityRelation">保存关系</v-btn>
            </div>
          </div>
        </section>
      </v-card-text>

      <v-card-actions class="identity-workspace-actions">
        <span>基本信息和说话习惯一起保存；账号和关系在各自编辑区单独保存。</span>
        <v-spacer />
        <v-btn variant="text" @click="requestCloseIdentityWorkspace">关闭</v-btn>
        <v-btn color="secondary" :loading="saving" @click="saveIdentityParticipant">保存身份资料</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>

  <v-dialog v-model="maintenanceDialog" max-width="820">
    <v-card class="app-card identity-support-dialog">
      <v-card-title class="identity-dialog-title">
        <div><strong>需要处理的身份记录</strong><span>候选、冲突和停用记录不会参与自动身份判断；确认或纠正后才会进入已识别身份。</span></div>
        <v-btn icon="mdi-close" variant="text" @click="maintenanceDialog = false" />
      </v-card-title>
      <v-card-text>
        <div class="identity-maintenance-list">
          <div v-for="item in maintenanceParticipants" :key="item.id" class="identity-maintenance-row">
            <div class="min-w-0">
              <div class="d-flex ga-2 align-center flex-wrap"><strong data-no-i18n>{{ item.displayName || item.id }}</strong><v-chip size="small" :color="item.conflicted ? 'warning' : statusColor(item.status)" variant="tonal">{{ item.conflicted ? '有冲突' : statusLabel(item.status) }}</v-chip></div>
              <div v-if="item.aliases.length" class="section-note mt-1" data-no-i18n>{{ item.aliases.join('、') }}</div>
              <details v-if="item.conflicted" class="mt-2 text-caption"><summary>查看冲突候选</summary><div v-for="candidate in item.conflictCandidates" :key="candidate.eventId" class="mt-1" data-no-i18n>{{ candidate.eventId.slice(-8) }} · {{ recordSummary(candidate.record) }}</div></details>
            </div>
            <v-btn size="small" color="secondary" variant="tonal" @click="openParticipant(item)">处理</v-btn>
          </div>
        </div>
      </v-card-text>
    </v-card>
  </v-dialog>

  <v-dialog v-model="participantDialog" max-width="640"><v-card class="app-card"><v-card-title>{{ participantEditing ? '编辑身份' : '新增身份' }}</v-card-title><v-card-text><div class="form-grid"><v-text-field v-model="participantForm.participantId" label="身份 ID" :readonly="participantEditing" hint="留空时自动生成；已有 ID 不能改名。" persistent-hint /><v-select v-model="participantForm.participantKind" :items="participantKindOptions" label="类型" /><v-text-field v-model="participantForm.displayName" label="身份名字" /><v-select v-model="participantForm.status" :items="statusOptions" label="状态" /><v-text-field v-model="participantForm.aliasesText" class="full-span" label="别名" hint="用逗号分隔。" persistent-hint /><v-textarea v-model="participantForm.evidenceNote" class="full-span" label="本次核对说明（可选）" rows="2" hint="只写简短可核对依据，不要粘贴私人聊天正文。" persistent-hint /></div></v-card-text><v-card-actions><v-spacer /><v-btn variant="text" @click="participantDialog = false">取消</v-btn><v-btn color="secondary" :loading="saving" @click="saveParticipant">保存</v-btn></v-card-actions></v-card></v-dialog>

  <v-dialog v-model="accountDialog" max-width="760"><v-card class="app-card"><v-card-title>{{ accountEditing ? '编辑账号关联' : '关联消息端账号' }}</v-card-title><v-card-text><v-alert type="warning" variant="tonal" density="compact" class="mb-3">平台、消息端命名空间和稳定发送者 ID 是身份键。它们不能用昵称、Route 或群号替代。</v-alert><v-alert type="info" variant="tonal" density="compact" class="mb-3">共用账号可以同时添加多个“可能关联”。每条关联分别保存核对说明；说话习惯一致性只能辅助判断当前使用者，不能把账号保存成多个“已确认”映射。</v-alert><div class="form-grid"><v-text-field v-model="accountForm.platform" label="平台" :readonly="accountEditing" placeholder="napcat / feishu / wecom" /><v-text-field v-model="accountForm.endpointIdentityNamespace" label="消息端命名空间" :readonly="accountEditing" placeholder="bot:12345" /><v-text-field v-model="accountForm.senderStableId" label="稳定发送者 ID" :readonly="accountEditing" /><v-text-field v-model="accountForm.displayName" label="消息显示名（可选）" /><v-switch v-model="accountForm.isSelf" label="这是当前人格自身账号" color="success" inset hide-details /></div><div class="section-title-row compact-row mt-5"><div><div class="section-title small-title">身份关联</div><div class="section-note">确认账号属于谁，不等于确认项目归属或授权。</div></div><v-btn size="small" variant="tonal" prepend-icon="mdi-plus" @click="addAccountLink">添加关联</v-btn></div><div v-for="(link, index) in accountForm.participantLinks" :key="index" class="rule-card mb-2"><div class="form-grid"><v-select v-model="link.participantId" :items="participantOptions" label="身份" /><v-select v-model="link.status" :items="statusOptions" label="关联状态" /><v-text-field v-model.number="link.confidence" type="number" min="0" max="1" step="0.05" label="置信度（可选）" /><v-btn class="align-self-center" size="small" variant="text" color="error" @click="removeAccountLink(index)">移除</v-btn><v-textarea v-model="link.evidenceNote" class="full-span" label="这条关联的核对说明（可选）" rows="2" /></div></div></v-card-text><v-card-actions><v-spacer /><v-btn variant="text" @click="accountDialog = false">取消</v-btn><v-btn color="secondary" :loading="saving" @click="saveAccount">保存</v-btn></v-card-actions></v-card></v-dialog>
</template>
