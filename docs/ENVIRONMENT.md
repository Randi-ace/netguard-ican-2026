# 环境变量说明


项目通过 `.env` 管理本地配置。


---

# 配置文件


模板：

```
.env.example
```


实际：

```
.env
```


注意：

`.env`

禁止提交Git。


---

# 配置说明


## 数据库


### MYSQL_HOST

数据库地址：

默认：

```
127.0.0.1
```


---

### MYSQL_PORT

数据库端口：

默认：

```
3306
```


---

### MYSQL_USER

数据库用户名：

例如：

```
root
```


---

### MYSQL_PASSWORD

数据库密码。


示例：

```
MYSQL_PASSWORD=your_password
```


---

### MYSQL_DB


数据库名称：

默认：

```
net_guard
```


---

# 安全配置


## SECRET_KEY


用于：

- Flask Session
- JWT安全


示例：

```
SECRET_KEY=random_secret_string
```


生产环境必须修改。


---

# 开发环境示例


```
MYSQL_HOST=127.0.0.1

MYSQL_PORT=3306

MYSQL_USER=root

MYSQL_PASSWORD=root

MYSQL_DB=net_guard

SECRET_KEY=change_me
```


---

# 注意事项


禁止：

提交：

```
.env
```


禁止：

提交：

```
数据库密码
```

禁止：

提交：

```
数据库备份文件
```

