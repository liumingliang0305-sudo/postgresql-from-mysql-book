# 从 MySQL 到 PostgreSQL：机制、实践与调优

> 面向已有 MySQL 基础、希望系统掌握 PostgreSQL 并理解核心原理的开发者。

本书以 PostgreSQL 18 为基线。重点不是罗列语法，而是回答三个问题：同一类需求在 PostgreSQL 中应当怎样实现；它为什么这样工作；出现性能或稳定性问题时，应当观察什么。

## 阅读路线

- 只想完成迁移：先读第一部分和第七部分，再按问题回查其他章节。
- 负责业务开发：依次阅读第一、二、四、五部分。
- 负责性能与稳定性：重点阅读第二、三、四、六部分。
- 已熟悉 PostgreSQL：从执行计划、膨胀治理和高可用章节开始。

## 目录

### 开始之前

- [前言：不要把 PostgreSQL 当成换了语法的 MySQL](chapters/00-preface.md)

### 第一部分：先换一套坐标系

- [第 1 章：一条 SQL 在 PostgreSQL 中是怎样执行的？](chapters/01-mindset-and-basics.md#第-1-章一条-sql-在-postgresql-中是怎样执行的)
- [第 2 章：实例、数据库、模式和用户到底是什么关系？](chapters/01-mindset-and-basics.md#第-2-章实例数据库模式和用户到底是什么关系)
- [第 3 章：从 MySQL 迁移时，哪些类型和 SQL 最容易埋雷？](chapters/01-mindset-and-basics.md#第-3-章从-mysql-迁移时哪些类型和-sql-最容易埋雷)
- [第 4 章：自增、UPSERT 和返回值，为什么值得重新设计？](chapters/01-mindset-and-basics.md#第-4-章自增upsert-和返回值为什么值得重新设计)

### 第二部分：事务与并发控制

- [第 5 章：同样叫 Read Committed，看到的数据为什么不同？](chapters/02-transactions-and-concurrency.md#第-5-章同样叫-read-committed看到的数据为什么不同)
- [第 6 章：PostgreSQL 的 MVCC 为什么会留下旧版本？](chapters/02-transactions-and-concurrency.md#第-6-章postgresql-的-mvcc-为什么会留下旧版本)
- [第 7 章：VACUUM 在清理什么，为什么不能停？](chapters/02-transactions-and-concurrency.md#第-7-章vacuum-在清理什么为什么不能停)
- [第 8 章：只改一张小表，为什么 DDL 也可能拖住业务？](chapters/02-transactions-and-concurrency.md#第-8-章只改一张小表为什么-ddl-也可能拖住业务)
- [第 9 章：可串行化隔离如何发现业务规则冲突？](chapters/02-transactions-and-concurrency.md#第-9-章可串行化隔离如何发现业务规则冲突)

### 第三部分：存储、日志与恢复

- [第 10 章：表不是按主键组织的，会带来什么变化？](chapters/03-storage-wal-and-recovery.md#第-10-章表不是按主键组织的会带来什么变化)
- [第 11 章：WAL 怎样保证提交过的数据不会丢？](chapters/03-storage-wal-and-recovery.md#第-11-章wal-怎样保证提交过的数据不会丢)
- [第 12 章：检查点为什么会制造 I/O 压力？](chapters/03-storage-wal-and-recovery.md#第-12-章检查点为什么会制造-io-压力)
- [第 13 章：备份、归档和 PITR 应该怎样组合？](chapters/03-storage-wal-and-recovery.md#第-13-章备份归档和-pitr-应该怎样组合)
- [第 14 章：复制延迟只看一个数字为什么不够？](chapters/03-storage-wal-and-recovery.md#第-14-章复制延迟只看一个数字为什么不够)

### 第四部分：索引与执行计划

- [第 15 章：除了 B-tree，PostgreSQL 为什么需要这么多索引？](chapters/04-indexes-and-planner.md#第-15-章除了-b-treepostgresql-为什么需要这么多索引)
- [第 16 章：联合、部分、表达式和覆盖索引怎样选择？](chapters/04-indexes-and-planner.md#第-16-章联合部分表达式和覆盖索引怎样选择)
- [第 17 章：优化器为什么会选错行数和路径？](chapters/04-indexes-and-planner.md#第-17-章优化器为什么会选错行数和路径)
- [第 18 章：EXPLAIN ANALYZE 到底应该看什么？](chapters/04-indexes-and-planner.md#第-18-章explain-analyze-到底应该看什么)
- [第 19 章：排序、哈希和连接为什么会突然变慢？](chapters/04-indexes-and-planner.md#第-19-章排序哈希和连接为什么会突然变慢)
- [第 20 章：分页、计数和批量写入怎样避免隐性成本？](chapters/04-indexes-and-planner.md#第-20-章分页计数和批量写入怎样避免隐性成本)

### 第五部分：把数据模型交给数据库

- [第 21 章：约束为什么不该只写在应用里？](chapters/05-modeling-and-sql.md#第-21-章约束为什么不该只写在应用里)
- [第 22 章：JSONB、数组和范围类型什么时候值得用？](chapters/05-modeling-and-sql.md#第-22-章jsonb数组和范围类型什么时候值得用)
- [第 23 章：窗口函数、CTE 和 LATERAL 能解决什么问题？](chapters/05-modeling-and-sql.md#第-23-章窗口函数cte-和-lateral-能解决什么问题)
- [第 24 章：函数、触发器和扩展的边界在哪里？](chapters/05-modeling-and-sql.md#第-24-章函数触发器和扩展的边界在哪里)
- [第 25 章：分区表能解决大表的所有问题吗？](chapters/05-modeling-and-sql.md#第-25-章分区表能解决大表的所有问题吗)

### 第六部分：把数据库运行好

- [第 26 章：内存参数为什么不能按总内存等比例放大？](chapters/06-operations.md#第-26-章内存参数为什么不能按总内存等比例放大)
- [第 27 章：连接数越大，吞吐量为什么可能越低？](chapters/06-operations.md#第-27-章连接数越大吞吐量为什么可能越低)
- [第 28 章：怎样用系统视图定位慢、堵和抖？](chapters/06-operations.md#第-28-章怎样用系统视图定位慢堵和抖)
- [第 29 章：表和索引膨胀应该怎样治理？](chapters/06-operations.md#第-29-章表和索引膨胀应该怎样治理)
- [第 30 章：角色、权限和行级安全怎样落地？](chapters/06-operations.md#第-30-章角色权限和行级安全怎样落地)
- [第 31 章：高可用系统应该防什么，而不只是搭什么？](chapters/06-operations.md#第-31-章高可用系统应该防什么而不只是搭什么)

### 第七部分：从 MySQL 平稳迁移

- [第 32 章：迁移前如何发现兼容性问题？](chapters/07-migration-and-appendix.md#第-32-章迁移前如何发现兼容性问题)
- [第 33 章：全量、增量和切换怎样设计？](chapters/07-migration-and-appendix.md#第-33-章全量增量和切换怎样设计)
- [第 34 章：上线后为什么还要重新做一次性能基线？](chapters/07-migration-and-appendix.md#第-34-章上线后为什么还要重新做一次性能基线)
- [附录 A：MySQL 与 PostgreSQL 常用概念对照](chapters/07-migration-and-appendix.md#附录-amysql-与-postgresql-常用概念对照)
- [附录 B：常用诊断 SQL](chapters/07-migration-and-appendix.md#附录-b常用诊断-sql)
- [附录 C：实验环境与练习](chapters/07-migration-and-appendix.md#附录-c实验环境与练习)
- [参考资料](chapters/07-migration-and-appendix.md#参考资料)

## 示例约定

书中示例默认在 `psql` 中执行，数据库名称为 `booklab`。SQL 关键字使用大写，数据库对象使用小写蛇形命名。涉及生产环境的命令会明确标注风险；没有明确验证恢复流程的备份，不视为有效备份。

