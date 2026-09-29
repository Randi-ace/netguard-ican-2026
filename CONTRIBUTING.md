# 净网护航 SmartGuard-NetGuard 团队开发规范

> 项目名称：净网护航 —— 基于 AI 的智能广告拦截与网络安全防护系统  
> 项目版本：v1.0-alpha  
> 仓库：https://github.com/Randi-ace/SmartGuard-NetGuard  
> 开发模式：多人协作 + Git Flow 简化流程

---

# 1. 项目简介

净网护航（SmartGuard-NetGuard）是一套基于 AI 的智能广告拦截与网络安全防护系统。

项目目标：

- 拦截恶意广告和网页风险内容
- 提供 URL 风险检测能力
- 提供 AI 文本风险识别能力
- 支持老人模式、儿童模式等安全策略
- 构建浏览器插件 + 后端服务 + 管理平台的一体化安全系统


主要技术：

- 浏览器插件：
  - Edge Extension
  - Manifest V3
  - JavaScript

- 后端：
  - Python Flask
  - SQLAlchemy
  - MySQL

- 数据库：
  - MySQL 5.7+
  - InnoDB
  - utf8mb4

---

# 2. Git 分支管理规范

项目采用 Git Flow 简化开发流程。


## 分支结构


```
master
   |
   |
develop
   |
   |
feature/*
```


---

# 3. 分支说明


## master 分支

用途：

- 发布稳定版本
- 比赛提交版本
- 正式部署版本


规则：

禁止：

- 直接提交代码
- 直接 push


所有修改必须经过：

```
feature
    ↓
develop
    ↓
master
```


---

## develop 分支

用途：

- 日常开发集成
- 多人功能合并
- 测试版本


规则：

所有新功能完成后：

```
feature分支
        ↓
develop
```


---

## feature 分支


所有成员开发必须创建自己的功能分支。


命名格式：

```
feature/功能名称
```


例如：

插件开发：

```
feature/extension-filter
```


后端接口：

```
feature/backend-risk-api
```


数据库：

```
feature/database-migration
```


前端：

```
feature/ui-dashboard
```


---

# 4. 开发流程


## 第一次加入项目


克隆仓库：

```bash
git clone https://github.com/Randi-ace/SmartGuard-NetGuard.git
```


进入项目：

```bash
cd SmartGuard-NetGuard
```


查看分支：

```bash
git branch -a
```


---

## 开始开发前


必须同步 develop：

```bash
git checkout develop

git pull origin develop
```


---

## 创建个人开发分支


例如：

```bash
git checkout -b feature/backend-api
```


之后所有代码修改都在该分支完成。


---

# 5. 提交规范


提交格式：

```
类型: 修改内容
```


## 类型说明


| 类型 | 说明 |
|-|-|
| feat | 新功能 |
| fix | Bug修复 |
| refactor | 代码重构 |
| docs | 文档修改 |
| test | 测试相关 |
| chore | 配置修改 |


---

## 示例


新增风险检测接口：

```
feat: add risk check api
```


修复数据库迁移：

```
fix: repair mysql migration issue
```


更新接口文档：

```
docs: update api document
```


修改配置：

```
chore: update backend config
```


---

# 6. 提交代码流程


查看修改：

```bash
git status
```


添加文件：

```bash
git add .
```


提交：

```bash
git commit -m "feat: xxx"
```


推送：

```bash
git push origin feature/xxx
```


---

# 7. Pull Request 规范


功能开发完成后：

不要直接合并。


流程：

```
feature分支

      ↓

提交 Pull Request

      ↓

develop审核

      ↓

合并
```


PR必须包含：


## 修改内容

例如：

```
新增URL风险检测接口
增加风险事件入库
```


## 测试情况

例如：

```
测试接口：

POST /api/risk/check

返回正常
数据库成功写入risk_events
```


## 注意事项

说明：

- 是否修改数据库
- 是否影响其他模块
- 是否需要配置修改


---

# 8. 禁止提交内容


以下文件禁止提交：


## 环境配置


禁止：

```
.env
```


禁止提交：

```
MYSQL_PASSWORD
SECRET_KEY
数据库密码
```


例如：

错误：

```python
MYSQL_PASSWORD="123456"
```


正确：

```python
MYSQL_PASSWORD=os.getenv(
    "MYSQL_PASSWORD"
)
```


---

## 数据库文件


禁止提交：

```
*.sql
*_backup.sql
数据库备份文件
```


例如：

禁止：

```
net_guard_backup_v22.sql
```


---

## 临时文件


禁止：

```
__pycache__
.venv
.idea
.vscode
*.log
```


---

# 9. 环境配置说明


项目使用环境变量。


开发人员需要创建：

```
.env
```


参考：

```
.env.example
```


示例：

```
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=
MYSQL_DB=net_guard
SECRET_KEY=
```


注意：

真实密码不要上传 Git。


---

# 10. 数据库开发规范


数据库结构修改必须：


1. 修改 migration 文件


例如：

```
database/migration/
```


2. 更新数据库文档


例如：

```
docs/DATABASE_SCHEMA.md
```


3. 测试迁移流程


禁止：

直接修改数据库。


---

# 11. 后端开发规范


新增接口必须同步：


接口文档：

```
docs/API_CONTRACT.md
```


必须说明：

- 请求方式
- 请求参数
- 返回格式
- 错误情况


例如：

```
POST /api/risk/check
```


请求：

```json
{
"url":"https://example.com"
}
```


返回：

```json
{
"risk":"safe"
}
```


---

# 12. 数据库注意事项


当前数据库标准：

```
MySQL 5.7+
InnoDB
utf8mb4
utf8mb4_unicode_ci
```


禁止：

- 使用 MyISAM
- 修改正式数据库结构
- 删除核心数据


---

# 13. 后端启动方式


安装依赖：

```bash
pip install -r requirements.txt
```


启动：

```bash
python start_backend.py
```


测试：

访问：

```
http://127.0.0.1:5000/health
```


---

# 14. 提交 Pull Request 前检查


提交前必须确认：

## Git检查

```bash
git status
```


确保：

- 没有敏感文件
- 没有数据库备份
- 没有环境文件


---

## 后端检查


确认：

- 服务正常启动
- API正常返回
- 数据库连接正常


---

# 15. 项目负责人权限


项目负责人负责：


- master管理
- PR审核
- 版本发布
- 数据库迁移审核
- 核心架构维护


未经负责人允许：

禁止：

- 修改核心数据库结构
- 删除已有接口
- 修改部署配置
- 大范围重构


---

# 16. 版本发布规范


版本格式：

```
v主版本.次版本.修订版本
```


例如：

```
v1.0-alpha
v1.1-beta
v1.0.0
```


发布流程：

```
develop

↓

测试通过

↓

master

↓

tag版本
```


---

# 17. 联系方式


项目负责人：

周敏


项目仓库：

SmartGuard-NetGuard


感谢所有成员共同维护项目。