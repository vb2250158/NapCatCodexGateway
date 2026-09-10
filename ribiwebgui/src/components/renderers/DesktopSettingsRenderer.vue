<script setup lang="ts">
import { userFacingError } from "../../userFacingError";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { DesktopTheme } from "@shared/desktopSettingsContract";
import {
  cloneBuiltinInterfaceTheme,
  interfaceThemeContrastFailures,
  INTERFACE_THEME_COLOR_KEYS,
  isInterfaceThemeHexColor,
  readableInterfaceThemeForeground,
  type CustomInterfaceTheme,
  type InterfaceThemeBase,
  type InterfaceThemeColorKey
} from "@shared/interfaceThemeContract";
import { resolveSelectionSpeechModel, type SelectionSpeechSettings } from "@shared/selectionSpeechContract";
import type { SpeechModel } from "@shared/speechControlContract";
import { desktopSettingsClient } from "../../desktopSettingsClient";
import { publishInterfaceTheme } from "../../interfaceTheme";
import { registerPageSaveAction } from "../../pageSaveAction";
import { pluginCatalogStore } from "../../pluginCatalogStore";
import { speechControlClient } from "../../speech/speechControlClient";
import {
  replaceCustomWebThemeResources,
  resolveWebThemeResource,
  type WebThemeId
} from "../../pluginThemes";

const desktopScreenshotEnabled = ref(false);
const desktopScreenshotShortcut = ref("Ctrl+Shift+S");
const desktopScreenshotShortcutCapturing = ref(false);
const desktopScreenshotClipboardShortcut = ref("F3");
const desktopScreenshotClipboardShortcutCapturing = ref(false);
const desktopScreenshotAutoCopy = ref(true);
const desktopAutostart = ref(false);
const desktopTheme = ref<WebThemeId>("system");
const persistedDesktopTheme = ref<DesktopTheme>("system");
const persistedWebTheme = ref<WebThemeId>("system");
const customThemes = ref<CustomInterfaceTheme[]>([]);
const customThemeDialog = ref(false);
const customThemeSaving = ref(false);
const customThemeError = ref("");
const customThemeDraft = ref<CustomInterfaceTheme | null>(null);
const customThemeBaseline = ref("");
const customThemeColorErrors = ref<Partial<Record<InterfaceThemeColorKey, string>>>({});
const customThemeOpenColorGroups = ref<number[]>([0, 1]);
const selectionSpeechEnabled = ref(false);
const selectionReadAloudEnabled = ref(true);
const selectionSpeechAdvanced = ref(false);
const selectionSpeechModel = ref("");
const selectionSpeechModels = ref<SpeechModel[]>([]);
const selectionSpeechLoaded = ref(false);
const selectionSpeechError = ref("");
const loaded = ref(false);
const hydrating = ref(true);
const saving = ref(false);
const desktopDirty = ref(false);
const selectionSpeechDirty = ref(false);
const dirty = computed(() => desktopDirty.value || selectionSpeechDirty.value);
const error = ref("");
const themeOptions = computed(() => pluginCatalogStore.themes.value.options);
const selectedCustomTheme = computed(() => customThemes.value.find(item => item.id === desktopTheme.value));
const themeColorFields: readonly { key: InterfaceThemeColorKey; label: string }[] = INTERFACE_THEME_COLOR_KEYS.map(key => ({
  key,
  label: ({
    pageCanvas: "页面底色", canvas: "内容底色", surface: "卡片表面", subtle: "次级表面", input: "输入框",
    border: "边框", borderStrong: "强调边框", text: "正文", heading: "标题", muted: "次要文字",
    accent: "强调色", accentStrong: "强调深色", success: "成功 / 开启", warning: "警告", error: "错误",
    info: "信息", switchTrack: "关闭轨道", switchThumb: "开关圆点"
  } satisfies Record<InterfaceThemeColorKey, string>)[key]
}));
const themeColorGroups = [
  { title: "表面与边框", keys: ["pageCanvas", "canvas", "surface", "subtle", "input", "border", "borderStrong"] },
  { title: "文字", keys: ["text", "heading", "muted"] },
  { title: "强调与状态", keys: ["accent", "accentStrong", "success", "warning", "error", "info"] },
  { title: "开关", keys: ["switchTrack", "switchThumb"] }
].map(group => ({
  title: group.title,
  fields: group.keys.map(key => themeColorFields.find(field => field.key === key)!)
}));
const customThemePreviewStyle = computed(() => {
  const draft = customThemeDraft.value;
  if (!draft) return {};
  return {
    background: draft.colors.surface,
    color: draft.colors.text,
    borderColor: draft.colors.border,
    borderRadius: `${draft.styles.cornerRadius}px`,
    boxShadow: draft.styles.shadow === "none"
      ? "none"
      : draft.styles.shadow === "strong"
        ? `0 14px 30px color-mix(in srgb, ${draft.colors.text} 28%, transparent)`
        : `0 8px 20px color-mix(in srgb, ${draft.colors.text} 14%, transparent)`
  };
});
const customThemePreviewButtonStyle = computed(() => {
  const accent = customThemeDraft.value?.colors.accent;
  if (!accent) return {};
  return { background: accent, color: readableInterfaceThemeForeground(accent) };
});
const ready = computed(() => loaded.value && (!selectionSpeechDirty.value || selectionSpeechLoaded.value));
let unregisterSaveAction: (() => void) | undefined;

async function loadDesktopSettings(): Promise<void> {
  try {
    const settings = await desktopSettingsClient.read();
    desktopScreenshotEnabled.value = settings.screenshot.enabled;
    desktopScreenshotShortcut.value = settings.screenshot.shortcut;
    desktopScreenshotClipboardShortcut.value = settings.screenshot.clipboardShortcut;
    desktopScreenshotAutoCopy.value = settings.screenshot.autoCopy;
    desktopAutostart.value = settings.autostart;
    persistedDesktopTheme.value = settings.theme;
    persistedWebTheme.value = settings.webTheme;
    customThemes.value = [...replaceCustomWebThemeResources(settings.customThemes)];
    desktopTheme.value = resolveWebThemeResource(pluginCatalogStore.themes.value, settings.webTheme).themeId;
    loaded.value = true;
    error.value = "";
  } catch (cause) {
    error.value = userFacingError(cause);
  }
}

async function loadSelectionSpeechSettings(): Promise<void> {
  try {
    const [settings, modelPayload] = await Promise.all([
      speechControlClient.selectionReaderSettings(),
      speechControlClient.models()
    ]);
    selectionSpeechEnabled.value = settings.enabled;
    selectionReadAloudEnabled.value = settings.readAloudEnabled;
    selectionSpeechAdvanced.value = settings.advanced;
    selectionSpeechModel.value = settings.model;
    selectionSpeechModels.value = modelPayload.models || [];
    if (selectionSpeechAdvanced.value) {
      selectionSpeechModel.value = resolveSelectionSpeechModel(settings, selectionSpeechModels.value);
    }
    selectionSpeechLoaded.value = true;
    selectionSpeechError.value = "";
  } catch (cause) {
    selectionSpeechError.value = userFacingError(cause);
  }
}

async function load(): Promise<void> {
  hydrating.value = true;
  try {
    await Promise.all([loadDesktopSettings(), loadSelectionSpeechSettings()]);
    await nextTick();
    desktopDirty.value = false;
    selectionSpeechDirty.value = false;
  } finally {
    hydrating.value = false;
  }
}

async function saveDesktopSettings(): Promise<void> {
  const selectedTheme = resolveWebThemeResource(pluginCatalogStore.themes.value, desktopTheme.value);
  const nextDesktopTheme = selectedTheme.desktopTheme ?? persistedDesktopTheme.value;
  try {
    const settings = await desktopSettingsClient.update({
      screenshot: {
        enabled: desktopScreenshotEnabled.value,
        shortcut: desktopScreenshotShortcut.value,
        clipboardShortcut: desktopScreenshotClipboardShortcut.value,
        autoCopy: desktopScreenshotAutoCopy.value
      },
      autostart: desktopAutostart.value,
      theme: nextDesktopTheme,
      webTheme: selectedTheme.themeId,
      customThemes: customThemes.value
    });
    desktopScreenshotEnabled.value = settings.screenshot.enabled;
    desktopScreenshotShortcut.value = settings.screenshot.shortcut;
    desktopScreenshotClipboardShortcut.value = settings.screenshot.clipboardShortcut;
    desktopScreenshotAutoCopy.value = settings.screenshot.autoCopy;
    desktopAutostart.value = settings.autostart;
    persistedDesktopTheme.value = settings.theme;
    persistedWebTheme.value = settings.webTheme;
    customThemes.value = [...replaceCustomWebThemeResources(settings.customThemes)];
    desktopTheme.value = selectedTheme.themeId;
    publishInterfaceTheme(selectedTheme.themeId);
    error.value = "";
  } catch (cause) {
    error.value = userFacingError(cause);
    throw cause;
  }
}

function customThemeId(): CustomInterfaceTheme["id"] {
  return `custom:${crypto.randomUUID().toLowerCase()}`;
}

function clonedTheme(baseTheme: InterfaceThemeBase): Pick<CustomInterfaceTheme, "baseTheme" | "colors" | "styles"> {
  return cloneBuiltinInterfaceTheme(baseTheme);
}

function openCustomThemeEditor(mode: "clone" | "edit"): void {
  const selected = resolveWebThemeResource(pluginCatalogStore.themes.value, desktopTheme.value);
  if (mode === "edit" && selected.customTheme) {
    customThemeDraft.value = structuredClone(selected.customTheme);
  } else {
    const base = selected.customTheme
      ? structuredClone(selected.customTheme)
      : clonedTheme(selected.apply(window.matchMedia("(prefers-color-scheme: dark)").matches));
    customThemeDraft.value = {
      id: customThemeId(),
      name: `${selected.label} 副本`.slice(0, 40),
      baseTheme: base.baseTheme,
      colors: { ...base.colors },
      styles: { ...base.styles }
    };
  }
  customThemeError.value = "";
  customThemeColorErrors.value = {};
  customThemeDialog.value = true;
  customThemeBaseline.value = JSON.stringify(customThemeDraft.value);
}

function collectCustomThemeColorErrors(): Partial<Record<InterfaceThemeColorKey, string>> {
  const draft = customThemeDraft.value;
  if (!draft) return {};
  const errors: Partial<Record<InterfaceThemeColorKey, string>> = {};
  for (const key of INTERFACE_THEME_COLOR_KEYS) {
    if (!isInterfaceThemeHexColor(draft.colors[key])) errors[key] = "请输入 #RRGGBB 六位色值。";
  }
  if (Object.keys(errors).length) return errors;
  for (const failure of interfaceThemeContrastFailures(draft)) {
    const key = failure.foreground as InterfaceThemeColorKey;
    if (errors[key]) continue;
    errors[key] = failure.kind === "base"
      ? "该表面颜色的亮暗与所选浅色或深色基底不一致，请调整颜色或切换基底。"
      : failure.kind === "semantic"
        ? "该状态色无法在状态底色和组件色调底色上生成清晰文字，请调整颜色。"
        : "该文字颜色在页面、卡片、输入区或状态底色上的对比度需至少 4.5:1。";
  }
  return errors;
}

function validateCustomThemeColors(): boolean {
  customThemeColorErrors.value = collectCustomThemeColorErrors();
  return Object.keys(customThemeColorErrors.value).length === 0;
}

function closeCustomThemeEditor(): void {
  if (customThemeSaving.value) return;
  const changed = JSON.stringify(customThemeDraft.value) !== customThemeBaseline.value;
  if (changed && !window.confirm("当前主题有未保存修改，确定放弃吗？")) return;
  customThemeDialog.value = false;
}

async function saveCustomTheme(): Promise<void> {
  const draft = customThemeDraft.value;
  if (!draft || customThemeSaving.value) return;
  draft.name = draft.name.trim();
  if (!draft.name) {
    customThemeError.value = "请先填写主题名称。";
    return;
  }
  const duplicate = customThemes.value.some(item => item.id !== draft.id && item.name.toLocaleLowerCase() === draft.name.toLocaleLowerCase());
  if (duplicate) {
    customThemeError.value = "主题名称已存在，请换一个名称。";
    return;
  }
  if (!validateCustomThemeColors()) {
    customThemeError.value = "请修正颜色格式或对比度后再保存。";
    void nextTick(() => document.querySelector<HTMLElement>(".custom-theme-color-field .v-input--error input")?.focus());
    return;
  }
  customThemeSaving.value = true;
  const wasDirty = desktopDirty.value;
  hydrating.value = true;
  try {
    const savedDraft: CustomInterfaceTheme = {
      id: draft.id,
      name: draft.name,
      baseTheme: draft.baseTheme,
      colors: { ...draft.colors },
      styles: { ...draft.styles }
    };
    const nextThemes = [...customThemes.value.filter(item => item.id !== draft.id), savedDraft];
    const settings = await desktopSettingsClient.update({ customThemes: nextThemes, theme: draft.id, webTheme: draft.id });
    customThemes.value = [...replaceCustomWebThemeResources(settings.customThemes)];
    persistedDesktopTheme.value = settings.theme;
    persistedWebTheme.value = settings.webTheme;
    desktopTheme.value = settings.webTheme;
    publishInterfaceTheme(settings.webTheme);
    customThemeDialog.value = false;
    customThemeError.value = "";
    await nextTick();
    desktopDirty.value = wasDirty;
  } catch (cause) {
    customThemeError.value = userFacingError(cause);
  } finally {
    hydrating.value = false;
    customThemeSaving.value = false;
  }
}

async function saveSelectionSpeechSettings(): Promise<void> {
  const settings: SelectionSpeechSettings = {
    enabled: selectionSpeechEnabled.value,
    readAloudEnabled: selectionReadAloudEnabled.value,
    advanced: selectionSpeechAdvanced.value,
    model: selectionSpeechModel.value
  };
  try {
    const saved = await speechControlClient.updateSelectionReaderSettings(settings);
    selectionSpeechEnabled.value = saved.enabled;
    selectionReadAloudEnabled.value = saved.readAloudEnabled;
    selectionSpeechAdvanced.value = saved.advanced;
    selectionSpeechModel.value = saved.model;
    selectionSpeechError.value = "";
  } catch (cause) {
    selectionSpeechError.value = userFacingError(cause);
    throw cause;
  }
}

async function save(): Promise<void> {
  if (!ready.value || saving.value) throw new Error("桌面设置尚未加载完成。");
  const tasks = [
    ...(desktopDirty.value ? [{ dirty: desktopDirty, run: saveDesktopSettings }] : []),
    ...(selectionSpeechDirty.value ? [{ dirty: selectionSpeechDirty, run: saveSelectionSpeechSettings }] : [])
  ];
  if (!tasks.length) return;

  saving.value = true;
  hydrating.value = true;
  try {
    const results = await Promise.allSettled(tasks.map(task => task.run()));
    const failures: string[] = [];
    results.forEach((result, index) => {
      const task = tasks[index];
      if (!task) return;
      if (result.status === "fulfilled") {
        task.dirty.value = false;
        return;
      }
      failures.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
    });
    await nextTick();
    if (failures.length) throw new Error(failures.join("；"));
  } finally {
    hydrating.value = false;
    saving.value = false;
  }
}

function normalizeScreenshotShortcut(): void {
  desktopScreenshotShortcut.value = desktopScreenshotShortcut.value.trim().replace(/\s*\+\s*/g, "+");
}

function normalizeScreenshotClipboardShortcut(): void {
  desktopScreenshotClipboardShortcut.value = desktopScreenshotClipboardShortcut.value.trim().replace(/\s*\+\s*/g, "+");
}

function screenshotShortcutFromKeyEvent(event: KeyboardEvent): string | null {
  const key = event.key === " " ? "SPACE" : event.key.toUpperCase();
  const functionKey = /^(F[1-9]|F1[0-2])$/.test(key);
  const validKey = /^[A-Z0-9]$/.test(key) || functionKey || /^(SPACE|TAB|ENTER|ESCAPE)$/.test(key);
  if (!validKey) return null;
  const modifiers = [
    event.ctrlKey ? "Ctrl" : "",
    event.altKey ? "Alt" : "",
    event.shiftKey ? "Shift" : "",
    event.metaKey ? "Win" : ""
  ].filter(Boolean);
  if (!modifiers.length && !functionKey) return null;
  return [...modifiers, key === "ESCAPE" ? "Esc" : key[0] + key.slice(1).toLowerCase()].join("+");
}

function captureShortcut(event: KeyboardEvent, target: "capture" | "clipboard"): void {
  const shortcut = screenshotShortcutFromKeyEvent(event);
  if (!shortcut) return;
  event.preventDefault();
  event.stopPropagation();
  if (target === "capture") {
    desktopScreenshotShortcut.value = shortcut;
    desktopScreenshotShortcutCapturing.value = false;
  } else {
    desktopScreenshotClipboardShortcut.value = shortcut;
    desktopScreenshotClipboardShortcutCapturing.value = false;
  }
}

watch([
  desktopScreenshotEnabled,
  desktopScreenshotShortcut,
  desktopScreenshotClipboardShortcut,
  desktopScreenshotAutoCopy,
  desktopAutostart,
  desktopTheme
], () => {
  if (!hydrating.value) desktopDirty.value = true;
});

watch(desktopTheme, theme => {
  if (!hydrating.value && loaded.value) publishInterfaceTheme(theme);
});

watch([
  selectionSpeechEnabled,
  selectionReadAloudEnabled,
  selectionSpeechAdvanced,
  selectionSpeechModel
], () => {
  if (!hydrating.value && selectionSpeechLoaded.value) selectionSpeechDirty.value = true;
});

watch(themeOptions, options => {
  if (!loaded.value || options.some(option => option.themeId === desktopTheme.value)) return;
  desktopTheme.value = resolveWebThemeResource(pluginCatalogStore.themes.value, persistedWebTheme.value).themeId;
  if (!options.some(option => option.themeId === desktopTheme.value)) {
    desktopTheme.value = resolveWebThemeResource(pluginCatalogStore.themes.value, persistedDesktopTheme.value).themeId;
  }
  publishInterfaceTheme(desktopTheme.value);
});

onMounted(() => {
  unregisterSaveAction = registerPageSaveAction({ dirty, ready, saving, save });
  void load();
});

onBeforeUnmount(() => {
  unregisterSaveAction?.();
  unregisterSaveAction = undefined;
});
</script>

<template>
  <v-card class="app-card glass-card section-card">
    <div class="section-title-row">
      <div>
        <div class="section-title">RabiRoute 桌面功能</div>
        <div class="section-note">RabiRoute 在 Windows 中提供截图、系统划词、主题和登录启动设置。</div>
      </div>
    </div>
    <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-3">{{ error }}</v-alert>
    <div class="section-title-row compact-row mb-2">
      <div>
        <div class="section-title small-title">界面主题</div>
        <div class="section-note">自定义主题从当前选择复制；保存后同步到 WebGUI 与 Windows 桌面。</div>
      </div>
      <div class="theme-actions">
        <v-btn-toggle v-model="desktopTheme" color="secondary" density="compact" mandatory divided :disabled="!loaded" class="theme-options">
          <v-btn v-for="option in themeOptions" :key="option.webResourceId" :value="option.themeId" :prepend-icon="option.icon">
            {{ option.label }}
          </v-btn>
        </v-btn-toggle>
        <v-btn class="theme-action-button" prepend-icon="mdi-palette-plus-outline" variant="outlined" color="secondary" :disabled="!loaded" @click="openCustomThemeEditor('clone')">
          添加自定义主题
        </v-btn>
        <v-btn v-if="selectedCustomTheme" icon="mdi-pencil-outline" variant="text" color="secondary" aria-label="编辑当前自定义主题" @click="openCustomThemeEditor('edit')" />
      </div>
    </div>
    <v-dialog v-model="customThemeDialog" max-width="980" persistent scrollable>
      <v-card v-if="customThemeDraft" class="custom-theme-dialog">
        <v-card-title>编辑自定义主题</v-card-title>
        <v-card-subtitle>已复制当前主题参数；保存后会立即应用，并保留在主题选项中。</v-card-subtitle>
        <v-card-text>
          <v-alert v-if="customThemeError" role="alert" type="error" variant="tonal" density="compact" class="mb-4">{{ customThemeError }}</v-alert>
          <div class="custom-theme-heading-grid">
            <v-text-field v-model="customThemeDraft.name" label="主题名称" maxlength="40" counter="40" autofocus />
            <v-select
              v-model="customThemeDraft.baseTheme"
              label="界面基底"
              :items="[{ title: '浅色', value: 'light' }, { title: '深色', value: 'dark' }]"
              hint="决定系统控件和未单独配置区域采用浅色还是深色语义。"
              persistent-hint
            />
          </div>
          <div class="section-title small-title mb-2">颜色</div>
          <v-expansion-panels v-model="customThemeOpenColorGroups" multiple variant="accordion" class="custom-theme-color-groups">
            <v-expansion-panel v-for="group in themeColorGroups" :key="group.title">
              <v-expansion-panel-title>{{ group.title }}</v-expansion-panel-title>
              <v-expansion-panel-text>
                <div class="custom-theme-color-grid">
                  <label v-for="field in group.fields" :key="field.key" class="custom-theme-color-field">
                    <span>{{ field.label }}</span>
                    <div>
                      <input
                        v-model="customThemeDraft.colors[field.key]"
                        type="color"
                        :aria-label="`${field.label}颜色`"
                        @change="validateCustomThemeColors"
                      >
                      <v-text-field
                        v-model="customThemeDraft.colors[field.key]"
                        density="compact"
                        maxlength="7"
                        :aria-label="`${field.label}十六进制色值`"
                        :error-messages="customThemeColorErrors[field.key]"
                        hide-details="auto"
                        @blur="validateCustomThemeColors"
                      />
                    </div>
                  </label>
                </div>
              </v-expansion-panel-text>
            </v-expansion-panel>
          </v-expansion-panels>
          <v-divider class="my-5" />
          <div class="section-title small-title mb-2">样式</div>
          <div class="custom-theme-style-grid">
            <div>
              <div class="custom-theme-field-label">卡片圆角：{{ customThemeDraft.styles.cornerRadius }}px</div>
              <v-slider v-model="customThemeDraft.styles.cornerRadius" :min="0" :max="24" :step="1" color="secondary" hide-details />
            </div>
            <div>
              <div class="custom-theme-field-label">表面透明度：{{ customThemeDraft.styles.glassOpacity }}%</div>
              <v-slider v-model="customThemeDraft.styles.glassOpacity" :min="70" :max="100" :step="1" color="secondary" hide-details />
            </div>
            <div>
              <div class="custom-theme-field-label mb-2">卡片阴影</div>
              <v-btn-toggle v-model="customThemeDraft.styles.shadow" mandatory divided density="compact" color="secondary">
                <v-btn value="none">无</v-btn>
                <v-btn value="soft">柔和</v-btn>
                <v-btn value="strong">明显</v-btn>
              </v-btn-toggle>
            </div>
          </div>
          <div class="custom-theme-preview" :style="customThemePreviewStyle">
            <div :style="{ color: customThemeDraft.colors.heading }">主题预览</div>
            <p :style="{ color: customThemeDraft.colors.muted }">标题、正文、边框、强调色和开关会使用这套主题参数。</p>
            <div class="custom-theme-preview-row">
              <span :style="customThemePreviewButtonStyle">强调按钮</span>
              <i :style="{ background: customThemeDraft.colors.success }" />
            </div>
          </div>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" :disabled="customThemeSaving" @click="closeCustomThemeEditor">取消</v-btn>
          <v-btn color="secondary" variant="flat" :loading="customThemeSaving" @click="saveCustomTheme">保存并应用</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
    <v-divider class="my-4" />
    <div class="section-title-row compact-row mb-2">
      <div>
        <div class="section-title small-title">系统级截图</div>
        <div class="section-note">框选截图后可复制到剪贴板、贴到屏幕或发送给已激活人格；在截图窗口按 F2 发送，按 &lt; / &gt; 切换上一张和下一张。</div>
      </div>
      <v-switch v-model="desktopScreenshotEnabled" label="启用截图" color="success" density="compact" inset hide-details :disabled="!loaded" />
    </div>
    <v-text-field
      v-model="desktopScreenshotShortcut"
      label="截图快捷键"
      placeholder="Ctrl+Shift+S"
      :hint="desktopScreenshotShortcutCapturing ? '正在录入，按下要绑定的按键。' : '点击输入框后按下快捷键；可单独使用 F1-F12，或搭配 Ctrl、Alt、Shift、Win。'"
      persistent-hint density="compact" readonly
      :disabled="!loaded || !desktopScreenshotEnabled"
      @click="desktopScreenshotShortcutCapturing = true"
      @focus="desktopScreenshotShortcutCapturing = true"
      @keydown="captureShortcut($event, 'capture')"
      @blur="desktopScreenshotShortcutCapturing = false; normalizeScreenshotShortcut()"
    />
    <div class="section-title-row compact-row mb-2">
      <div>
        <div class="section-title small-title">自动复制选区</div>
        <div class="section-note">确认选区时自动复制到剪贴板；关闭后可按 Ctrl+C 或点击“复制”。</div>
      </div>
      <v-switch v-model="desktopScreenshotAutoCopy" label="自动复制" color="success" density="compact" inset hide-details :disabled="!loaded || !desktopScreenshotEnabled" />
    </div>
    <v-text-field
      v-model="desktopScreenshotClipboardShortcut"
      label="贴图快捷键"
      placeholder="Ctrl+Alt+V"
      :hint="desktopScreenshotClipboardShortcutCapturing ? '正在录入，按下要绑定的按键。' : '截图窗口打开时，直接贴出框选区域；其他时候贴出剪贴板图片。默认 Ctrl+Alt+V；也可以明确设置 F3。可单独使用 F1-F12，或搭配 Ctrl、Alt、Shift、Win。'"
      persistent-hint density="compact" readonly
      :disabled="!loaded || !desktopScreenshotEnabled"
      @click="desktopScreenshotClipboardShortcutCapturing = true"
      @focus="desktopScreenshotClipboardShortcutCapturing = true"
      @keydown="captureShortcut($event, 'clipboard')"
      @blur="desktopScreenshotClipboardShortcutCapturing = false; normalizeScreenshotClipboardShortcut()"
    />
    <v-divider class="my-4" />
    <div class="section-title-row compact-row mb-2">
      <div>
        <div class="section-title small-title">滑词菜单</div>
        <div class="section-note">划选文字后显示“朗读”和“投递至”；划选本身不执行动作。</div>
      </div>
      <v-switch v-model="selectionSpeechEnabled" label="开启滑词菜单" color="success" density="compact" inset hide-details :disabled="!selectionSpeechLoaded" />
    </div>
    <v-alert v-if="selectionSpeechError" type="error" variant="tonal" density="compact" class="mb-3">{{ selectionSpeechError }}</v-alert>
    <template v-if="selectionSpeechEnabled">
      <div class="section-title-row compact-row mb-2">
        <div>
          <div class="section-title small-title">滑词朗读</div>
          <div class="section-note">点击“朗读”才会播放；关闭后悬浮条只保留“投递至”。</div>
        </div>
        <v-switch v-model="selectionReadAloudEnabled" label="滑词朗读" color="success" density="compact" inset hide-details :disabled="!selectionSpeechLoaded" />
      </div>
      <v-switch v-model="selectionSpeechAdvanced" label="高级选项" color="primary" density="compact" hide-details :disabled="!selectionSpeechLoaded || !selectionReadAloudEnabled" />
      <v-select
        v-if="selectionReadAloudEnabled && selectionSpeechAdvanced"
        v-model="selectionSpeechModel"
        class="mt-3"
        label="滑词朗读模型"
        :items="selectionSpeechModels.filter(item => item.capability === 'tts' && item.available)"
        item-title="name"
        item-value="id"
        :disabled="!selectionSpeechLoaded"
      >
        <template #item="{ props, item }"><v-list-item v-bind="props" :subtitle="item.raw.id" /></template>
      </v-select>
    </template>
    <v-divider class="my-4" />
    <div class="section-title-row compact-row">
      <div>
        <div class="section-title small-title">Windows 登录启动</div>
        <div class="section-note">登录 Windows 后自动启动 RabiRoute Desktop；后台运行时保留系统托盘入口。</div>
      </div>
      <v-switch v-model="desktopAutostart" label="登录后启动" color="success" density="compact" inset hide-details :disabled="!loaded" />
    </div>
  </v-card>
</template>

<style scoped>
.theme-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}

.theme-options {
  flex-wrap: wrap;
  height: auto !important;
}

.theme-options :deep(.v-btn),
.theme-action-button {
  min-height: 44px;
}

.custom-theme-dialog {
  border: 1px solid var(--rr-border-soft);
  background: var(--rr-surface) !important;
}

.custom-theme-heading-grid,
.custom-theme-style-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.custom-theme-color-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px 14px;
}

.custom-theme-color-groups {
  border: 1px solid var(--rr-border-soft);
  border-radius: var(--rr-card-radius, 8px);
  overflow: hidden;
}

.custom-theme-color-groups :deep(.v-expansion-panel) {
  background: var(--rr-subtle);
  color: var(--rr-text);
}

.custom-theme-color-field > span,
.custom-theme-field-label {
  display: block;
  margin-bottom: 5px;
  color: var(--rr-muted);
  font-size: 12px;
  font-weight: 800;
}

.custom-theme-color-field > div {
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr);
  gap: 8px;
  align-items: center;
}

.custom-theme-color-field input[type="color"] {
  width: 44px;
  height: 44px;
  border: 1px solid var(--rr-border);
  border-radius: 8px;
  padding: 3px;
  background: var(--rr-input);
  cursor: pointer;
}

.custom-theme-preview {
  margin-top: 20px;
  border: 1px solid;
  padding: 18px;
}

.custom-theme-preview > div:first-child {
  font-size: 16px;
  font-weight: 900;
}

.custom-theme-preview p {
  margin: 5px 0 14px;
  font-size: 13px;
}

.custom-theme-preview-row {
  display: flex;
  align-items: center;
  gap: 14px;
}

.custom-theme-preview-row span {
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 12px;
  font-weight: 900;
}

.custom-theme-preview-row i {
  display: block;
  width: 48px;
  height: 26px;
  border-radius: 999px;
}

@media (max-width: 760px) {
  .custom-theme-heading-grid,
  .custom-theme-style-grid,
  .custom-theme-color-grid {
    grid-template-columns: 1fr;
  }
}
</style>
