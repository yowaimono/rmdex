# 产物主动登记

实现日期：2026-11-04。显式登记机制首次提交为 `4642106`。

## Skill 主动交付

员工的 `rmdex-employee` Skill 要求 AI 在生成用户需要接收的文件后、最终回复前执行登记。普通源码修改仍由 diff 表达，不自动把输入、内部笔记或工作文件当成交付。

```text
node "<员工资产目录>/artifacts.mjs" attach --file "绝对文件路径" --id UUID [--name "展示文件名.pdf"]
node "<员工资产目录>/artifacts.mjs" list
node "<员工资产目录>/artifacts.mjs" detach --id UUID
```

`attach` 成功返回 `status: "attached"` 和文件元数据。登记后，页面下次状态轮询即可展示文件，无需最终回复包含路径或特殊标记；未完成、失败或中断回合也保留已登记卡片。回合成功且有最终回复时，卡片合并到最终文字或语音气泡下，只显示一次。撤下后下一次轮询清除卡片。

同一个逻辑交付使用同一 UUID 重试；路径、文件名、内容及文件时间保持一致时返回 `reused: true`，并维持原 turn 归属。最终版本修改后用新 UUID 登记，需要时先撤下旧版本。同 UUID 不能复用已撤下的登记。多文件逐一登记，`list` 仅列本员工当前会话的有效登记，不列历史文本推断。

## 分发和持久化

Relay 准备员工资产时附带当前 `threadId`，设备端 installer 安装受管 `artifacts.mjs` 和不含令牌的 `artifact-context.json`。后者包含用户、员工、当前会话和 loopback agent 地址；重置会话后的下一次资产准备更新绑定。已有上下文版本升至 3，使员工下一次启动任务时接收新版 Skill 指引。设备端也需要包含本次实现，单独更新线上 Web/Relay 或只改已安装 Skill 不够。

首次登记只通过本机 `/api/threads/<threadId>/status` 确定 active/latest turn，保存到 `<CODEX_HOME>/rmdex/artifacts/<threadId>/<UUID>.json`。不会发模型请求、不会上传或复制源文件，也不新增网络写入接口。记录包含 owner、thread/turn、规范路径、大小、mtime 和 SHA256。清单用 UUID 锁和临时文件重命名写入；同 UUID 并发执行会明确报错。异常终止若残留锁，须在设备上确认脚本已经退出、核对清单后清理对应锁，再沿用原 ID 重试，不能盲目换 ID。

设备 agent 在历史、增量、状态和下载读取时恢复清单，再合并旧文本推断。持久化 ID 重启后不变，原下载 URL 可直接继续用；撤下用 tombstone 保留记录，避免该 turn 的同路径旧链接再次生成卡片。`detach` 保留源文件，不代表删除文件。

文件最多 512 MB，可以在项目 cwd 外，源文件必须继续保存在设备稳定位置。下载校验普通文件、大小、mtime 和规范路径；文件被编辑、删除、移动或替换后会不可用。SHA256 是登记时摘要，下载不逐次重新计算，不是不可变快照。前端仅收到不透明 ID 等元数据，不包含绝对路径、owner 或 mtime；沿用既有 Relay 鉴权、下载确认、流传输和预览类型限制。设备离线仍无法取回文件。

本次覆盖常规 shared/app-server 路径。显式启用的旧 Desktop MCP 模式没有 helper 首次登记所需的 status API，不在本次支持范围。

## 历史文本兼容

原有最终回复 Markdown 文件链接、工作目录内的可定位路径和 imageGeneration 输出仍可登记。imageView 只是查看文件，不代表交付；仅有“图片附在上方”等描述仍不能推断交付，AI 应使用显式登记。

明确链接的本地交付文件可以在 cwd 外，也可以没有 cwd。普通路径仍须在有效 cwd 内；两种路径均检查文件实际存在、普通文件、大小限制和源代码排除规则。普通路径还检查 realpath 边界，避免符号链接逃逸。修改过的代码和配置继续由 diff 表达；明确链接交付的 Markdown 文档可以登记，即使它通过 fileChange 创建。

历史消息在重新读取对应历史页时重新解析，不要求重新生成文件。文件删除、移动或设备离线仍会影响访问。

## 路径兼容修复记录

| 触发条件 | 原问题 | 本地修复 |
| --- | --- | --- |
| `报告位于 D:\\...\\report.docx，可以下载。` | 普通路径吞入后续说明，stat 失败 | 按支持的扩展名和标点边界提取 |
| `[文档](</D:/WorkSpace/output/report.md:12>)` | Windows 盘符前的 `/` 和编辑器行号被当作真实路径 | 归一化 Windows 路径，移除位置后缀 |
| 链接包含空格、括号、中文或 file URL | 正则解析和 URL 编码不完整 | 使用现有 Markdown 解析器，解码本地链接 |
| 文档由 fileChange 创建，最终回复给了明确链接 | 所有 changedPaths 都被排除 | 允许明确交付的文档，继续排除代码与已改配置 |
| 明确链接的 MP4 | 路径错误漏报，媒体类型也未映射 | 支持该路径及音视频 MIME，当前仅下载 |

只读回放已有运营历史消息：安装版返回 0 个产物；修复后的解析器恢复 `rmdex-intro-demo.mp4`、`account-playbook.md`、`week-1-content.md`，timeline 将它们挂在原最终回复下。没有修改原会话或替用户重发任务。

主动登记后的完整验证：`npm.cmd run test:all` 通过，单元组共 87 项、85 项通过，两个文件符号链接用例因 Windows 无创建权限跳过；Relay 检查、3 项 Relay 集成、2 项 shared 集成和 MCP 集成通过。覆盖真实 CLI 分发、无 cwd/无路径最终回复、失败回合卡片、UUID 重试、内容变更拒绝、撤下及文本去重、跨员工/会话隔离、重启后原下载 URL、实际字节下载和语音卡片组合。Web、PC、Relay 构建和 Skill validator 均通过，构建仍提示既有的大 chunk 警告。尚未进行真实安装版 UI 或 Android 真机验收。

## 历史调研：Codex Attached artifact

公开来源：OpenAI App Server 文档的 “Manage thread attachments” 小节，地址 `https://learn.chatgpt.com/docs/app-server`。

文档明确提供 `thread/attachment/add`、`list`、`remove`、`attachmentOwner/list` 和 `thread/attachment/updated`。附件是独立保存的资源关联，不依赖恢复 thread；同 thread 的相同 attachmentType 与 identityKey 重复添加会返回已有记录。文档示例用途包含 pull request，不能将任意 attachment 都视为可下载文件。

本机证据：

- Codex 桌面包 `26.1027.6604.0` 的 activity labels 包含 `attach_artifact`、`list_artifacts`、`remove_artifact`；`attach_artifact` 成功文案为 “Attached artifact”。这证明该工具标识存在，不证明当前会话已获该工具或其 payload 格式。
- 本机运行中的 daemon `0.166.0` 通过 `app-server generate-ts --experimental` 生成的协议包含 `ThreadAttachment`：`id`、`attachmentType`、`identityKey`、`payload`、`createdAt`；未发现独立 artifact 类型。
- 使用 initialize 和只读 `thread/attachment/list` 查询本员工 thread 及本次问题相关的运营 thread，均返回空列表。没有 add、remove、resume 或生成测试消息。
- rmdex 没有读取或写入这套原生附件接口。本次实现使用自己的显式清单，独立于原生附件机制。

公开文档尚未查到 `attach_artifact` 的完整入参、持久化 payload 和与上述 generic attachment API 的对应关系，不能宣称已接通原生 Attached artifact。

若未来接入原生附件，仍须取得真实成功附件样本，核对附件类型、文件定位与 turn 关联，不能盲扫任意 payload 内的路径。当前显式登记无需依赖该内部格式。
