# 第六部分：把数据库运行好

## 第 26 章：内存参数为什么不能按总内存等比例放大？

数据库内存不是一个大池子。共享缓冲区、每个后端进程、排序与哈希、维护任务、WAL、操作系统页缓存和连接池都在竞争内存。把几个参数分别按物理内存比例设置，最后相加很容易超过机器容量。

### `shared_buffers` 是共享页缓存的一部分

PostgreSQL 把常用数据页放在共享缓冲区中，操作系统也会缓存文件页。`shared_buffers` 不是越接近总内存越好；设置过大可能挤压操作系统缓存和进程内存，还会改变检查点需要管理的脏页规模。

`effective_cache_size` 不会预分配内存，它只是告诉优化器可合理预期有多少数据能从 PostgreSQL 与操作系统缓存中命中。把它误当成真实缓存配置，会产生错误容量规划。

### `work_mem` 按操作分配

排序、哈希、物化等执行节点可能分别使用 `work_mem`，并行 worker 也可能各自使用。容量评估应从高峰并发查询和计划形态出发，而不是只看单条查询。

先从保守全局值开始，对已确认会 spill 且并发可控的报表做会话或事务级调整：

```sql
BEGIN;
SET LOCAL work_mem = '128MB';
-- 已验证查询
COMMIT;
```

### 维护内存同样会并发

`maintenance_work_mem` 服务 VACUUM、建索引等维护动作；autovacuum 可使用单独的 `autovacuum_work_mem`。多个 worker 同时清理大表时，不能按单进程预算。

### 调优顺序

1. 记录常态和峰值 RSS、swap、page fault、缓存命中与临时文件；
2. 找出内存由连接、查询操作还是维护任务消耗；
3. 对目标工作负载小步调整；
4. 在接近真实并发下压测；
5. 保留操作系统和突发任务余量。

如果系统已经开始持续 swap，继续提高缓存参数通常只会放大抖动。先降低并发或单查询内存，再定位异常计划。

**本章结论**：共享内存按实例分配，工作内存按执行节点和并发放大，维护内存按任务放大。任何参数都必须放进同一份峰值预算。

**思考题**：`work_mem = 64MB`、100 个并发连接，为什么不能简单认为最多使用 6.4GB？

## 第 27 章：连接数越大，吞吐量为什么可能越低？

当请求开始排队，最直觉的动作是提高 `max_connections`。但更多连接会增加后端进程内存、上下文切换、锁竞争和缓存抖动。如果 CPU 和存储已经饱和，允许更多工作同时进入，只会让每个请求完成得更慢。

### 数据库连接是一种受限执行许可

连接池不只减少握手，它还应限制数据库并发。应用实例数量增加时，总池大小是所有实例之和；扩容应用却不调整单实例池，很容易把数据库压垮。

一个可操作的起点是：

```text
总数据库并发 = 应用实例数 × 每实例最大活跃连接
```

再为管理、迁移、监控和复制保留连接。最终值要通过吞吐—延迟曲线确定：增加并发直到吞吐不再上升，再留出安全余量。

### 会话池和事务池的语义不同

会话池长期绑定客户端与服务端连接，支持临时表、会话级 `SET`、会话 advisory lock 和完整的准备语句语义。事务池只在事务期间绑定，复用率更高，但应用不能假设下一次事务仍落到同一后端。

采用事务池前，要审计：

- 会话级参数是否每次事务都设置；
- 临时表是否跨事务使用；
- LISTEN/NOTIFY 消费方式；
- prepared statement 与连接池的兼容策略；
- advisory lock 是事务级还是会话级。

### 空闲事务比空闲连接危险

普通 idle 连接主要占资源；`idle in transaction` 还持有事务快照和可能的锁，会阻碍 VACUUM。应用必须确保异常路径 rollback，并为交互事务设置合理超时。

```sql
SELECT pid, state, now() - xact_start AS age, left(query, 100)
FROM pg_stat_activity
WHERE state = 'idle in transaction'
ORDER BY xact_start;
```

**本章结论**：连接池的核心职责是复用和背压。数据库并发应由容量决定，不应等于 Web 请求并发。

**思考题**：应用从 5 个实例扩到 20 个实例，单实例连接池不变，数据库会看到什么变化？

## 第 28 章：怎样用系统视图定位慢、堵和抖？

排障应先判断问题属于哪一类：正在执行很慢、正在等待锁、没有 CPU 时间、I/O 延迟高，还是执行计划在某些参数下退化。不同问题需要不同证据。

### 先看现场

```sql
SELECT pid,
       usename,
       application_name,
       client_addr,
       state,
       wait_event_type,
       wait_event,
       now() - query_start AS query_age,
       now() - xact_start AS xact_age,
       left(query, 160) AS query
FROM pg_stat_activity
WHERE pid <> pg_backend_pid()
ORDER BY query_start NULLS LAST;
```

`active` 不等于正在使用 CPU；它可能在等待锁、I/O 或客户端。`wait_event_type` 与 `wait_event` 是区分现场状态的入口。

### 再画阻塞链

```sql
SELECT pid,
       pg_blocking_pids(pid) AS blocking_pids,
       wait_event_type,
       wait_event,
       left(query, 120) AS query
FROM pg_stat_activity
WHERE cardinality(pg_blocking_pids(pid)) > 0;
```

应找到链条最上游的 blocker，而不是只处理最慢的受害者。终止事务前确认它是否包含不可重试操作，以及客户端是否会自动重放流量。

### 用累计统计找高贡献 SQL

`pg_stat_statements` 按规范化语句累计调用次数、总执行时间、行数和 I/O 等信息。平均很慢但只执行一次的语句，与每次 5 毫秒却每秒执行一万次的语句，治理优先级不同。

```sql
SELECT calls,
       total_exec_time,
       mean_exec_time,
       rows,
       left(query, 140) AS query
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 20;
```

统计自某个重置点累计，必须记录时间窗口。扩展需要预加载配置和安装，不能等事故发生后才临时添加。

### 关联系统指标

数据库视图要与 CPU、磁盘延迟/吞吐/队列、网络、文件系统容量和内存压力对齐时间线。命中率很高也可能因为工作集小但 CPU 算法昂贵；I/O 很高也可能是正常的大批量任务。

### 保留证据再干预

重启、终止会话和重置统计会丢失现场。先保存活动会话、阻塞链、关键计划、日志时间段和系统指标，再采取止损动作。

**本章结论**：`pg_stat_activity` 看现场，阻塞函数看依赖链，`pg_stat_statements` 看长期贡献，操作系统指标解释资源瓶颈。四类证据要在同一时间线上对齐。

**思考题**：CPU 已满，但活动会话大多显示等待锁，为什么仅增加 CPU 不会解决问题？

## 第 29 章：表和索引膨胀应该怎样治理？

膨胀是已分配空间与当前有效数据需求之间的差距。它可能来自更新删除产生的旧版本、页面空洞、索引分裂、长事务阻碍回收或 autovacuum 速度不足。

### 先区分“可复用”与“必须归还给操作系统”

普通 VACUUM 让空间可被同一表复用，通常不会收缩文件。若表持续有相近写入量，这往往已经足够。只有确实需要回收磁盘，或物理布局严重影响性能时，才考虑表重写。

### 先修复原因，再重写结果

排查顺序可以是：

1. 是否存在长事务、旧复制槽或 standby feedback 保留旧版本；
2. autovacuum 是否触发过晚、运行太慢或被取消；
3. 是否有高频更新且缺少 HOT 条件；
4. 表和索引的增长是否符合业务数据增长；
5. 查询性能是否真的受膨胀影响。

`n_dead_tup` 是估算值，不应单独作为重写依据。结合关系大小、VACUUM 记录、扩展统计工具和抽样检查判断。

### 选择影响面合适的动作

- `VACUUM`：日常回收可复用空间；
- `REINDEX CONCURRENTLY`：在较低写阻塞下重建索引，仍消耗 I/O、CPU、WAL 和额外磁盘；
- `VACUUM FULL`：重写表并回收文件空间，需要强锁；
- `CLUSTER`：按索引重写物理顺序，需要强锁，后续不会自动维持；
- 在线重写工具：减少停机，但引入触发器、额外负载和切换风险。

任何重写都应先确认峰值额外磁盘、WAL 量、归档与复制承载能力，以及失败后的清理方式。

### 用 fillfactor 改变未来写入模式

高频更新表可以预留页内空间，提高 HOT 概率。代价是表初始更大、顺序扫描读取更多页面。调整后要通过后续写入或重写才能充分体现。

**本章结论**：膨胀治理的目标是恢复可预测的空间和访问成本，不是追求文件大小等于有效数据大小。重写前必须先解除版本回收阻碍。

**思考题**：一张每天都会重新写满的队列表，普通 VACUUM 后文件没有缩小，为什么未必需要 `VACUUM FULL`？

## 第 30 章：角色、权限和行级安全怎样落地？

权限设计的目标不是让应用“连得上”，而是把误操作和凭据泄露的影响范围限制在业务所需边界内。

### 分离登录、权限组和对象所有者

推荐至少拆成：不可登录的对象所有者、不可登录的读写权限组、应用登录角色和迁移角色。应用账号不应拥有表，否则对象所有权会绕过一部分普通授权治理。

```sql
CREATE ROLE app_owner NOLOGIN;
CREATE ROLE app_rw NOLOGIN;
CREATE ROLE app_login LOGIN;
GRANT app_rw TO app_login;
```

对象 owner 与数据库 superuser 都是强权限身份，应进入独立凭据和审计流程。

### 默认权限必须由正确的创建者设置

`ALTER DEFAULT PRIVILEGES` 只影响指定创建角色未来创建的对象。迁移工具如果换了创建身份，原默认授权不会自动套用。上线后应自动检查新表、新序列和新函数的权限。

序列也有独立权限。应用拥有表的 `INSERT`，不一定就能调用列默认值背后的序列。

### `pg_hba.conf` 负责连接入口，不替代对象权限

HBA 规则按顺序匹配数据库、用户、来源地址和认证方式。允许连接只是第一层；连接成功后仍由 role 和对象权限裁决。规则应从具体到宽泛，禁止用一个全能应用账号覆盖所有服务。

### RLS 把租户条件变成数据库策略

```sql
ALTER TABLE invoice ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON invoice
USING (tenant_id = current_setting('app.tenant_id')::bigint)
WITH CHECK (tenant_id = current_setting('app.tenant_id')::bigint);
```

RLS 可以防止应用漏写租户条件，但必须控制会话变量来源，测试连接池复用，并理解表 owner、superuser 和 `BYPASSRLS` 角色的例外。需要 owner 也受策略限制时，可评估 `FORCE ROW LEVEL SECURITY`。

RLS 还会影响查询计划。策略表达式应稳定、可索引，并在真实租户分布下测试。

**本章结论**：连接认证、角色继承、对象权限、所有权和 RLS 是连续的权限链。最小权限不是少写几条 GRANT，而是让每个身份只拥有完成职责所需能力。

**思考题**：为什么应用账号即使没有显式 `SELECT` 授权，只要它拥有表，仍可能突破预期权限边界？

## 第 31 章：高可用系统应该防什么，而不只是搭什么？

一主一备并不自动等于高可用。真正的系统还要回答：谁判断主库失效，谁有权提升备库，如何阻止旧主继续写，客户端如何找到新主，切换后数据承诺是什么。

### 复制首先定义数据承诺

异步复制下，主库提交不等待备库，性能与可用性较好，但故障切换可能丢失尚未到达备库的事务。同步复制可以把承诺推进到远端写入、刷盘或重放阶段，却把网络和备库健康引入提交路径。

业务应明确哪些事务允许 RPO > 0。不能一边使用异步复制，一边承诺任何故障都零数据丢失。

### 防止 split-brain 比快速提升更重要

网络分区时，旧主可能仍然存活。若新主被提升而旧主继续接受写入，两边会形成无法自动合并的时间线。故障转移必须配套 fencing：通过电源、虚拟化、存储、网络或一致性控制面确保旧主失去写资格。

### 复制槽是保护，也是负债

复制槽防止主库过早删除消费者尚未需要的 WAL 或行版本。消费者停止后，槽仍会保留资源，可能占满磁盘。所有槽都要有 owner、消费端、监控、容量上限和废弃流程。

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

物理槽和逻辑槽暴露的有效字段不同。判断逻辑槽时还要结合 `confirmed_flush_lsn` 与 `catalog_xmin`，编写监控时应处理空值。

### 切换只是恢复流程的一部分

完整演练至少包括：故障检测、仲裁、旧主隔离、备库提升、流量切换、连接重建、作业恢复、数据一致性检查、旧主重新加入和事后证据保存。

复制不是备份。误删、逻辑错误和恶意操作会被快速复制到备库；仍需要独立、可验证的备份与 PITR。

**本章结论**：高可用是故障模型和数据承诺，不是拓扑截图。没有 fencing、客户端切换和演练的一主一备，只是复制环境。

**思考题**：为什么把同步备库放在高延迟异地机房，可能让一次网络抖动直接变成主库写入延迟？
