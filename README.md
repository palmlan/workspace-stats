# @local/dsh-workspace-stats

在 Harness Web UI 的输入框下方显示**当前会话工作区**的文件总数与总大小。以小数点开头的隐藏目录（`.git`、`.cache`、`.github`…）和隐藏文件与普通条目一视同仁，全部计入。

## 文件构成

| 文件 | 作用 |
|---|---|
| `package.json` | 包清单：`exports`、图标与显示名，以及 `dsh.bundle`（Host 补丁）和 `dsh.client`（浏览器半边）两段声明 |
| `cordis.patch.yml` | 装载器补丁：向当前 profile 插入一行，指向本包 |
| `index.js` | Host 半边。不注册任何东西，但必须导出 `apply`，否则这一行无法装载 |
| `client.js` | 浏览器半边：注册 `conversation.composer.dock` 槽位条目并渲染统计 |
| `locale/{en,zh}.json` | 插件管理页卡片和设置页清单里显示的标题与描述 |
| `icon.svg` | 清单 `icon` 指向的图标 |
| `test.mjs` | 离线检查：模块契约、槽位注册、真实目录树的计数与格式化 |

## 安装

三种方式任选其一。安装后对该 profile 下的所有会话生效并保留到重启之后；本 profile 的 `patchReload` 为 `live` 且 `dsh-hmr` 随 profile 启用，所以通常无需重启。

**A. 侧边栏「插件」页（推荐，不需要任何 Agent 工具，也不需要切换权限模式）**

打开侧边栏的「插件」面板 → 点标题栏的「添加插件」→ 在「包名或地址」里粘贴本目录的绝对路径：

```
D:\lab\deepseekharness\plugins\workspace-stats
```

装好后它会出现在该页的「已安装」列表里。

> 别和另一个页面搞混：侧边栏的「插件」页可以**安装 / 启用 / 停用 / 移除**；「设置 → 内置插件」里的「插件列表」标签是**只读**的，只用于查看内置插件及其运行状态，装不了东西。

**B. 命令行**（需要 `pnpm` 在 PATH 上，本机目前还没有）：

```powershell
dsh plugin --profile web add "D:\lab\deepseekharness\plugins\workspace-stats"
```

**C. 让 Agent 装**：新建任务时选「创造模式」——`plugin_manager` 工具只在创造模式启用，且每次调用都需要你授权。

若要停用而不删除，编辑 `C:\Users\lanyufeng\.dsh\profiles\web\cordis.patch.yml`：

```yaml
- id: workspace-stats
  disabled: true
```

## 自检

```powershell
node plugins\workspace-stats\test.mjs
```

它用真实临时目录树验证：9 个文件（含 `.env`、`.github/...`、`.cache/tmp/*`）被完整统计，字节总数与 `fs.readdir` 的地面真值一致，且根目录不可列举时降级显示而不是崩溃。这个检查不能替代在页面上看一眼那颗胶囊。

## 它是怎么统计的

不写任何 Host RPC：浏览器半边直接调用已装载的 `@deepseek-ai/dsh-api-workspace-files` 暴露的 Remote。

```js
// 列出一个目录的直接子项；'.' 代表工作区根
const listed = await ctx.remote.workspaceFiles.list(sessionId, path);
// listed.value.entries[i] = { name, type: 'file' | 'directory' | 'other', size? }
```

`list` 的返回里，普通文件带 `size` 字节数，所以一次目录列举就同时给出「个数」和「大小」；只有目录才需要再下去一层。`sessionId` 由槽位属性直接提供，因此不需要自己去查工作区根路径——`list` 本来就是相对会话工作区解析的。

`size` 缺失（后端不报告、或条目是符号链接/其他类型）时，该文件只计入个数，并把总数标记为不精确（胶囊右上角出现 `*`，悬停可见说明），不会把估算值当成精确值显示。

## 两处取舍

- **不做自动刷新。** 统计一次要遍历整棵树；监听会话事件自动重跑会在长会话里反复扫描。需要新数字时点胶囊右侧的刷新按钮，或重新打开该会话。要用更聪明的方式（在 `turn/end` 之后重算、把结果放进 Host 投影），见 DSH 插件开发技能里的 `references/practices.md`。
- **没有忽略列表。** 包括 `node_modules` 在内的一切都计入，这才符合"文件总数和总大小"的字面要求。若要排除某些目录，在 `measureWorkspace` 的循环里按名字跳过即可，但请把被排除的事实显示出来，否则数字会骗人。
