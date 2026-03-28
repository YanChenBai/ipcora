# 📦 TypeIpc

一个端到端类型安全的 Electron IPC 通讯的工具

## ✨ 特性

- 🚀 端到端类型安全
- ⚡ 简单易用
- 📦 支持 Schema 验证 (内置 TypeBox，支持 Standard Schema)
- 🔧 灵活的 API 设计

## 📦 安装

```bash
# 使用 npm
npm install type-ipc

# 使用 pnpm
pnpm add type-ipc

# 使用 yarn
yarn add type-ipc

# 使用 bun
bun add type-ipc
```

## 🔨 使用示例

TypeIpc 提供了两种主要的通信模式：

1. **Handler / Invoke 模式** - 从渲染进程调用主进程函数并获取返回值
2. **Emitter / Message 模式** - 从主进程向渲染进程发送消息

### 主进程 (Main Process)

```typescript
// main.ts
import type { Infer } from 'type-ipc/main';
import { app, BrowserWindow } from 'electron';
import { defineEmitter, defineHandler, registerEmitters, registerHandlers } from 'type-ipc/main';
import { t } from 'type-ipc/typebox';

export const demoHandler = defineHandler(
  'demo',
  {
    add: (_event, data) => {
      return data.a + data.b;
    },
  },
  {
    add: {
      data: t.Object({
        a: t.Number(),
        b: t.Number(),
      }),
      return: t.Number(),
    },
  },
);

export const createDemoEmitter = defineEmitter('demo', {} as { Update: string });

export const handlers = registerHandlers(demoHandler);
export const emitters = registerEmitters(createDemoEmitter);

// 初始化 ipc
handlers.appWhenReadyStart();

// 向渲染进程发送消息
app.whenReady().then(() => {
  const win = new BrowserWindow();
  const emit = createDemoEmitter(win.webContents);

  emit.Update('hello world');
});

export type Invoke = Infer<typeof handlers>;
export type Message = Infer<typeof emitters>;
```

### 预加载进程 (Preload Process)

```typescript
// preload.ts
import { exposeTypeIpc } from 'type-ipc/preload';

// 将 IPC 方法暴露给渲染进程
exposeTypeIpc();
```

### 渲染进程 (Renderer Process)

```typescript
// ipc.ts
import type { Invoke, Message } from '../main/main';
import { createIpcInvoke, createIpcMessage } from 'type-ipc/renderer';

// 创建 IPC 调用和消息监听实例
const ipcInvoke = createIpcInvoke<Invoke>();
const ipcMessage = createIpcMessage<Message>();

// 调用主进程
const res = await ipcInvoke.test.greet({ a: 1, b: 2 });
console.log(res); // { error: null, data: 3 }

// 监听主进程发送的消息
ipcMessage.test.onUpdateData((data) => {
  console.log('Received data:', data);
});
```

## 📚 API 介绍

### defineHandler(name, methods, schema?, options?)

定义一个处理器，用于处理从渲染进程发来的请求。

参数：

- `name`: 处理器名称
- `methods`: 方法对象，键为方法名，值为处理函数
- `schema`: （可选）TypeBox schema 对象，用于参数验证
- `options`: （可选）配置选项
  - `validate`: 是否启用参数验证（默认 false）

返回值：一个具有以下属性的函数：

- 函数本身：用于处理 IPC 调用的函数
- `~name`: 处理器名称（内部使用）
- `static`: 类型定义，用于渲染进程的类型推断

### defineEmitter(name, schema, options?)

定义一个发送器工厂函数，用于向渲染进程发送消息。

参数：

- `name`: 发送器名称
- `schema`: TypeBox schema 对象或 TypeScript 类型，定义可发送的消息类型
- `options`: （可选）配置选项
  - `validate`: 是否启用数据验证（默认 false）

返回值：一个具有以下属性的函数：

- 函数本身：接收一个 BrowserWindow 对象，返回一个发送器实例，该实例包含 schema 中定义的所有方法
- `~name`: 发送器名称
- `static`: 类型定义，用于渲染进程的类型推断，会自动生成 `on` 和 `once` 前缀的监听方法

示例：

```typescript
const createTestEmitter = defineEmitter('test', {
  updateUser: Type.String(),
  updateConfig: Type.Object({
    theme: Type.String(),
    language: Type.String(),
  }),
});

// 使用时
const emitter = createTestEmitter(someBrowserWindow);
emitter.updateUser('John'); // 发送消息
emitter.updateConfig({ theme: 'dark', language: 'en' });
```

### registerHandlers(...handlers)

注册一个或多个处理器。

参数：

- `handlers`: 要注册的处理器（由 defineHandler 创建）

返回值：一个对象，包含以下属性和方法：

- `start()`: 启动 IPC 监听，开始处理来自渲染进程的请求
- `appWhenReadyStart()`: 在 Electron 应用准备就绪后启动 IPC 监听
- `add(handler)`: 动态添加处理器
- `del(handler)`: 动态删除处理器
- `static`: 类型定义，用于渲染进程的类型推断，是所有处理器 static 类型的交集

### registerEmitters(...emitters)

注册一个或多个发送器。

参数：

- `emitters`: 要注册的发送器（由 defineEmitter 创建）

返回值：一个对象，包含以下属性：

- `static`: 类型定义，用于渲染进程的类型推断，是所有发送器 static 类型的交集

### createIpcInvoke<Invoke>()

创建 IPC 调用实例，用于在渲染进程中调用主进程函数。

### createIpcMessage<Message>()

创建 IPC 消息监听实例，用于在渲染进程中监听主进程发送的消息。

### exposeTypeIpc()

在预加载脚本中调用，将 IPC 方法暴露给渲染进程。

## 🧪 测试

```bash
pnpm run test
```

## 📖 开发

```bash
# 开发模式
pnpm run dev

# 构建项目
pnpm run build
```
