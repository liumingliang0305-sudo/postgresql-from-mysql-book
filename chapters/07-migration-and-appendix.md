# 第七部分：从 MySQL 平稳迁移

## 第 32 章：迁移前如何发现兼容性问题？

迁移失败很少是因为 `CREATE TABLE` 无法转换，更多是因为应用依赖了没有写进表结构的 MySQL 行为。兼容性评估要覆盖结构、数据、SQL、驱动和运维五个层次。

### 先建立对象和特性清单

至少统计：

- database、表、行数、数据量、增长率；
- 主键、唯一键、外键、索引和分区；
- 视图、触发器、存储过程、事件调度；
- 字符集、collation、时区和零日期；
- unsigned、enum、set、JSON、二进制和空间类型；
- 自增列当前值与增长速度；
- 账号、权限、审计和备份要求。

清单要标出“自动转换”“需要规则”“必须重构”三种状态。存储过程和依赖特定方言的 SQL 通常不能靠文本替换完成。

### 用真实 SQL 而不是代码搜索做评估

从慢日志、性能视图或代理层采集一段有代表性的 SQL，按调用频率和总耗时排序。重点寻找：

- 反引号、双引号字符串和大小写敏感对象名；
- `IFNULL`、`GROUP_CONCAT`、`FIND_IN_SET`；
- `ON DUPLICATE KEY UPDATE`；
- `LIMIT offset,count`；
- 用户变量、宽松 `GROUP BY`；
- 隐式类型转换和空字符串写数值；
- `REPLACE INTO`、多表更新和删除；
- 依赖 MySQL 错误码或 `LAST_INSERT_ID()` 的代码。

每条高频 SQL 都应在目标库用代表性参数生成实际计划。语法通过只是第一关。

### 数据质量会在更严格的类型系统中暴露

迁移前扫描非法日期、越界数值、孤儿外键、重复候选键、混合布尔值、无效 JSON 和不可转换字符。先定义清洗规则，再执行转换；不要让迁移工具在遇到脏数据时临时猜测。

### 驱动行为同样属于兼容性

验证参数占位符、批量接口、返回生成键、时区映射、布尔值、数值精度、prepared statement、连接池健康检查和错误码。ORM 能隐藏 SQL 方言，但不能隐藏事务隔离和类型语义。

### 双库结果比对要区分顺序与语义

没有 `ORDER BY` 的结果顺序不能比较；浮点、时间精度、JSON 键顺序和 collation 也需要归一化。比对应基于主键集合、业务聚合、约束结果和关键查询语义。

**本章结论**：兼容性不是语法问题清单，而是应用依赖的数据库行为清单。越早用真实 SQL 和真实脏数据验证，切换时的不确定性越小。

**思考题**：ORM 已宣称支持 PostgreSQL，为什么仍要采集生产 SQL 做兼容性分析？

## 第 33 章：全量、增量和切换怎样设计？

低停机迁移通常由三条数据路径构成：先搬历史数据，再持续同步变更，最后在可控窗口切换写入。任何一条路径没有校验，最终都可能得到“看起来同步”的错误数据。

### 阶段一：搭建目标结构与基线

先转换 schema，再建立最小必要索引和约束。全量导入可进入 staging 表，完成类型转换、重复检测和业务校验后再合并。大型二级索引常在数据加载后创建更快，但主键、分片键和增量应用所需唯一键必须提前保留。

全量期间记录一致性位置，例如源库 binlog 位点或 GTID 集合，增量同步必须从与快照对应的位置开始。

### 阶段二：持续应用增量

CDC 需要处理插入、更新、删除、DDL、事务顺序和断点恢复。至少验证：

- 同一事务在目标端是否保持原子；
- 主键变更如何表示；
- 无主键表如何定位行；
- 大事务与长事务如何影响延迟；
- DDL 是否被阻断、转换或人工执行；
- 重放是否幂等，重启后是否重复。

不建议把应用双写当作唯一同步方案。两个独立数据库之间没有自然的原子提交，任一侧超时都会产生不确定状态。若必须双写，应有事务外盒、可重放事件和持续对账，而不是只写两次 SQL。

### 阶段三：切换前追平并冻结变量

典型切换顺序：

1. 冻结数据库结构变更和高风险发布；
2. 降低源库长事务与批任务；
3. 将源应用进入短暂只读或停止写入；
4. 等待 CDC 位点追平；
5. 执行行数、聚合、抽样和关键业务校验；
6. 校准序列，使新值高于已导入主键；
7. 切换连接与读写流量；
8. 运行冒烟测试并持续观察；
9. 达到退出条件后结束回退窗口。

校准 identity 背后的序列时，先解析真实序列名，不要假设命名：

```sql
SELECT pg_get_serial_sequence('public.orders', 'id');
```

### 回退方案必须说明数据去哪

如果切换后目标库已经接受新写入，简单把连接改回 MySQL 会丢失这部分数据。回退计划要么保持反向增量链路，要么在切换后的短窗口内冻结写入并明确丢弃/补偿策略。

**本章结论**：迁移是快照、变更流、校验和流量控制共同组成的状态机。切换步骤必须能对应到明确的进入条件、成功证据和回退条件。

**思考题**：目标库已经写入十分钟后发现错误，为什么“改回连接串”不是完整回退方案？

## 第 34 章：上线后为什么还要重新做一次性能基线？

迁移完成只证明业务可以运行，不证明运行方式已经适合 PostgreSQL。缓存、统计信息、数据物理布局和连接模型都可能在切换后继续变化。

### 先让统计信息可信

批量导入后应对关键表执行 ANALYZE，确认 autovacuum 已接管新表。计划中的行数估算若明显错误，优先修正统计信息和数据类型。

### 建立四组基线

1. 业务：吞吐、错误率、P50/P95/P99、队列长度；
2. SQL：调用次数、总耗时、平均/分位耗时、返回行数；
3. 数据库：连接、事务、锁等待、临时文件、WAL、检查点、autovacuum；
4. 系统：CPU、内存、存储延迟与吞吐、网络、磁盘容量。

把这些指标按同一时间窗口关联。单独一张“CPU 使用率”图无法解释数据库是否健康。

### 给计划变化留档

为关键 SQL 保存参数化样例和 `EXPLAIN (ANALYZE, BUFFERS)`。数据增长、统计更新或版本升级后，计划可能改变。基线不是要求计划永远相同，而是能够解释变化是否合理。

### 逐项清理迁移临时措施

迁移时可能暂时关闭约束、提高连接数、放宽超时、保留重复索引或创建宽泛权限。上线后应有明确清单逐项恢复，否则临时配置会成为永久风险。

### 完成一次恢复和故障转移演练

新平台的备份只有实际恢复后才可信，高可用只有真实切换后才可信。演练要包含应用重连、序列与权限、后台作业、复制槽和监控告警，不只确认数据库进程启动。

**本章结论**：迁移后的前几周是建立 PostgreSQL 运行模型的阶段。用基线、计划留档和演练替代“没有报警就是稳定”。

**思考题**：同一条查询上线第一天很快、一个月后变慢，哪些数据分布与统计变化值得优先检查？

## 附录 A：MySQL 与 PostgreSQL 常用概念对照

| MySQL | PostgreSQL | 迁移提示 |
|---|---|---|
| server instance | cluster / instance | PostgreSQL cluster 包含多个 database |
| database | schema 或 database | 多数命名空间场景映射为 schema |
| user + role | role | `LOGIN` 决定能否登录 |
| `AUTO_INCREMENT` | identity + sequence | 序列值可能有空洞，独立于事务回滚 |
| InnoDB 聚簇主键 | heap + 独立主键索引 | 普通表不按主键持续排序 |
| undo log 版本 | heap 中多行版本 | 旧版本由 VACUUM 回收 |
| redo log | WAL | WAL 同时服务恢复、复制和归档 |
| binlog | 逻辑解码/WAL 生态 | 层次和格式不直接等价 |
| 默认 Repeatable Read | 默认 Read Committed | 每条语句取得新快照 |
| `SHOW PROCESSLIST` | `pg_stat_activity` | 结合 wait event 分析 |
| `EXPLAIN` | `EXPLAIN` | 用 `ANALYZE, BUFFERS` 看真实执行 |
| `ON DUPLICATE KEY UPDATE` | `ON CONFLICT` | 明确唯一冲突目标 |
| `LAST_INSERT_ID()` | `RETURNING` | 可直接返回多列和多行 |
| `IFNULL(a,b)` | `coalesce(a,b)` | 标准空值表达 |
| `GROUP_CONCAT` | `string_agg` | 显式指定分隔符和顺序 |
| `JSON` | `json` / `jsonb` | 多数查询场景优先评估 jsonb |
| `DATETIME` | `timestamp` | 都不表达绝对时刻的时区语义 |
| `TIMESTAMP` | `timestamptz` | PostgreSQL 内部保存时刻，按会话时区显示 |
| `UNSIGNED` | 更大类型 + `CHECK` | 没有通用 unsigned 整数类型 |
| `mysqldump` | `pg_dump` | 逻辑备份；集群级对象需单独处理 |
| 主从复制 | 物理/逻辑复制 | 明确同步层级、槽与 WAL 保留 |

## 附录 B：常用诊断 SQL

### 版本、时间与当前身份

```sql
SELECT version();
SELECT current_database(), current_user, current_schema, now();
SHOW server_version;
SHOW transaction_isolation;
```

### 数据库和关系大小

```sql
SELECT pg_size_pretty(pg_database_size(current_database()));

SELECT n.nspname AS schema_name,
       c.relname,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size,
       pg_size_pretty(pg_relation_size(c.oid)) AS table_size,
       pg_size_pretty(pg_indexes_size(c.oid)) AS indexes_size
FROM pg_class AS c
JOIN pg_namespace AS n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'm')
ORDER BY pg_total_relation_size(c.oid) DESC
LIMIT 30;
```

### 长事务与空闲事务

```sql
SELECT pid,
       usename,
       state,
       now() - xact_start AS xact_age,
       now() - query_start AS query_age,
       wait_event_type,
       wait_event,
       left(query, 160) AS query
FROM pg_stat_activity
WHERE xact_start IS NOT NULL
ORDER BY xact_start;
```

### 阻塞关系

```sql
SELECT blocked.pid AS blocked_pid,
       pg_blocking_pids(blocked.pid) AS blocker_pids,
       blocked.wait_event_type,
       blocked.wait_event,
       left(blocked.query, 120) AS blocked_query
FROM pg_stat_activity AS blocked
WHERE cardinality(pg_blocking_pids(blocked.pid)) > 0;
```

### 表写入与 VACUUM 概况

```sql
SELECT schemaname,
       relname,
       n_live_tup,
       n_dead_tup,
       n_tup_ins,
       n_tup_upd,
       n_tup_hot_upd,
       last_autovacuum,
       last_autoanalyze,
       autovacuum_count,
       autoanalyze_count
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC
LIMIT 30;
```

### 数据库事务号年龄

```sql
SELECT datname, age(datfrozenxid) AS xid_age
FROM pg_database
ORDER BY xid_age DESC;
```

### 索引使用概况

```sql
SELECT schemaname,
       relname,
       indexrelname,
       idx_scan,
       pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
FROM pg_stat_user_indexes
ORDER BY pg_relation_size(indexrelid) DESC;
```

`idx_scan = 0` 不足以证明索引无用。统计可能刚重置，索引可能服务约束、月末任务或极少发生但关键的查询。删除前要经过完整业务周期并检查约束依赖。

### 复制状态

```sql
SELECT application_name,
       client_addr,
       state,
       sync_state,
       sent_lsn,
       write_lsn,
       flush_lsn,
       replay_lsn,
       write_lag,
       flush_lag,
       replay_lag
FROM pg_stat_replication;
```

### 复制槽保留量

```sql
SELECT slot_name,
       slot_type,
       active,
       restart_lsn,
       confirmed_flush_lsn,
       catalog_xmin,
       CASE
           WHEN restart_lsn IS NULL THEN NULL
           ELSE pg_size_pretty(
               pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)
           )
       END AS retained_wal
FROM pg_replication_slots;
```

## 附录 C：实验环境与练习

所有实验都应在可重建环境执行。建议创建独立数据库和普通实验角色：

```sql
CREATE ROLE book_user LOGIN PASSWORD 'book_password';
CREATE DATABASE booklab OWNER book_user;
```

连接后创建一组基础表：

```sql
CREATE TABLE account (
    id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    email text NOT NULL UNIQUE,
    balance numeric(18,2) NOT NULL DEFAULT 0,
    last_seen_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE orders (
    id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    account_id bigint NOT NULL REFERENCES account(id),
    status text NOT NULL CHECK (status IN ('new', 'paid', 'cancelled')),
    total_amount numeric(18,2) NOT NULL CHECK (total_amount >= 0),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_orders_account_created
ON orders (account_id, created_at DESC);
```

### 练习 1：观察快照

打开两个会话，在 Read Committed 与 Repeatable Read 下重复查询。记录另一会话提交后，两次查询结果的变化。

### 练习 2：制造版本并清理

批量插入后反复更新同一批行，观察 `n_tup_upd`、`n_tup_hot_upd`、`n_dead_tup` 与表大小。执行普通 VACUUM，区分“可复用空间”和“文件收缩”。

### 练习 3：构造 DDL 阻塞链

会话 A 打开事务并查询表；会话 B 执行 `ALTER TABLE`；会话 C 再查询同一表。用 `pg_stat_activity` 和 `pg_blocking_pids` 解释等待顺序。只在实验库执行。

### 练习 4：让估算出错

构造强相关的两列，对组合条件执行 `EXPLAIN ANALYZE`；创建扩展统计并重新 ANALYZE，比较 estimated rows 的变化。

### 练习 5：观察排序 spill

在会话中设置较小 `work_mem`，执行需要全量排序的查询，观察计划中的排序方法和临时读写；再局部调整并比较。不要用全局参数完成练习。

### 练习 6：验证恢复而不是验证备份文件

生成逻辑备份，在新的空数据库恢复，检查对象、行数、序列、权限和关键查询。记录实际 RTO，以及所有无法自动完成的步骤。

## 参考资料

- [PostgreSQL 当前版本官方文档](https://www.postgresql.org/docs/current/)
- [并发控制与 MVCC](https://www.postgresql.org/docs/current/mvcc.html)
- [例行 VACUUM](https://www.postgresql.org/docs/current/routine-vacuuming.html)
- [显式锁](https://www.postgresql.org/docs/current/explicit-locking.html)
- [索引类型](https://www.postgresql.org/docs/current/indexes-types.html)
- [使用 EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html)
- [查询规划器统计信息](https://www.postgresql.org/docs/current/planner-stats.html)
- [WAL 配置](https://www.postgresql.org/docs/current/wal-configuration.html)
- [备份与恢复](https://www.postgresql.org/docs/current/backup.html)
- [高可用、负载均衡与复制](https://www.postgresql.org/docs/current/high-availability.html)

