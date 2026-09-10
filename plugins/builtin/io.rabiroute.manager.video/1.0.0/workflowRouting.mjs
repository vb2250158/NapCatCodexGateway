// Candidate order is catalog policy, never an estimate of measured generation speed.
export function workflowCandidates(model, command, available) {
  const requested = command.quickGeneration ? "fast" : "standard";
  return Object.entries(model.workflows || {}).filter(([id, profile]) => {
    if ((profile.kind || id) !== requested || profile.enabled === false) return false;
    const rule = profile.conditions || {};
    if (rule.generateAudio !== undefined && rule.generateAudio !== !!command.generateAudio) return false;
    if (rule.minShortEdge && Math.min(command.width, command.height) < rule.minShortEdge) return false;
    if (rule.maxFrames && command.frames > rule.maxFrames) return false;
    if (rule.referenceKinds && (command.referenceKinds || []).some(kind => !rule.referenceKinds.includes(kind))) return false;
    return !available || available.some(row => row.model === model.id && row.workflowId === id && row.generateAudio === !!command.generateAudio);
  }).sort((a,b) => (b[1].priority || 0) - (a[1].priority || 0) || a[0].localeCompare(b[0]));
}

export function selectWorkflow(model, command, available) {
  if (!model.workflows) return model.id;
  // Historical requests and persisted jobs retain their original route.
  if (command.workflowId || command.quickGeneration === undefined) {
    const id = command.workflowId || model.defaultWorkflow;
    if (!model.workflows[id]) throw new Error("任务记录的工作流已不可用。");
    return id;
  }
  const candidate = workflowCandidates(model,command,available)[0];
  if (!candidate) throw new Error("没有已就绪且兼容当前输入的工作流，请检查模型管理或关闭快速生成。");
  return candidate[0];
}
