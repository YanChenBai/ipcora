<script setup lang="ts">
import { ipcInvoke } from '@renderer/utils/ipc';
import { reactive } from 'vue';

const versions = reactive({
  electron: '',
  chrome: '',
  node: '',
});

ipcInvoke.test.getVersions().then((res) => {
  if (res.error) return;

  versions.electron = res.data.electron;
  versions.chrome = res.data.chrome;
  versions.node = res.data.node;
});
</script>

<template>
  <ul class="versions">
    <li class="electron-version">Electron v{{ versions.electron }}</li>
    <li class="chrome-version">Chromium v{{ versions.chrome }}</li>
    <li class="node-version">Node v{{ versions.node }}</li>
  </ul>
</template>
