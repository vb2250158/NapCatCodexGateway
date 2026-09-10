<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { DesktopPetAnimation } from "../desktopPetClient";

const props = defineProps<{ animation: DesktopPetAnimation; name: string }>();
const playing = ref(false);
const frame = ref(0);
const revision = ref(0);
const error = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;
const source = computed(() => props.animation.assets[frame.value]);
function stop() {
  clearTimeout(timer);
  playing.value = false;
  frame.value = 0;
}
function play() {
  stop();
  error.value = false;
  revision.value += 1;
  playing.value = true;
}
function loaded() {
  clearTimeout(timer);
  if (!playing.value || props.animation.type !== "png-sequence" || props.animation.assets.length < 2) return;
  timer = setTimeout(() => {
    if (frame.value + 1 < props.animation.assets.length) frame.value += 1;
    else if (props.animation.loop) frame.value = 0;
    else playing.value = false;
  }, 1000 / props.animation.fps);
}
function failed() { stop(); error.value = true; }
watch(() => props.animation, () => { stop(); error.value = false; });
onBeforeUnmount(stop);
</script>

<template>
  <div class="pet-preview">
    <div class="pet-preview-stage" aria-live="polite">
      <span v-if="error">素材加载失败，请重试。</span>
      <img v-else-if="playing || animation.type === 'png-sequence'" :key="revision" :src="source" :alt="name" @load="loaded" @error="failed" />
      <span v-else>点击播放预览</span>
    </div>
    <div class="pet-preview-buttons">
      <v-btn size="small" variant="tonal" @click="play">{{ playing ? "重新播放" : "播放预览" }}</v-btn>
      <v-btn size="small" variant="text" :disabled="!playing" @click="stop">停止</v-btn>
    </div>
    <small v-if="animation.type === 'gif'">GIF 按文件自身的帧率和循环设置预览。</small>
  </div>
</template>

<style scoped>
.pet-preview-stage { min-height: 200px; display: grid; place-items: center; background: var(--rr-subtle); border-radius: 8px; padding: 12px; }
.pet-preview-stage img { max-width: 100%; height: 200px; object-fit: contain; }
.pet-preview-buttons { display: flex; gap: 8px; margin: 10px 0; }
</style>
