# 记忆库结构

运行时记忆库位于 `~/Library/Application Support/Friday/`，**不在仓库内**。本目录只提交结构说明与示例，首次启动时 core 按这里的模板初始化。

```
~/Library/Application Support/Friday/
├── projects.md      # 项目注册表：名称、代码目录、当前状态
├── decisions.md     # 决策记录：日期 + 一句话结论
├── people.md        # 人物：谁负责什么、怎么联系
├── todos.db         # SQLite：待办、同步状态、会话日志（schema 见 todos.sql）
└── logs/            # 运行日志，按天滚动
```

Markdown 文件是半结构化的，用二级标题分条，Claude 直接读全文。SQLite 存需要查询和去重的数据。
