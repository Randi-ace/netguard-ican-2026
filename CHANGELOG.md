# Changelog

所有版本更新记录。


---

# v1.0-alpha

发布日期：

2026-07-31


## Added

新增：

- 项目Git团队开发规范
- master/develop分支管理
- CONTRIBUTING.md
- DEVELOPMENT_SETUP.md

新增数据库：

- risk_events
- ad_events
- settings


新增接口：

- AI检测接口
- URL检测接口
- 风险记录接口
- 用户设置接口


---

## Changed

修改：

- SQLAlchemy模型统一使用InnoDB
- 数据库字符集统一为utf8mb4
- 完成MySQL迁移方案


---

## Fixed

修复：

- MyISAM导致外键失效问题
- AI检测结果无法记录问题
- URL检测历史记录问题
- 设置接口数据同步问题


---

## Database

完成：

- v1_precheck.sql

- v1_migration.sql


迁移验证：

- 数据完整
- 外键正常
- 引擎统一


---

# Future

计划：

## v1.1

预计：

- 完善浏览器插件
- 增强广告拦截策略
- 优化AI风险模型


## v2.0

计划：

- 用户管理平台
- 可视化Dashboard
- 移动端原型