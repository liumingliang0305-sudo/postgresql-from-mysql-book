# 第二部分：事务与并发控制

## 第 5 章：同样叫 Read Committed，看到的数据为什么不同？

假设事务 A 连续执行两次余额汇总，两次查询之间事务 B 提交了一笔充值。在 PostgreSQL 默认的 Read Committed 下，事务 A 的第二次查询可以看到这笔充值，因为每条语句都会取得一个新的快照。

```sql
BEGIN;
SELECT sum(balance) FROM account;  -- 快照 S1
SELECT sum(balance) FROM account;  -- 快照 S2，可能看到新提交
COMMIT;
```

这与许多 MySQL/InnoDB 应用在默认 Repeatable Read 下形成的直觉不同。迁移时若只检查隔离级别名称，不检查业务对快照的依赖，报表、对账和批处理都可能出现语义变化。

### 四个名称，三个实际层级

PostgreSQL 接受四个标准名称，但 Read Uncommitted 的实际行为与 Read Committed 相同，不会脏读。

| 隔离级别 | 快照范围 | 主要特征 |
|---|---|---|
| Read Committed | 每条语句 | 同一事务内可读到其他事务的新提交 |
| Repeatable Read | 整个事务 | 稳定快照；可能因并发更新而失败 |
| Serializable | 整个事务 + SSI 检测 | 阻止无法串行解释的结果，失败时需重试 |

PostgreSQL 的 Repeatable Read 基于快照隔离，连标准所说的幻读也不会出现，但仍可能发生写偏差。两个事务各自看到“至少还有一名医生值班”，然后分别把自己改为休息，最终可能无人值班。每条语句读到的内容都合理，组合后的业务状态却不合理。

### 显式设置隔离级别

隔离级别要在事务执行查询或修改之前设置：

```sql
BEGIN;
SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
-- 事务主体
COMMIT;
```

长时间保持同一个快照会阻碍旧版本回收。需要稳定快照的导出任务，应控制运行时间、监控事务年龄，并避免在交互式客户端中遗忘事务。

### 应用必须处理事务失败

事务中任一语句报错后，事务会进入 aborted 状态；只有 `ROLLBACK` 或回滚到保存点后才能继续。不能像处理普通函数异常那样忽略错误并继续提交。

```sql
BEGIN;
SAVEPOINT before_optional_step;
-- 可能失败的语句
ROLLBACK TO SAVEPOINT before_optional_step;
COMMIT;
```

**本章结论**：选择隔离级别时，先定义业务需要“一条语句一致”还是“整个事务一致”，再决定是否还要防止写偏差。不要照搬 MySQL 默认值。

**思考题**：一个导出任务先查订单再查明细，要求两者来自同一时间点，Read Committed 是否足够？

## 第 6 章：PostgreSQL 的 MVCC 为什么会留下旧版本？

PostgreSQL 更新一行时，通常不是在原位置覆盖全部内容，而是创建一个新行版本，并把旧版本标记为对未来事务不可见。这样，正在使用旧快照的查询仍能读取旧版本，新事务则读取新版本。

每个堆元组头部包含可见性相关信息。可以把 `xmin` 理解为创建该版本的事务号，把 `xmax` 理解为删除或替换该版本的事务号；真实可见性判断还会结合事务提交状态、当前快照、命令序号和标志位。

```sql
SELECT ctid, xmin, xmax, id, balance
FROM account
WHERE id = 1;
```

这些系统列适合实验和诊断，不应当作为长期业务接口。`ctid` 是某个版本在某个页面中的物理位置，更新、表重写或行移动后都可能变化。

### 读写为何通常不互相阻塞

读事务按快照判断哪些版本可见，无需等待普通更新事务释放读锁；写事务创建新版本，也无需覆盖读者正在查看的旧版本。因此，PostgreSQL 能保持“读不挡写、写不挡读”的核心特性。

但这不意味着没有锁。修改同一行的事务仍会互相等待；外键检查、唯一性检查、显式 `SELECT ... FOR UPDATE`、DDL 和表级操作也会取得相应锁。

### HOT 更新为什么重要

如果更新没有修改任何索引引用的列，并且同一堆页面有足够空间，PostgreSQL 可能执行 Heap-Only Tuple（HOT）更新。新版本只接在堆页的版本链上，无需为每个索引写入新条目。

HOT 能降低写放大和索引膨胀。过高的页填充率会让页面缺少空间，可对高频更新表设置较低 `fillfactor`，用空间换 HOT 机会：

```sql
ALTER TABLE account SET (fillfactor = 80);
```

这个设置只影响以后写入或重写的页面，不会自动整理现有数据。

### 更新一列，也可能产生多份成本

一次更新可能涉及新堆元组、旧版本标记、WAL、多个索引条目、约束检查以及后续 VACUUM。MySQL 用户若只按“受影响一行”估算成本，会低估高频更新字段和宽表的写放大。

**本章结论**：MVCC 把读写冲突转化为版本管理问题。旧版本不是垃圾设计，而是并发读取的代价；VACUUM、HOT 和合理的表结构负责控制这项代价。

**思考题**：一个只更新 `last_seen_at` 的热点表，为什么新增该列索引后写入压力可能明显上升？

## 第 7 章：VACUUM 在清理什么，为什么不能停？

删除一百万行后，操作系统看到的表文件通常不会立即缩小。普通 VACUUM 的主要任务是把不再对任何事务可见的旧版本标记为可复用，而不是把每个空洞都归还给操作系统。

### VACUUM 有四项关键工作

第一，回收 dead tuple 占用的空间，供同一表后续写入复用。第二，维护可见性映射，为 index-only scan 提供页面级依据。第三，清理索引中的无效引用。第四，冻结足够老的事务号，防止事务号回卷威胁。

`ANALYZE` 则采样数据并更新优化器统计信息。`VACUUM (ANALYZE)` 同时做两件事，但它们的目的不同。

```sql
VACUUM (VERBOSE, ANALYZE) orders;
```

生产环境通常依赖 autovacuum。正确做法不是关闭它，而是针对高变更表调整触发阈值、工作进程和成本限制。

### 百分比阈值会放过大表

自动清理的触发条件由固定阈值和表规模比例共同决定。一个十亿行表即使只有百分之一失效，也已经是一千万行。大表需要更小的 scale factor，甚至按表设置：

```sql
ALTER TABLE event_log SET (
    autovacuum_vacuum_scale_factor = 0.01,
    autovacuum_analyze_scale_factor = 0.005
);
```

参数只是起点，最终要观察变更速率、每次清理耗时、dead tuple 变化和 I/O 影响。

### 长事务会划出一条回收禁区

只要旧快照仍可能访问某个行版本，VACUUM 就不能回收它。常见阻碍包括：

- 打开后长时间不提交的事务；
- `idle in transaction` 会话；
- 长时间运行的报表；
- 复制反馈或复制槽保留的旧 `xmin`；
- 逻辑解码长时间不消费。

先找最老事务：

```sql
SELECT pid,
       usename,
       state,
       now() - xact_start AS xact_age,
       left(query, 120) AS query
FROM pg_stat_activity
WHERE xact_start IS NOT NULL
ORDER BY xact_start;
```

可以用 `idle_in_transaction_session_timeout` 限制被遗忘的交互事务，但它不是替代正确事务边界的补丁。

### 回卷不是普通性能问题

事务号空间有限，PostgreSQL 通过冻结旧版本使其对未来事务持续可见。如果数据库中的最老未冻结事务号年龄接近危险边界，系统会启动更激进的防回卷清理；继续恶化时，数据库可能拒绝正常命令以保护数据。

```sql
SELECT datname, age(datfrozenxid)
FROM pg_database
ORDER BY age(datfrozenxid) DESC;
```

`VACUUM FULL` 会重写整张表，能收缩文件，却需要强锁和额外磁盘空间，不能当作日常清理命令。

**本章结论**：VACUUM 负责可复用空间、可见性和事务号安全。真正需要治理的是版本产生速度、清理能力和最老快照三者的平衡。

**思考题**：dead tuple 持续增加时，为什么第一反应不应该是直接执行 `VACUUM FULL`？

## 第 8 章：只改一张小表，为什么 DDL 也可能拖住业务？

表很小，不代表改表风险很小。真正危险的常常不是重写数据的时间，而是等待强锁期间形成的阻塞队列。

许多 DDL 需要 `ACCESS EXCLUSIVE` 表锁，它与普通查询取得的 `ACCESS SHARE` 锁冲突。若事务 A 查询后一直不提交，事务 B 的 DDL 会等待；新的业务查询又可能排在等待中的强锁之后，短时间内堆积大量连接。

```text
事务 A：BEGIN → SELECT t → 长时间未提交
事务 B：ALTER TABLE t ... → 等待 A
事务 C：SELECT t → 可能排在 B 后继续等待
```

这类事故的核心与 MySQL 的 MDL 队列相似：危险来自事务边界和锁队列，不只来自表大小。

### 改表前先限制等待，而不是无限排队

```sql
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30min';
ALTER TABLE orders ADD COLUMN source text;
COMMIT;
```

`lock_timeout` 控制等待锁的时间，`statement_timeout` 控制语句总时间。前者应小于后者。拿不到锁就快速失败，在低峰重试，通常比把业务请求拖入队列安全。

### 先看谁挡住谁

```sql
SELECT a.pid,
       a.state,
       a.wait_event_type,
       a.wait_event,
       pg_blocking_pids(a.pid) AS blockers,
       left(a.query, 120) AS query
FROM pg_stat_activity AS a
WHERE cardinality(pg_blocking_pids(a.pid)) > 0;
```

不要看到阻塞就立即终止会话。先确定阻塞者是否为关键写事务、是否可安全重试、终止后应用会做什么。

### `CONCURRENTLY` 不是“没有代价”

`CREATE INDEX CONCURRENTLY` 允许建索引期间继续写入，但需要多阶段扫描，耗时更长，失败后还可能留下 invalid 索引。它不能放在普通事务块中执行。

```sql
CREATE INDEX CONCURRENTLY idx_orders_created_at
ON orders (created_at);
```

执行后要检查索引是否有效，并确认磁盘、WAL、复制延迟和 autovacuum 没有被压垮。

PostgreSQL 不做行锁自动升级，但大量行锁仍可能造成等待、内存和业务争用。避免锁升级不等于可以忽视大事务。

**本章结论**：上线 DDL 的第一目标是控制锁等待影响面，其次才是缩短 DDL 本身。小表同样需要短事务、锁超时和可回退计划。

**思考题**：`CREATE INDEX CONCURRENTLY` 失败后，为什么不能只看命令报错就结束处理？

## 第 9 章：可串行化隔离如何发现业务规则冲突？

可串行化隔离要保证并发执行的结果，等价于这些事务按照某种顺序逐个执行。PostgreSQL 使用 Serializable Snapshot Isolation（SSI）检测可能形成异常的读写依赖，而不是把所有读操作都变成阻塞锁。

仍以值班规则为例。两个事务都读取当前值班人数，然后各自把一名医生改为休息。在 Repeatable Read 中，两次更新不触碰同一行，可能同时成功；在 Serializable 中，系统会发现依赖关系无法安全串行化，并让其中一个事务以 serialization failure 失败。

```sql
BEGIN ISOLATION LEVEL SERIALIZABLE;
SELECT count(*) FROM duty WHERE on_call;
UPDATE duty SET on_call = false WHERE doctor_id = $1;
COMMIT;
```

### 正确用法包含“整体重试”

序列化失败不是数据库损坏，而是并发控制的正常结果。应用必须从事务开始处重试，不能只重试最后一条语句。重试需要满足三个条件：

1. 整个事务逻辑可以重新执行；
2. 外部调用、消息发送等副作用具有幂等设计；
3. 使用有限次数和随机退避，避免冲突风暴。

死锁失败也需要整体重试，但它与 SSI 冲突不同。死锁来自等待环；SSI 失败来自无法安全串行化的依赖图。

### Predicate lock 不等于普通阻塞锁

SSI 会跟踪谓词级读依赖，系统视图中可能看到 `SIReadLock`。它用于检测危险结构，通常不会像普通表锁那样阻塞写入。不要因为看到“lock”就用同一套处理方式。

只读可串行化事务若声明 `DEFERRABLE`，可以在开始阶段等待一个安全快照，之后避免因序列化异常失败，适合长时间只读报表：

```sql
BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE
READ ONLY DEFERRABLE;
```

**本章结论**：Serializable 把难以手写的业务并发规则交给数据库检测，但代价是应用必须接受并正确重试事务。

**思考题**：如果事务内已经调用了不可撤销的第三方支付接口，序列化失败后为什么不能直接重试？

