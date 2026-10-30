# 发布到 GitHub 与 GitHub Pages

点击趋势和排行榜已加入静态站；部署共享统计服务后，在发布命令上添加 `--analytics-url https://你的统计域名`。具体流程与统计口径见 [统计说明](ANALYTICS.md)。未配置时正常发布图库，榜单明确显示未配置状态。

本功能将 Python 项目代码上传到 GitHub，发布可以持续访问的公开静态图库。图片发布者已表示取得图片的公开发布授权。访问者的收藏、标签、备注只保存在当前浏览器，不会上传或在不同设备之间自动同步；清除浏览器站点数据会丢失标记，请使用「导出当前索引」备份。导出文件目前不支持回导。

## 为什么分开保存图片

当前已采集 2,846 张原图，以及对应的缩略图和预览图，共 7,099 个文件版本，约 2.22 GB。GitHub Pages 站点限制为 1 GB，因此采用：

- `main` 分支：爬虫、本地管理网站、静态导出与发布程序。
- `gh-pages` 分支：约 152 MB 的缩略图、预览图，以及网页和公开索引。
- `originals-0` 到 `originals-c` Releases：大部分原始 PNG 按 SHA-256 首位分组，单个 Release 最多 1,000 个文件。
- `original-images` 分支：哈希首位为 d/e/f 的原图，当前 543 张、约 386 MB。网页直接读取该分支的固定 raw 地址，减少上传数千个文件时的 API 配额消耗。该分支不计入 Pages 站点体积。

网页点击详情和下载时访问 Releases 或资源分支的原图，服装详情优先使用站点内 WebP 预览。同组姿势可切换角度。图片不热链原站，因此访问不依赖原站继续运行，但仍依赖 GitHub 服务、网络和账号状态；不保证永久托管或任何地区的访问速度。下载资源分支原图时，部分浏览器可能先打开图片，可用图片菜单另存为。

公开清单使用字段白名单，**不发布本地 SQLite、个人收藏、标签、备注和回收站中的记录**。未隐藏的下载图片会公开。发布前请先停止采集；程序会拒绝缺失或未下载完整的文件。

## 首次发布（Windows PowerShell）

需要 Git、GitHub CLI 和 Python 3.10+。当前电脑已找到 GitHub CLI，但 CLI 尚未登录；应用里的 GitHub 连接不等于 CLI 登录。

先执行一次登录，按提示用浏览器登录 `XTurnV007`：

```powershell
gh auth login --hostname github.com --git-protocol https --web
```

不要把登录令牌、密码或验证码发到聊天里。完成后执行：

```powershell
cd F:\start_your_own_bussiness\self_media\AIIP\reference_library
& "G:\python311\python.exe" publish_github.py --repo XTurnV007/reference-library --authorized-images
```

`--authorized-images` 表示发布者确认已取得所发布图片的公开发布授权。程序会创建公开仓库 `XTurnV007/reference-library`，上传代码和原图，推送静态页面，并配置 GitHub Pages。如果该名称已经属于其他项目，程序会停止，不覆盖已有项目。

上传原图约 2.06 GB，首次上传可能较久。每批 20 个文件后输出进度，已存在且大小及可用远端摘要一致的文件跳过；中断后运行相同命令即可继续。不要同时运行多个发布进程。GitHub API 限流或网络错误时可稍后重试。

默认 `--archive-from d` 将末三组原图放到资源分支，减少 API 请求；后续发布应保持相同分组。`build_static.py` 默认也采用此策略。只有确定配额充足且有意迁移时才改为 `--archive-from none`（全部走 Releases）。仅克隆源码时建议 `git clone --single-branch --branch main https://github.com/XTurnV007/reference-library.git`，避免下载资源分支。

脚本输出的仓库地址为真实仓库地址，Pages 地址先标为待构建。只有 GitHub 返回当前网页提交已构建完成，脚本才报告「Pages 构建已完成」。等待超时不代表失败，可在仓库 Actions 查看。

如果 Pages 配置接口权限不足，打开仓库 **Settings → Pages → Build and deployment**，选择 **Deploy from a branch**，分支为 **gh-pages**、目录 **/ (root)**，保存后重试发布命令。

## 以后更新图库

```powershell
# 先采集更新
& "G:\python311\python.exe" crawler.py --source all
# 再发布，已上传的原图会跳过
& "G:\python311\python.exe" publish_github.py --repo XTurnV007/reference-library --authorized-images
```

自定义数据目录时两个命令都加同一个 `--data`，例如：

```powershell
& "G:\python311\python.exe" publish_github.py --repo XTurnV007/reference-library --data "$env:LOCALAPPDATA\AIIP-reference-library" --authorized-images
```

## 仅导出静态文件

```powershell
& "G:\python311\python.exe" build_static.py --repo XTurnV007/reference-library
```

输出为 `site/`。原图仍需发布到对应 Releases，单独执行导出不会上传任何内容，也不会生成可访问的网址。导出目录旁的 `.publish-state.json` 包含本地路径，不应上传；`.gitignore` 已排除生成数据。公开站点中没有在线爬虫；更新由发布命令执行。

## 验证

回归测试按项目约定由你执行；发布前建议先运行：

```powershell
& "G:\python311\python.exe" -m unittest -v
```

发布后检查：主页显示全部记录；分类和搜索工作；姿势详情可切换视角；原图下载成功；刷新页面收藏仍在；另一个浏览器不显示你的个人收藏。静态导出的回归测试覆盖不泄露个人标记、缺失文件拒绝发布以及子目录资源路径。

参考：[GitHub Pages 限制](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)、[Releases 配额](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)。
