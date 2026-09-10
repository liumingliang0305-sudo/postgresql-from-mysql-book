# 第四部分：索引与执行计划

## 第 15 章：除了 B-tree，PostgreSQL 为什么需要这么多索引？

索引不是“让查询更快”的统一开关，而是某类操作符与某种数据结构之间的匹配。PostgreSQL 把可索引操作定义在操作符类中，因此选择索引时，必须先看查询使用什么操作。

### B-tree：默认选择，但不是唯一选择

B-tree 适合等值、范围、排序和前缀有序访问。主键与普通 `CREATE INDEX` 默认都使用 B-tree。

```sql
CREATE INDEX idx_orders_created_at
ON orders (created_at DESC);
```

它适合 `=`、`<`、`<=`、`>`、`>=`、`BETWEEN` 以及可利用顺序的 `ORDER BY`。对低选择性布尔列单独建 B-tree，往往得不到收益。

### Hash：专注等值

Hash 索引只服务等值比较。它的适用面比 B-tree 窄，不能支持范围和排序。除非测量证明它更合适，否则 B-tree 通常更通用。

### GIN：一个值里包含很多可检索元素

GIN 是倒排索引，适合数组成员、全文检索词项以及 JSONB 键值包含关系。

```sql
CREATE INDEX idx_article_tags ON article USING gin (tags);
SELECT * FROM article WHERE tags @> ARRAY['postgresql'];

CREATE INDEX idx_event_payload ON event USING gin (payload jsonb_path_ops);
SELECT * FROM event WHERE payload @> '{"kind":"payment"}';
```

GIN 查询能力强，但写入和维护成本更高。JSONB 的默认操作符类与 `jsonb_path_ops` 支持的操作不同，不能只比较索引大小而忽略实际谓词。

### GiST 与 SP-GiST：处理“相交、邻近和空间划分”

GiST 是通用搜索树框架，常用于范围、几何、地理和近邻搜索；SP-GiST 适合可以自然划分的非平衡数据结构。它们的能力取决于类型和操作符类。

```sql
CREATE INDEX idx_booking_period ON booking USING gist (room_id, period);
```

配合排斥约束，可以直接保证同一房间的时间范围不重叠。若组合标量列与范围列，通常需要相应扩展提供操作符类。

### BRIN：用很小的索引跳过大片物理区域

BRIN 记录一组数据块的摘要，适合超大表且列值与物理顺序高度相关的场景，例如按时间持续追加的日志表。

```sql
CREATE INDEX idx_event_created_brin
ON event USING brin (created_at);
```

BRIN 很小、维护成本低，却不是精确定位每一行。数据物理相关性差时，它只能排除很少的数据块。

| 查询特征 | 优先评估 |
|---|---|
| 等值、范围、排序 | B-tree |
| 仅等值且有明确收益 | Hash |
| 数组、JSONB、全文包含 | GIN |
| 范围相交、几何、近邻 | GiST / SP-GiST |
| 超大、近似物理有序表 | BRIN |

**本章结论**：先从谓词操作符和数据分布出发，再选访问方法。索引类型选错，既可能用不上，也可能把写入成本留给每一条业务请求。

**思考题**：一个按时间追加、保存三年数据的日志表，时间范围查询为什么值得先评估 BRIN，而不是直接创建巨大 B-tree？

## 第 16 章：联合、部分、表达式和覆盖索引怎样选择？

真实查询通常同时包含过滤、排序和返回列。把所有列堆进一个索引并不能自动得到最优计划，反而会放大写入和缓存成本。

### 联合索引先服务稳定的过滤与顺序

```sql
SELECT id, total_amount
FROM orders
WHERE tenant_id = $1
  AND status = 'paid'
ORDER BY created_at DESC
LIMIT 50;
```

可以从下面的索引开始验证：

```sql
CREATE INDEX idx_orders_tenant_status_created
ON orders (tenant_id, status, created_at DESC)
INCLUDE (id, total_amount);
```

对多列 B-tree，前导列上的等值条件通常最能缩小扫描范围，随后列可继续参与范围和排序。新版本优化器在部分场景能使用 skip scan，但不能把它当作忽略列顺序的理由。

### `INCLUDE` 只负责携带，不负责搜索

包含列存于索引叶子项，可帮助 index-only scan，但不属于索引搜索键，也不能参与唯一性定义。宽列会显著增大索引，降低缓存密度。只有高频查询确实需要且 heap fetch 成本明显时，覆盖才有价值。

### 部分索引只覆盖业务真正关心的子集

若绝大多数订单已经归档，而查询只看未完成订单：

```sql
CREATE INDEX idx_orders_open_created
ON orders (tenant_id, created_at DESC)
WHERE status IN ('new', 'paying');
```

部分索引更小，写入成本也更低。但查询谓词必须让优化器能够证明蕴含索引条件。参数化条件过于抽象时，通用计划未必能证明这一点。

### 表达式索引要与查询表达式匹配

```sql
CREATE UNIQUE INDEX uq_account_email_ci
ON account (lower(email));

SELECT id FROM account WHERE lower(email) = lower($1);
```

表达式索引可以实现大小写无关唯一性或加速计算条件，但会把计算成本转移到写入。应用必须统一查询表达式，否则看似相同的变换也可能无法匹配。

### 索引越多，更新越贵

每个相关索引都需要 WAL、页面修改和后续清理；任何索引列被更新，通常都会失去 HOT 更新机会。评审索引时要同时回答：服务哪些具体查询、读收益多大、增加多少写成本、是否与现有索引重复。

**本章结论**：搜索键负责定位与排序，包含列负责覆盖，部分谓词负责缩小索引集合，表达式负责对齐查询语义。不要混用它们的职责。

**思考题**：某表已有 `(tenant_id, created_at)`，是否还需要 `(tenant_id)`，应查看哪些查询与统计信息？

## 第 17 章：优化器为什么会选错行数和路径？

优化器先估算每个节点会产生多少行，再据此比较扫描、连接和排序成本。第一处严重的行数误差，常会在计划树上逐层放大。

### 统计信息描述的是分布，不是完整数据

`ANALYZE` 通过采样记录空值比例、不同值数量、常见值、直方图和物理相关性。数据变化很快、分布高度倾斜或采样不足时，估算会偏离现实。

```sql
ANALYZE orders;

SELECT attname, null_frac, n_distinct, most_common_vals
FROM pg_stats
WHERE schemaname = 'public'
  AND tablename = 'orders';
```

对于重要且分布复杂的列，可提高统计目标：

```sql
ALTER TABLE orders
ALTER COLUMN customer_id SET STATISTICS 500;
ANALYZE orders;
```

提高目标会增加采样、规划时间和统计空间，不应对全库盲目调大。

### 列之间有关联，单列统计却默认独立

如果 `country` 与 `city` 强相关，分别估算后相乘会严重低估组合条件。扩展统计可以描述依赖、不同值组合和多列常见值：

```sql
CREATE STATISTICS st_customer_geo
(dependencies, ndistinct, mcv)
ON country, city
FROM customer;

ANALYZE customer;
```

扩展统计帮助估算多个条件的组合选择率，但不会自动创建索引，也不能替代合理的数据模型。

### 预编译语句可能在通用计划和定制计划之间取舍

同一 SQL 对不同参数的最佳计划可能不同：热门租户适合顺序扫描，小租户适合索引扫描。服务端准备语句为了降低反复规划成本，可能选择 generic plan；它无法针对每个参数值优化。

发现“直接执行快、参数化后慢”时，应比较实际参数下的计划、数据倾斜和计划缓存行为，而不是直接关闭预编译。

### 成本参数描述运行环境

`random_page_cost`、`seq_page_cost`、CPU 成本和有效缓存估计会影响路径选择。它们不是让某个索引“生效”的临时提示。只有基于存储性能与全局工作负载校准，才有意义。

**本章结论**：优化器通常不是无缘无故选错，而是在错误或不足的信息上做了合理选择。先修正统计模型，再考虑成本参数和 SQL 改写。

**思考题**：一条查询估算 10 行、实际 100 万行，为什么应先找计划树中最早出现误差的节点？

## 第 18 章：EXPLAIN ANALYZE 到底应该看什么？

阅读执行计划最常见的误区，是只看最上面的总时间，或者看到 `Seq Scan` 就判定有问题。正确方法是从实际数据流追踪成本在哪里产生。

建议使用：

```sql
EXPLAIN (ANALYZE, BUFFERS, WAL, SETTINGS, VERBOSE)
SELECT ...;
```

### 第一步：比较 estimated rows 与 actual rows

```text
Index Scan ... (cost=... rows=20 ...)
                  (actual time=... rows=200000 loops=1)
```

数量级误差会让连接算法、连接顺序和内存预算一起失真。关注每个节点的 `rows × loops`，因为内层节点可能被执行成千上万次。

### 第二步：找丢掉大量行的地方

`Rows Removed by Filter` 很高，说明访问路径读了很多候选行再过滤。可能缺少合适索引，也可能条件本身选择性差。位图堆扫描出现大量 `Rows Removed by Index Recheck`，要区分普通重检与 lossy bitmap 带来的额外过滤。

### 第三步：看 buffer，而不是把“快”都归因于索引

`shared hit` 表示从共享缓冲区命中，`shared read` 表示需要读取页面；还要结合存储和操作系统缓存理解实际 I/O。两次测试的缓存冷热不同，执行时间不能直接比较。

若排序或哈希节点出现临时文件读写，说明工作集超过相应内存预算并发生 spill。此时要看行宽、估算误差、并发和 `work_mem`，不能只在会话外全局调大参数。

### 第四步：分清启动时间和总时间

`LIMIT` 场景重视快速产出前几行；聚合和全量排序必须先消耗输入。Nested Loop、Hash Join、Merge Join 的启动特征不同，不能只比较节点名称。

### `ANALYZE` 会真的执行

对 `UPDATE`、`DELETE`、`INSERT` 使用 `EXPLAIN ANALYZE` 会真的修改数据。可以在事务中测试后回滚：

```sql
BEGIN;
EXPLAIN (ANALYZE, BUFFERS, WAL)
UPDATE orders SET status = 'expired' WHERE ...;
ROLLBACK;
```

但序列取值不会回退，触发器可能包含外部副作用，锁与资源消耗也真实发生。生产环境应优先在可控副本或回放环境验证。

**本章结论**：先找第一处行数估算偏差，再看循环次数、过滤损耗、缓存/I/O 和临时文件。扫描类型只是结果，不是结论。

**思考题**：一个执行 0.05 毫秒的内层索引扫描循环 20 万次，为什么可能是整条查询的主要瓶颈？

## 第 19 章：排序、哈希和连接为什么会突然变慢？

查询在小数据量时很快，数据增长后突然掉速，常见原因不是线性变慢，而是执行策略跨过了内存或算法边界。

### 三种连接算法解决不同问题

- Nested Loop：外表结果较少，内表可高效查找时表现好；外表估算严重偏小时风险最大。
- Hash Join：等值连接常用，先为一侧构建哈希表；内存不足会分批并写临时文件。
- Merge Join：两侧已有顺序或排序成本可接受时适用，也能处理部分非等值条件。

优化器会结合行数、行宽、排序状态和成本参数选择算法。把某种连接全局禁用只适合诊断，不是长期修复。

### `work_mem` 不是每个连接的总预算

`work_mem` 通常按排序或哈希操作节点分配，并行 worker 也可能各自分配。一条复杂查询可以有多个节点，几十个并发查询会把风险相乘。

```text
潜在内存 ≈ 并发查询数 × 每查询活跃操作节点 × worker 数 × work_mem
```

这个公式只用于认识风险，不是精确上界。哈希操作还受相关倍数参数影响。

对少数批处理可在事务内局部提高：

```sql
BEGIN;
SET LOCAL work_mem = '256MB';
-- 已验证的报表查询
COMMIT;
```

不要为了一个报表把全局 `work_mem` 从几 MB 调到几百 MB。

### 排序能否省掉，取决于访问路径

与 `ORDER BY` 匹配的 B-tree 可能直接按顺序产出数据，尤其适合 `LIMIT`。但如果过滤后仍需读取大量离散 heap 页面，顺序扫描后统一排序可能更便宜。

增量排序可以利用输入的已有前缀顺序，只对组内剩余键排序。是否收益仍取决于分组大小估算。

### 临时文件是重要信号

日志可记录超过阈值的临时文件。发现 spill 后先回答：真实行数是否远超估算；行是否过宽；是否能提前过滤；是否能用索引提供顺序；还是只需为该任务局部增加内存。

**本章结论**：性能断崖通常来自行数估算错误、内存溢出到磁盘或连接算法被迫处理远超预期的数据。调大内存只是最后一个选项之一。

**思考题**：为什么同样的 `work_mem`，一条包含三个排序节点的并行查询比单个排序更危险？

## 第 20 章：分页、计数和批量写入怎样避免隐性成本？

很多慢 SQL 并不复杂，只是把数据量增长隐藏在看似固定的接口里。

### 深分页不会因为只返回 20 行就便宜

```sql
SELECT id, created_at
FROM event
ORDER BY created_at DESC, id DESC
OFFSET 1000000 LIMIT 20;
```

执行器仍需找到并丢弃前一百万行。更稳定的方法是 keyset pagination，使用上一页最后一个排序键继续：

```sql
SELECT id, created_at
FROM event
WHERE (created_at, id) < ($1, $2)
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

需要与之匹配的联合索引。排序键必须稳定且能唯一确定位置，常用时间加主键。

### 精确 `count(*)` 必须确认每一行的可见性

PostgreSQL 不在表元数据里保存一个对所有快照都准确的行数，因此无过滤精确计数通常要扫描表或覆盖索引。大表首页若每次都展示精确总数，成本会随规模上升。

可以根据业务选择：异步汇总、近似统计、限制计数范围、只返回“是否还有下一页”，或者把精确计数做成显式高成本操作。

### 批量导入优先使用 COPY

大量数据导入时，逐行网络往返和逐语句规划会浪费时间。优先评估 `COPY`；次选多值 `INSERT` 或批量绑定。

```sql
COPY staging_order (id, customer_id, amount, created_at)
FROM STDIN WITH (FORMAT csv, HEADER true);
```

导入流程通常先进入 staging 表，完成格式、重复键和业务规则校验，再合并到目标表。是否暂缓创建索引和外键，要根据数据量、停机窗口和失败恢复方案决定。

### 大事务把多个风险绑在一起

一次提交数百万行会带来长时间锁持有、WAL 峰值、复制延迟、回滚成本和旧版本保留。分批能降低单次影响，但必须有稳定游标、幂等键和断点续传设计，不能用不断增大的 OFFSET 做批处理。

**本章结论**：接口返回量小不等于数据库处理量小。分页要避免丢弃大量行，计数要明确精度成本，批量任务要控制往返和事务尺寸。

**思考题**：keyset pagination 为什么更快，但不适合直接跳到任意第 N 页？

