# Agent Note: 确认弹窗保留桌面窗口操作

Status: implemented

## Problem

Base UI 的 AlertDialog 会将弹窗外的 DOM 隐藏并禁止交互。原型要求确认弹窗打开时，右上角最小化、最大化和关闭仍然可用。单靠原型的 z-index 不能解除模态范围。

## Decision

[UI provider](../../../../src/renderer/state.tsx) 使用全窗口的 Popup 容器，将原型的 `.dialog` 作为内部视觉面板，窗口按钮通过 React portal 放入同一个模态范围。面板保留原 CSS 和状态属性，窗口按钮保留位置、尺寸和主进程操作。关闭阶段使用 Base UI 的 `preventUnmountOnClose` / `actionsRef.unmount` 等待现有 CSS 动画结束；不增加动画库。

## Alternatives considered

提高窗口按钮层级：不能解决 AlertDialog 的 aria-hidden 和模态交互屏蔽。

改用非模态 Dialog：会削弱确认弹窗的焦点限制；trap-focus 仍会隐藏范围外的按钮。

将按钮放在原 `.dialog` 面板中：面板的缩放和位移会改变按钮位置，破坏窗口行为和视觉基准。

## Consequences

确认操作仍默认聚焦取消、支持 Escape 和焦点恢复。窗口按钮成为模态范围内的可访问控件；内部面板的动画需显式等待。复现与回归见 [测试](../../../../e2e/fixture.spec.ts) 和 [修复前证据](../../../../docs/evidence/dialog-window-before.txt)。
