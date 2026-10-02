# 可选的 Willington 集成

[English](../en/WILLINGTON_INTEGRATION.md) · 简体中文 · [日本語](../ja/WILLINGTON_INTEGRATION.md)

Willington 是一组需要单独安装的原生提供程序（provider），能触及 Live 的 Python API 触及不到的部分：Session 片段的跟随动作（Follow Actions）、机架宏的映射与名称，以及机架链的区域。每个提供程序都是为 macOS ARM64 上某一个确切的 Live 构建版本打造的，属于实验性质。普通的 Kumi 和桥接完全不需要它：没有它，这些工具就不会出现。

## 它增加了什么

| Kumi 工具 | 桥接工具 | 编辑类型 | 提供程序 |
| --- | --- | --- | --- |
| `set_clip_follow_actions` | `live_follow_actions_preview/apply` | Session 片段的全部十个跟随动作字段 | WillingtonBindings |
| `edit_rack_mapping` | `live_willington_device_preview/apply` | `macro-name`、`variation-name`、`macro-mapping` | WillingtonDeviceTools |
| `edit_rack_mapping` | `live_willington_device_preview/apply` | `selector-zone`、`key-zone`、`velocity-zone` | WillingtonRackZones |

桥接只提供那些提供程序已安装且启用了写入的编辑类型：`live_willington_device_preview` 只列出这些 `kind` 值。每次编辑都需要走带处于停止状态。

有些机架方面的改进不需要 Willington：按 Live 自身的宏布局读取机架、按索引调用或删除变体，以及当 Live 的 Browser 没有 Modulators 类别时回退到自带的调制器设备。它们适用于任何桥接。

## 安装与启用

1. 把你需要的提供程序安装到 Live 的 Remote Scripts 文件夹中，与 AbletonMcpBridge 并列：`WillingtonBindings`（跟随动作）、`WillingtonDeviceTools`（宏和变体；它必须提供 `get_macro_mapping` 和 `get_selected_variation_name`）以及 `WillingtonRackZones`（区域）。每个提供程序都会检查自己是否运行在为其打造的那个确切的 Live 构建版本中，在其他版本上会拒绝安装。
2. 在 Live 中关闭任何独立的 Willington 控制界面，然后重启 Live。桥接不会与其他所有者共享这些提供程序。
3. 在 `Remote Scripts/AbletonMcpBridge` 中、桥接的 `__init__.py` 旁边创建 `willington.json`。它必须是普通文件、仅所有者可访问、最多 4 KiB，并且恰好包含以下这些键：

   ```json
   {"version": 1, "followActions": true, "deviceTools": true, "rackZones": true, "enableWrites": false}
   ```

   | 键 | 含义 |
   | --- | --- |
   | `version` | 始终为 `1` |
   | `followActions` | 加载 WillingtonBindings |
   | `deviceTools` | 加载 WillingtonDeviceTools |
   | `rackZones` | 可选；加载 WillingtonRackZones |
   | `enableWrites` | 允许编辑；为 `false` 时加载提供程序，但不提供编辑 |

4. 要进行跟随动作编辑，WillingtonBindings 还需要一次通过的自检：它的文件夹中要有 `self-test.json`，其中 `"status": "passed"`，并且 `library_sha256` 等于它的 `libwillington.dylib` 的 SHA-256。没有它，跟随动作编辑保持关闭，其他提供程序仍然可用。
5. 重启 Live。配置更改只在 Live 启动时生效。

Kumi 更新会保留 `willington.json`。删除它即可回到普通的桥接。

当这个文件缺少某个键或含有未知的键、它指定的任何提供程序加载失败、其他所有者已经持有这些提供程序，或者已经安装了独立的跟随动作、设备或区域控制界面时，任何提供程序都不会被使用，桥接会在没有它们的情况下继续运行。Live 的日志（Log.txt）会说明是哪种情况："Willington extensions initialized; writes enabled"、"Willington extensions unavailable: …; ordinary bridge remains active" 或 "Willington Follow Action writes unavailable: …"。

Remote Script 停止时，会关闭跟随动作写入，并卸载 DeviceTools 和 RackZones。跟随动作的绑定无法卸载：它们在该 Live 进程中保持注册状态，桥接再次启动时会在写入关闭的状态下重新使用它们。

## 跟随动作

`live_follow_actions_preview/apply` 设置一个 Session 片段的全部十个字段：启用、链接、动作 A 和 B、概率 A 和 B、循环次数、时间，以及跳转目标 A 和 B。

- 动作用数字表示：0 无、1 停止、2 再次、3 上一个、4 下一个、5 第一个、6 最后一个、7 任意、8 其他、9 跳转。跳转目标是从 1 开始的场景编号。
- 两个概率之和为 100；给出其中一个，另一个就设为剩余部分。
- 链接时，计时使用循环次数；未链接时，计时使用以拍为单位的 `time`。
- 走带必须处于停止状态，片段也不能在录音。
- 它不会更改场景的跟随动作或 Live 的全局跟随动作开关。要设置启动 Legato，请使用片段设置工具（Kumi 中的 `set_clip`）。

预览会捕获全部十个字段。如果写入中途失败，之前已写入的字段会恢复原值。撤销会恢复捕获的字段，如果片段此后发生了变化，撤销会被拒绝。

## 宏、变体与映射

用 `ref` 指向一个机架，调用 `live_willington_device_preview/apply`：

| 类型 | 参数 | 说明 |
| --- | --- | --- |
| `macro-name` | `macroIndex`（0–15）、`name` | 重命名一个宏 |
| `variation-name` | `name` | 重命名所选变体；必须选中一个已命名的变体 |
| `macro-mapping` | `targetRef`、`mappingIndex`（0–15，或用 `null` 取消映射）、`minimum`、`maximum`、`mappingKind` | 把该机架内的一个参数映射到一个宏 |

映射类型：

- `continuous` 和 `enum`：`minimum` 和 `maximum` 使用参数自身的单位，并处于其范围内；范围可以反转。`enum` 的端点是整数。
- `boolean`：宏阈值为 0 到 127 的整数，`minimum` ≤ `maximum`。

`targetRef` 必须来自最新一次发现，并且位于该机架、它的嵌套设备或它各条链的调音台中。事务会捕获名称，或者捕获映射、参数的值和各宏的值，连同所涉及的身份。Live 会在一个 tick 之后才设置被映射参数的值，所以映射以映射本身和宏的值为栅栏，而不以该参数的值为栅栏。每次写入都会被回读，如果不一致，就精确恢复原样。撤销会恢复捕获的状态，如果机架此后发生了变化，撤销会被拒绝。这是事务自己的撤销，而不是 Live 的撤销。

## 机架链区域

用 `ref` 指向一个机架、`targetRef` 指向它的一条常规链，调用 `live_willington_device_preview/apply`：

| 机架 | 区域 |
| --- | --- |
| Audio Effect Rack | `selector-zone` |
| Instrument Rack、MIDI Effect Rack | `selector-zone`、`key-zone`、`velocity-zone` |

Drum Rack 和返回链会被拒绝。一个区域有四个整数端点：`minimum`、`fadeMinimum`、`fadeMaximum` 和 `maximum`，它们必须保持顺序（`minimum` ≤ `fadeMinimum` ≤ `fadeMaximum` ≤ `maximum`），并处于 0–127 范围内（力度为 1–127）。省略的端点保持当前值，所以移动一个范围时，可能需要同时给出两个淡变端点。

预览会捕获全部四个端点。应用和撤销按身份以机架和链、以及整个区域状态为栅栏；写入后回读与要求不符时，会精确恢复原样。

## 证据

| 提供程序 | 运行 | Live | 桥接 | 覆盖范围 |
| --- | --- | --- | --- | --- |
| 跟随动作 | [kumi-clip-follow-actions-b5.json](../evidence/kumi-clip-follow-actions-b5.json)，2026-09-30 | 12.4.15b5，macOS arm64 | 1.0.53 | 在已保存的测试工程上进行的 Kumi 修改和撤销，走带已停止 |
| 跟随动作、宏、映射 | [willington-kumi-chat.json](../evidence/willington-kumi-chat.json)，2026-09-30 | 12.4.15b4 ARM64 | 1.0.52 | 一次真实的 Kumi 对话：跟随动作、宏重命名、映射，每项都已撤销 |
| 机架区域 | [rack-zones-b5.json](../evidence/rack-zones-b5.json)，2026-10-01 | 12.4.15b5（2026-09-24 构建），arm64 | 1.0.66 | 回读、写入、撤销和重做，工程保存后重新打开，已安装的桥接以及 Kumi 的撤销 |

变体重命名以及反转的 continuous 和 enum 映射，是直接通过桥接测试的。这些运行都没有覆盖播放：跟随动作的调度、区域听起来如何，以及播放时的选择器变化。跟随动作和宏编辑没有在保存并重新打开工程的情况下测试过。机架区域在 12.4.15b4 或任何其他构建版本上都不受支持。

桥接的自动化测试在没有 Live 的情况下覆盖其余部分：缺失的提供程序、格式错误的配置、过时和冲突的编辑、部分写入、所有权与重连，以及丢失的回复。

## 有意不提供的功能

Willington 有用于以下操作的原生方法，但在能够安全撤销之前，Kumi 不会提供它们：

- **覆盖一个变体**：需要读取并恢复完整的已存储宏值和启用掩码，而不仅仅是变体的名称。
- **直接替换 Drum Sampler 的采样**：需要当前采样的身份和路径，并恢复替换所改变的内容。通过 Browser 加载预设和采样是可以的。
- **映射调制器**：原生修改要稍后才会稳定下来，与 Live 的线程不同步。它首先需要稳定状态检查、对源和目标的确切所有权、取消以及恢复。

存在原生方法，并不足以构成一个可撤销的操作：不要只添加一个运行时描述符或一个协议条目就提供它。
