# chatgpt-scripts

适用于 ChatGPT 网页端的独立用户脚本集合。每个脚本均位于 `scripts/` 目录下，独立运行，无需 Node.js、构建打包或安装任何依赖。

当前版本：`v2026.09.07-1`

## 脚本列表

| 脚本名称 | 脚本文件 | 安装地址 | 功能简述 |
| :--- | :--- | :--- | :--- |
| **ChatGPT 模型检测** | `scripts/chatgpt-route-checker.user.js` | [安装链接](https://raw.githubusercontent.com/zjm54321/chatgpt-scripts/main/scripts/chatgpt-route-checker.user.js) | 被动比对请求模型与响应元数据，查看当前路由状态 |
| **Team 助手** | `scripts/team-assistant.user.js` | [安装链接](https://raw.githubusercontent.com/zjm54321/chatgpt-scripts/main/scripts/team-assistant.user.js) | 仅在前端视觉上隐藏特定成员上限提示与自动充值引导 |

## 安装与使用

1. 在浏览器中安装用户脚本管理器（如 [Tampermonkey](https://www.tampermonkey.net/) 或 [Violentmonkey](https://violentmonkey.github.io/)）。
2. 点击上表中对应脚本的「安装链接」（Raw 链接）。
3. 脚本管理器会自动打开确认页面，点击「安装」或「确认」。
4. 刷新 ChatGPT 网页（`https://chatgpt.com`）即可生效。

## 脚本说明与限制

### ChatGPT 模型检测 (`chatgpt-route-checker.user.js`)
- **交互形式**：在 ChatGPT 对话页面右上角原生控制区旁添加纯图标状态按钮，点击展开轻量浮窗，显示 `server_ste_metadata.model_slug`、`request.model` 及 `request.thinking_effort`。
- **状态指示**：自动跟随页面明暗主题。等待/处理中显示时钟或圆点；模型标识一致或属于同一系列显示对勾；存在差异显示警告；缺少元数据或无法比较时显示中性状态。
- **界面适配**：在缺少原生对话顶栏的页面（如工作区或设置页）自动隐藏，回到对话页自动恢复，并避开 Inkstone 扩展按钮位置。
- **网络与隐私**：仅被动监听页面自身的网络请求，不主动向 ChatGPT 发送任何额外请求，不导出对话历史，不读取 Cookie。
- **比对局限**：仅比对接口中暴露的标识符字段，不代表模型实际推理质量或底层算力硬件路由。如遇端点未覆盖、元数据未返回或官方模型别名调整，可能保持未知状态。
- **注意事项**：若此前安装过旧版或其他模型检测脚本，请在安装后停用旧脚本并刷新页面，避免重复拦截或界面冲突；停用本脚本并刷新即可恢复原生状态。

### Team 助手 (`team-assistant.user.js`)
- **隐藏范围**：仅针对性隐藏标题为「工作区有成员达到使用上限」、正文为「开启自动充值，系统会自动补充额度，避免今后再次中断。」的提示条及同区域内的自动充值按钮。已按首页提示条结构处理；设置页使用相同文案匹配，尚未确认其页面结构。
- **动态页面**：页面切换或提示内容变化后会重新匹配；若提示框混有其他设置项或控件，则保守跳过。
- **注意事项**：本脚本仅提供纯前端样式隐藏，仅匹配这组文案，不按通用提示框样式批量隐藏，不修改工作区额度、计费或实际使用限制，不会自动触发充值。关闭脚本并刷新页面即可恢复。

## 版本与扩展

- **版本规范**：遵循 `vYYYY.MM.DD-N` 命名规则（如 `v2026.09.07-1`），同日发布多次更新时依次递增末尾序号（`-2`、`-3`）。
- **新增脚本**：欢迎扩充新的用户脚本。所有脚本均需置于 `scripts/` 目录下，每个脚本保持单文件、可单独安装，不引入外部构建流程与第三方包依赖。

## 来源与致谢

- **功能与检测思路参考**：[ChatGPT 降智检测](https://github.com/EpochTX/OpenAIsm)（原脚本作者 [epochtx](https://github.com/EpochTX)，参考源码 [Checker.user.js](https://github.com/EpochTX/OpenAIsm/blob/main/Checker.user.js)）。本仓库的模型检测脚本为独立编写，未分发或修改上游源代码。
- **界面与交互灵感**：[Inkstone](https://github.com/ZhenHuangLab/inkstone)（ZhenHuangLab），参考了其顶栏按钮和弹窗交互。本仓库未包含其导出器代码或捆绑产物。
- **维护者**：本集合由 [zjm54321](https://github.com/zjm54321) 维护。
