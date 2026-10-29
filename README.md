# 定时下滑

按固定间隔自动向下滚动当前网页的浏览器扩展，适合读长文、文档和信息流。支持 Edge 和 Chrome（Manifest V3）。

## 功能

- 自定义滚动间隔，范围 0.5 秒到 60 分钟，可用秒或分钟输入
- 每次滚动可选半屏、一屏，或指定像素距离
- 平滑滚动，以及滚到底部后停止或回到顶部继续
- 手动滚轮、触摸或翻页键会暂停约 2.5 秒
- 页面右下角显示倒计时圆球，可拖动，悬停可停止
- 快捷键 `Alt+Shift+D` 开始或停止

## 安装

1. 克隆本仓库。
2. 打开 `edge://extensions` 或 `chrome://extensions`。
3. 打开「开发人员模式」。
4. 选择「加载解压缩的扩展」，指向本仓库目录。

## 开发

图标由 `scripts/generate_icons.py` 生成，不依赖第三方库：

```bash
python scripts/generate_icons.py
```

## 许可

[MIT](LICENSE)
