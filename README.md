# yingmoon 的 DSH 插件库

我们自己写的 DeepSeek Harness (DSH) 插件，都放在这里。

## 收录

| 插件 | 做什么 |
|---|---|
| [rightbar-driver](plugins/rightbar-driver/) | 驱动 DSH 右推栏里的内置浏览器：打开、导航、读取页面正文与可交互元素、点击、填字、关闭 |

## 安装

```
dsh plugin add github:Yingmoon0715/yingmoon-plugins#path:/plugins/rightbar-driver
```

或在 DSH 内的插件市场搜索安装。

## 说明

每个插件一个目录，各自带 README 与 package.json，可单独安装。
新增插件请走分支 + Pull Request 流程，不要直接推 main。
