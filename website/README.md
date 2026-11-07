# 刻页官网

沿用刻页深色 / 浅绿 UI、五段声波 Logo 与圆角波形的自适应产品官网。

## 本地开发

开发网站需要 Node.js 22.13+。这些开发依赖不影响普通用户安装刻页扩展。

```sh
cd website
npm ci
npm run dev -- --port 4173
```

打开终端打印的本地地址。网站提供产品介绍、可操作的示例工作台、功能说明、安装指引、FAQ、隐私说明和更新日志。演示不会录制网页，也不会播放真实音视频。

暂未实现注册、邮件订阅、支付、使用统计或录制上传。Sites 的私有预览访问控制属于托管平台，不是刻页注册。

## 更新安装包

在完整 ChromeRecode 工作区内执行：

```sh
cd website
npm run package:extension
```

脚本读取上级 `extension/manifest.json` 的版本，打包当前扩展与安装说明，更新 `public/downloads/` 和 `lib/release.json` 中的版本、大小与 SHA-256。打包内容排除隐藏文件，不包含开发依赖、测试数据或本地录制。

安装包是此版本的完整快照。修改扩展后需重新打包；仅更新官网布局时无需重新打包。单独克隆网站托管仓库后，需从完整产品工作区生成新版安装包，再同步下载文件与版本清单。

## 检查与构建

```sh
npm run typecheck
npm run build
```

完整工作区的浏览器检查位于上级 `tests/website.test.cjs`。先启动网站，再在工作区根目录执行：

```sh
node tests/website.test.cjs
```

可设置 `KEYE_SITE_URL` 检查另一地址，`CHROME_PATH` 指定 Chrome。截图保存在上级 `test-results/website/`。

## 托管

`.openai/hosting.json` 保存现有 Sites 项目标识。网站以 Vinext / Cloudflare Worker 构建，不需要业务数据库或对象存储。使用 Sites 技能的源代码同步和部署流程更新同一项目，保持既有访问范围。

当前元数据使用创建时的托管域名；日后绑定自有域名，需要同步修改 `app/layout.tsx` 的 `metadataBase`。页面没有虚构的 Chrome 商店地址。商店版本上线后，可将 ZIP 下载入口调整为经过确认的官方商店链接。

主要内容位于 `app/page.tsx`，样式位于 `app/globals.css`；品牌与原创示例插画位于 `public/`。页面中的工作台、波形和文件名均为演示内容。
