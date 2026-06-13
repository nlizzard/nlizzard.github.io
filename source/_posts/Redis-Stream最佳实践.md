---
title: Redis Stream 最佳实践：从消息队列选型到 Redisson 实战
tags:
  - Redis
  - Redis Stream
  - 消息队列
  - Java
  - Spring Boot
categories:
  - java
keywords:
  - Redis Stream最佳实践
  - Redis消息队列
  - Redisson
  - 消费者组
  - 异步任务
description: 从消息队列方案选型出发，介绍 Redis Stream 的适用场景、核心命令、Redisson 生产消费实现，以及幂等、ACK、Pending 恢复、重试、死信和监控等实践。
cover: ../img/redis/redis.png
copyright: true
abbrlink: fec20a3f
date: 2026-06-13 18:00:00
updated: 2026-06-13 20:40:00
top_img:
comments:
toc:
toc_number:
toc_style_simple:
copyright_author:
copyright_author_href:
copyright_url:
copyright_info:
mathjax:
katex:
aplayer:
highlight_shrink:
aside:
abcjs:
---

## 引言
当接口中出现图片压缩、报表生成、文档解析、大模型调用等耗时操作时，最直接的写法是在请求线程中同步执行。业务量较小时这样做没有问题，但任务一旦需要十几秒甚至更久，就容易遇到三个麻烦：

- 用户必须一直等待，页面体验差。
- 网关、浏览器或上游服务可能提前超时。
- 瞬时流量会直接压到数据库和下游接口上。

消息队列的价值，就是在请求和执行之间增加一个缓冲层。接口只负责接收请求并创建任务，消费者在后台按照系统能够承受的速度处理。

不过，“需要异步”并不等于“必须上 Kafka”。不同方案解决的问题并不相同。本文先完成消息队列选型，再介绍 Redis Stream 的基础用法，最后讨论如何把它做成一套可长期运行的异步任务系统。

文中的 Java 示例使用 Spring Boot 和 Redisson，业务场景统一为“上传图片后异步生成缩略图”。

## 1. 常见消息队列方案

选择方案时，至少要考虑：

- 消息是否允许丢失
- 是否需要多个消费者分摊任务
- 是否需要广播
- 是否需要重试、死信和延迟消息
- 是否需要保留历史消息并重新消费
- 峰值吞吐量和数据保留时间
- 团队是否愿意维护新的基础设施

### 1.1 应用内异步线程

最简单的方案是 `@Async`、`CompletableFuture` 或本地线程池：

```java
// 方式一：提交到线程池后立即返回，适合不关心返回值的任务。
taskExecutor.execute(() -> imageService.compress(taskId));

// 方式二：使用 CompletableFuture 串联成功回调和异常处理。
CompletableFuture
    .runAsync(
        () -> imageService.compress(taskId),
        taskExecutor
    )
    .thenRun(() -> {
        // 压缩完成后发送结果通知。
        System.out.println(
            "taskId: " + taskId + " 压缩完成"
        );
    })
    .exceptionally(exception -> {
        // 统一记录异步任务中的异常。
        System.err.println(
            "压缩失败: " + exception.getMessage()
        );
        return null;
    });

```

它的优势是实现简单、延迟低，没有额外中间件。

局限也很明显：

- 应用重启后，内存中的任务会丢失。
- 多实例之间无法自然分配任务。
- 缺少统一的确认、重试、堆积和监控机制。

适合“执行失败可以接受”或“业务本身有其他补偿来源”的轻量后台操作，例如刷新本地缓存、发送非关键通知。

### 1.2 数据库任务表

另一种常见做法是把任务写入数据库，由定时任务扫描：

```sql
-- 跳过已经被其他事务锁定的任务，避免多个实例重复领取。
SELECT *
FROM image_task
WHERE status = 'PENDING'
ORDER BY created_at
LIMIT 100
FOR UPDATE SKIP LOCKED;
```

数据库任务表的优点是业务记录与任务状态容易放进同一个事务，排查和补偿也很直观。

它更适合：

- 任务量不大
- 延迟要求不高
- 业务一致性比吞吐量更重要
- 团队暂时不希望增加中间件

缺点是持续轮询会增加数据库压力，高并发入队、抢占、状态更新和清理也会产生额外的索引、事务日志和表膨胀问题。

### 1.3 Redis List

Redis List 可以用 `LPUSH` 和 `BRPOP` 快速实现一个阻塞队列：

```bash
# 生产者从列表左侧写入任务。
LPUSH image:compress:list task-1001

# 消费者从右侧阻塞读取；0 表示一直等待。
BRPOP image:compress:list 0
```

它适合结构简单、只要求先进先出的任务。

但 List 没有原生消费者组和消息历史。消费者弹出消息后如果宕机，需要使用 `BLMOVE`、备用列表等方式自行设计可靠消费，重试和待确认管理也要在业务层补齐。

### 1.4 Redis Pub/Sub

Redis 发布订阅适合实时广播：

```bash
# 将消息广播给当前在线的所有订阅者。
PUBLISH order-status "order-1001-paid"
```

所有在线订阅者都可以收到消息，但离线订阅者无法补收历史消息，也没有 ACK 和 Pending 机制。

因此 Pub/Sub 更适合：

- 在线状态通知
- 配置刷新
- WebSocket 节点间广播
- 允许偶尔丢失的实时事件

它不适合作为可靠异步任务队列。

### 1.5 Redis Stream

Redis Stream 是 Redis 5.0 引入的追加式数据结构。它同时提供：

- 有序消息 ID
- 消息持久保存
- 按范围查询历史消息
- 消费者组
- 手动 ACK
- Pending Entries List
- 超时消息接管
- Stream 长度裁剪

相比 Redis List，Stream 已经具备可靠消费所需的主要结构；相比 RabbitMQ、RocketMQ、Kafka，它又可以复用现有 Redis，部署成本更低。

### 1.6 RabbitMQ、RocketMQ 和 Kafka

当消息系统成为业务核心基础设施时，专业消息中间件通常更合适。

**RabbitMQ** 擅长传统工作队列和灵活路由，具备确认、TTL、死信交换机和多种 Exchange 模型，适合复杂路由与可靠任务分发。

**RocketMQ** 面向业务消息场景，提供顺序消息、延迟消息、事务消息等能力，在订单、支付和大型分布式业务中较常见。

**Kafka** 更接近可长期保留的分区事件日志，适合高吞吐事件流、日志采集、数据管道、流计算和需要反复回放的数据。

这些系统能力更完整，但也意味着独立的部署、容量规划、监控和升级成本。

### 1.7 综合对比

| 方案 | 持久化 | 消费者组 | ACK | 历史回放 | 主要优势 | 适用场景 |
| --- | --- | --- | --- | --- | --- | --- |
| 应用内线程池 | 否 | 否 | 否 | 否 | 实现最简单 | 非关键后台操作 |
| 数据库任务表 | 是 | 自行实现 | 业务状态 | 是 | 事务一致性直观 | 低到中等任务量 |
| Redis List | 是 | 否 | 自行实现 | 弱 | 简单的 FIFO 队列 | 简单任务队列 |
| Redis Pub/Sub | 否 | 广播订阅 | 否 | 否 | 实时广播 | 在线通知 |
| Redis Stream | 是 | 是 | 是 | 是 | 轻量且能力均衡 | 中小规模异步任务 |
| RabbitMQ | 是 | 是 | 是 | 有限 | 路由和队列能力成熟 | 可靠任务与复杂路由 |
| RocketMQ | 是 | 是 | 是 | 是 | 业务消息能力丰富 | 大型分布式业务 |
| Kafka | 是 | Consumer Group | Offset | 强 | 高吞吐与长期事件流 | 日志、数据管道、事件平台 |

没有一种方案在所有维度都最好。正确的选择，是用足够的能力解决当前问题，同时保留清晰的升级边界。

## 2. Redis Stream 适合什么场景

Redis Stream 比较适合下面这类系统：

- 项目已经稳定使用 Redis，不想再维护一套消息中间件。
- 任务规模处于中小量级，主要目标是削峰、异步和多实例消费。
- 需要手动确认和宕机恢复，但不需要复杂的消息路由。
- 消息只需保留一段时间，业务结果会落到数据库或对象存储。
- 团队能够接受“至少一次处理”，并愿意实现业务幂等。

常见业务包括：

- 图片压缩、文件解析、视频封面生成
- 大模型分析、文档向量化
- 异步报表和数据导出
- 邮件、短信、站内信发送
- 搜索索引刷新
- 低到中等规模的事件通知

### 2.1 不适合直接使用 Redis Stream 的情况

下面这些需求出现时，应优先评估专业消息系统：

- 每秒数十万甚至更高的持续吞吐
- 消息需要保存数周、数月并反复回放
- 大量 Topic、分区和消费者生态
- 复杂路由、事务消息或精细延迟级别
- 跨地域复制和独立的消息治理平台
- Redis 已经承担高负载缓存，无法再接受队列带来的内存与持久化压力

还要注意，Stream 的可靠性受 Redis 持久化、复制和故障转移配置影响。把消息写入 Redis，并不自动等于端到端绝不丢失。

## 3. Redis Stream 的核心概念

先用一张简单关系图建立整体认识：

```text
Stream
  |
  +-- 消息 1718265600000-0
  +-- 消息 1718265601000-0
  +-- 消息 1718265602000-0
  |
  +-- Consumer Group: image-compress-group
          |
          +-- Consumer: worker-01
          +-- Consumer: worker-02
          |
          +-- PEL: 已投递但尚未 ACK 的消息
```

### 3.1 Stream

Stream 是一组不断追加的消息，例如：

```text
image:compress:stream
```

一条消息由多个字段组成：

```text
taskId=1001
objectKey=uploads/photo.jpg
traceId=9c61...
schemaVersion=1
```

### 3.2 消息 ID

Redis 可以自动生成类似下面的消息 ID：

```text
1718265600123-0
```

消息 ID 有序，可以用于范围查询、定位和回放。业务幂等不能只依赖消息 ID，因为同一个任务重新入队后会获得新的 ID。

### 3.3 Consumer Group

消费者组让多个消费者共同处理同一个 Stream。

同一组内，一条新消息只会交给一个消费者；不同消费者组则可以各自读取同一条消息。

例如：

```text
image-compress-group
image-audit-group
```

压缩服务和审计服务可以建立两个组，分别消费同一个图片事件。

### 3.4 Consumer

Consumer 是消费者组内的一个实例：

```text
worker-server01-a31f8c
worker-server02-b72e4d
```

名称应当唯一，并尽量包含主机名、Pod 名称或实例 ID，方便定位 Pending 消息属于哪个实例。

### 3.5 PEL

消费者组读到消息后，Redis 会把它记录到 PEL（Pending Entries List）中。

只有执行 `XACK`，该消息才会从这个消费者组的 PEL 中移除。

需要特别区分：

- `XACK`：确认该消费者组已经处理完成。
- `XDEL`：删除 Stream 中的原始消息。
- `XTRIM`：按长度或 ID 范围批量裁剪历史消息。

ACK 不会删除 Stream 中的消息。

## 4. 先用 Redis 命令走通流程

理解底层命令后，再看 Java 客户端会清晰很多。

### 4.1 写入消息

```bash
# * 表示由 Redis 自动生成消息 ID。
XADD image:compress:stream * \
  taskId 1001 \
  objectKey uploads/photo.jpg \
  traceId trace-001 \
  schemaVersion 1
```

`*` 表示由 Redis 自动生成消息 ID。

生产环境通常在写入时限制长度：

```bash
# 写入消息，并把 Stream 近似裁剪到 100000 条左右。
XADD image:compress:stream MAXLEN ~ 100000 * \
  taskId 1001 \
  objectKey uploads/photo.jpg
```

`~` 表示近似裁剪，Redis 可以批量删除旧数据，通常比严格维持精确长度更高效。

### 4.2 查看消息

```bash
# - 表示最小 ID，+ 表示最大 ID，即查询全部消息。
XRANGE image:compress:stream - +
```

只查看最近 10 条：

```bash
# 从最新消息向前查询 10 条。
XREVRANGE image:compress:stream + - COUNT 10
```

### 4.3 创建消费者组

消费者组内部会记录一个“最后投递到哪里”的位置。第一次创建消费者组时，必须告诉 Redis 这个位置从哪里开始。

`0` 和 `$` 是最常用的两个起点：

- `0`：从 Stream 开头开始，组创建前已经存在的历史消息也会被消费。
- `$`：从当前 Stream 末尾开始，跳过已有消息，只消费组创建后新增的消息。

假设 Stream 中已经有三条消息：

```text
10-0  图片 A
20-0  图片 B
30-0  图片 C
```

使用 `0` 创建消费者组：

```bash
# 0 表示从头开始，A、B、C 都可以被这个组读取。
XGROUP CREATE \
  image:compress:stream \
  image-compress-group \
  0 \
  MKSTREAM
```

如果使用 `$` 创建另一个消费者组：

```bash
# $ 表示从当前末尾开始，已有的 A、B、C 会被跳过。
XGROUP CREATE \
  image:compress:stream \
  image-compress-new-group \
  $ \
  MKSTREAM
```

此后再写入一条 `40-0 图片 D`：

- `image-compress-group` 从 `0` 开始，可以依次读取 A、B、C、D。
- `image-compress-new-group` 从 `$` 开始，只能读取组创建后新增的 D。

`MKSTREAM` 表示：如果 Stream 不存在，就先创建一个空 Stream，再创建消费者组。没有 `MKSTREAM` 时，在一个不存在的 Stream 上建组会报错。

`0` 和 `$` 只在**第一次创建消费者组**时生效。组创建成功后，再次执行同名的 `XGROUP CREATE` 会返回 `BUSYGROUP`，不会改变已有组的位置。

确实需要修改已有组的位置时，要显式使用 `XGROUP SETID`：

```bash
# 将已有消费者组重置到 Stream 开头。
# 这可能导致历史消息重新投递，只能作为明确的运维操作执行。
XGROUP SETID \
  image:compress:stream \
  image-compress-group \
  0
```

可以用下面的表格快速判断：

| 创建起点 | 组创建前已有消息 | 组创建后新增消息 | 典型用途 |
| --- | --- | --- | --- |
| `0` | 会读取 | 会读取 | 任务队列首次上线，不能漏掉积压任务 |
| `$` | 跳过 | 会读取 | 新增审计或监控组，只关心未来事件 |

对于本文的图片压缩任务，通常应该选择 `0`。即使消费者暂时没有启动，已经写入 Stream 的图片任务也不能被跳过。

### 4.4 使用消费者组读取消息

```bash
# > 表示读取“尚未投递给当前消费者组”的新消息。
XREADGROUP \
  GROUP image-compress-group worker-01 \
  COUNT 10 \
  BLOCK 2000 \
  STREAMS image:compress:stream >
```

这里最容易混淆的是：

- `0` 和 `$` 用于**第一次创建消费者组**，决定组从哪里起步。
- `>` 用于**消费者日常读取**，表示获取尚未投递给该组的新消息。

消费者通常一直使用 `>` 读取新消息。已经投递但没有 ACK 的消息位于 PEL 中，不会再次被 `>` 读到，需要使用 `XPENDING`、`XAUTOCLAIM` 等命令恢复。

`BLOCK 2000` 表示最多阻塞等待 2 秒，避免客户端持续空轮询。

### 4.5 确认消息

业务处理完成后：

```bash
# 业务处理完成后，从该消费者组的 PEL 中移除消息。
XACK \
  image:compress:stream \
  image-compress-group \
  1718265600123-0
```

### 4.6 查看和接管 Pending 消息

查看 PEL 概况：

```bash
# 查看消费者组内尚未 ACK 的消息概况。
XPENDING image:compress:stream image-compress-group
```

接管空闲超过 5 分钟的 Pending 消息：

```bash
# 接管空闲超过 300000 毫秒的 Pending 消息。
XAUTOCLAIM \
  image:compress:stream \
  image-compress-group \
  recovery-worker-01 \
  300000 \
  0-0 \
  COUNT 100
```

这条命令是消费者宕机恢复的关键。只使用 `XREADGROUP ... >`，不会自动取回已经投递给其他消费者的旧 Pending 消息。

## 5. 使用 Redisson 接入 Redis Stream

下面的代码以 Redisson `4.0.0` API 为例。其他版本的类名和方法签名可能略有变化，应以项目实际依赖版本为准。

### 5.1 引入依赖

Gradle：

```groovy
dependencies {
    // Redisson 的 Spring Boot Starter，会自动创建 RedissonClient。
    implementation "org.redisson:redisson-spring-boot-starter:4.0.0"
}
```

Maven：

```xml
<dependency>
    <!-- Redisson 的 Spring Boot Starter -->
    <groupId>org.redisson</groupId>
    <artifactId>redisson-spring-boot-starter</artifactId>
    <version>4.0.0</version>
</dependency>
```

### 5.2 配置 Redis

```yaml
spring:
  redis:
    redisson:
      # 直接使用 Redisson 原生 YAML 配置。
      config: |
        singleServerConfig:
          # 单机 Redis 地址；生产环境可换成主从、Sentinel 或 Cluster。
          address: "redis://127.0.0.1:6379"
          # 使用第 0 个逻辑数据库。
          database: 0
```

Starter 会创建 `RedissonClient`，业务代码通过构造器注入即可。

### 5.3 定义 Stream 配置

```java
public final class ImageStreamConstants {

    private ImageStreamConstants() {
        // 工具类不允许实例化。
    }

    // 图片压缩任务使用的 Stream Key。
    public static final String STREAM_KEY =
        "image:compress:stream";

    // 多个图片压缩消费者共同所属的消费者组。
    public static final String GROUP_NAME =
        "image-compress-group";

    // 每次最多读取 10 条消息。
    public static final int BATCH_SIZE = 10;

    // Stream 近似保留 100000 条消息，避免无限增长。
    public static final int MAX_LEN = 100_000;

    // 没有新消息时最多阻塞等待 2 秒。
    public static final Duration BLOCK_TIMEOUT =
        Duration.ofSeconds(2);
}
```

配置较多时，建议使用 `@ConfigurationProperties`，让批次大小、阻塞时间和裁剪长度可以按环境调整。

## 6. 使用 Redisson 发送消息

生产者只负责构造一条轻量任务消息并写入 Stream：

```java
public record ImageTaskMessage(
    String taskId,
    String objectKey,
    String traceId,
    int attempt
) {

    public ImageTaskMessage nextAttempt() {
        // 重试时保持 taskId 不变，只增加尝试次数。
        return new ImageTaskMessage(
            taskId,
            objectKey,
            traceId,
            attempt + 1
        );
    }
}

@Service
@RequiredArgsConstructor
public class ImageCompressProducer {

    private final RedissonClient redissonClient;

    public String send(
        String taskId,
        String objectKey,
        String traceId
    ) {
        // 首次入队的尝试次数为 0。
        return send(
            new ImageTaskMessage(
                taskId,
                objectKey,
                traceId,
                0
            )
        );
    }

    public String send(ImageTaskMessage task) {
        // 使用 StringCodec，方便通过 redis-cli 查看消息字段。
        RStream<String, String> stream =
            redissonClient.getStream(
                ImageStreamConstants.STREAM_KEY,
                StringCodec.INSTANCE
            );

        // Stream 中只保存任务引用，不保存图片二进制内容。
        Map<String, String> message = Map.of(
            "taskId", task.taskId(),
            "objectKey", task.objectKey(),
            "traceId", task.traceId(),
            "attempt", String.valueOf(task.attempt()),
            "schemaVersion", "1"
        );

        // 写入消息时使用近似裁剪，限制 Stream 的长期大小。
        StreamAddArgs<String, String> args =
            StreamAddArgs.entries(message)
                .trimNonStrict()
                .maxLen(ImageStreamConstants.MAX_LEN);

        // Redis 自动生成消息 ID，并返回给调用方记录日志。
        StreamMessageId messageId = stream.add(args);
        return messageId.toString();
    }
}
```

这里使用 `StringCodec`，使 Stream 中的字段保持普通字符串，便于使用 Redis CLI 排查，也方便未来接入 Python、Go 等其他语言消费者。

### 6.1 为什么消息只传引用

不要把图片 Base64、完整文档或大段 JSON 直接放进 Stream。

更好的方式是：

- 文件存入对象存储
- 业务数据存入数据库
- Stream 只携带 `taskId` 和 `objectKey`

这样可以减少 Redis 内存、网络、AOF 和主从复制压力。

建议每条消息包含：

- `taskId`：稳定的业务幂等键
- `objectKey`：数据引用
- `traceId`：链路追踪
- `schemaVersion`：消息结构版本

## 7. 初始化消费者组

消费者启动前需要确保组已经存在：

```java
@Component
@RequiredArgsConstructor
@Slf4j
public class ImageStreamGroupInitializer {

    private final RedissonClient redissonClient;

    @PostConstruct
    public void initialize() {
        // 获取图片压缩任务对应的 Stream。
        RStream<String, String> stream =
            redissonClient.getStream(
                ImageStreamConstants.STREAM_KEY,
                StringCodec.INSTANCE
            );

        try {
            // Stream 不存在时先创建 Stream，再创建消费者组。
            stream.createGroup(
                StreamCreateGroupArgs
                    .name(ImageStreamConstants.GROUP_NAME)
                    .makeStream()
            );
        } catch (RedisException e) {
            // 多实例同时启动时，只有第一个实例会创建成功。
            // BUSYGROUP 表示组已经存在，可以安全忽略。
            if (e.getMessage() != null
                    && e.getMessage().contains("BUSYGROUP")) {
                return;
            }
            throw e;
        }
    }
}
```

只应忽略 `BUSYGROUP`，因为它明确表示消费者组已经存在。连接失败、认证失败和权限错误不能一起吞掉。

上面的 Java 代码解决的是“组不存在时创建、已存在时不重复创建”，这就是这里所说的**幂等初始化**：无论应用重启多少次，最终都只有一个同名消费者组。

但任务队列是否需要读取历史消息，是业务决策。为了让 `0` 或 `$` 一眼可见，生产环境可以在部署脚本中先执行：

```bash
# 图片任务不能遗漏历史消息，因此首次建组明确使用 0。
# 命令只需要在环境初始化时执行一次。
redis-cli XGROUP CREATE \
  image:compress:stream \
  image-compress-group \
  0 \
  MKSTREAM
```

应用启动时仍保留上面的 Java 初始化代码作为兜底：

- 部署脚本已经创建组：Java 收到 `BUSYGROUP`，直接继续启动。
- 新开发环境没有运行脚本：Java 自动创建组，避免消费者因组不存在而无法启动。

如果业务必须严格控制起点，部署脚本应当是唯一的首次建组入口；应用兜底代码需要记录明确告警，提醒开发者检查该客户端版本创建组时采用的默认起点。不要在每次应用启动时执行 `XGROUP SETID`，否则会反复移动消费位置，造成漏消费或重复消费。

## 8. 使用 Redisson 消费和确认消息

消费者使用阻塞读取获取新消息：

```java
@Component
@DependsOn("imageStreamGroupInitializer")
@RequiredArgsConstructor
@Slf4j
public class ImageCompressConsumer {

    private final RedissonClient redissonClient;
    private final ImageTaskService taskService;
    private final ImageCompressService compressService;

    private final AtomicBoolean running =
        new AtomicBoolean(false);

    private ExecutorService consumerExecutor;
    private String consumerName;

    @PostConstruct
    public void start() {
        // 每个应用实例都生成唯一 Consumer 名称。
        consumerName = "image-worker-"
            + UUID.randomUUID().toString().substring(0, 8);

        // 单独使用一个后台线程执行阻塞读取循环。
        consumerExecutor =
            Executors.newSingleThreadExecutor(runnable -> {
                Thread thread = new Thread(
                    runnable,
                    "image-stream-consumer"
                );
                thread.setDaemon(true);
                return thread;
            });

        // 设置运行标记后启动消费线程。
        running.set(true);
        consumerExecutor.submit(this::consumeLoop);
    }

    @PreDestroy
    public void stop() {
        // 先停止继续拉取，再关闭消费线程。
        running.set(false);
        consumerExecutor.shutdown();
    }

    private void consumeLoop() {
        // 消费线程复用同一个 RStream 实例。
        RStream<String, String> stream =
            redissonClient.getStream(
                ImageStreamConstants.STREAM_KEY,
                StringCodec.INSTANCE
            );

        while (running.get()) {
            try {
                // neverDelivered 对应 XREADGROUP 中的 >，
                // 只读取尚未投递给当前消费者组的新消息。
                Map<StreamMessageId, Map<String, String>>
                    messages = stream.readGroup(
                        ImageStreamConstants.GROUP_NAME,
                        consumerName,
                        StreamReadGroupArgs
                            .neverDelivered()
                            .count(ImageStreamConstants.BATCH_SIZE)
                            .timeout(
                                ImageStreamConstants.BLOCK_TIMEOUT
                            )
                    );

                if (messages == null || messages.isEmpty()) {
                    // 阻塞超时且没有消息，继续下一轮读取。
                    continue;
                }

                // 逐条处理本批消息；是否并行由业务线程池决定。
                for (var entry : messages.entrySet()) {
                    processMessage(
                        stream,
                        entry.getKey(),
                        entry.getValue()
                    );
                }
            } catch (Exception e) {
                if (Thread.currentThread().isInterrupted()) {
                    return;
                }
                log.error("读取图片压缩任务失败", e);
            }
        }
    }

    private void processMessage(
        RStream<String, String> stream,
        StreamMessageId messageId,
        Map<String, String> data
    ) {
        String taskId = data.get("taskId");
        String objectKey = data.get("objectKey");

        // 无法解析的消息不具备重试价值，应记录后确认。
        if (taskId == null || objectKey == null) {
            log.warn(
                "消息字段缺失: messageId={}, data={}",
                messageId,
                data
            );
            stream.ack(
                ImageStreamConstants.GROUP_NAME,
                messageId
            );
            return;
        }

        // 消息可能重复投递，完成过的任务直接 ACK。
        if (taskService.isCompleted(taskId)) {
            stream.ack(
                ImageStreamConstants.GROUP_NAME,
                messageId
            );
            return;
        }

        try {
            // 先记录 PROCESSING，方便前端和运维查看任务进度。
            taskService.markProcessing(taskId);

            // 执行真正耗时的图片压缩逻辑。
            String targetKey =
                compressService.compress(taskId, objectKey);

            // 先持久化结果，再确认 Redis 消息。
            taskService.markCompleted(taskId, targetKey);

            stream.ack(
                ImageStreamConstants.GROUP_NAME,
                messageId
            );
        } catch (Exception e) {
            // 暂不 ACK，消息保留在 PEL 中，等待恢复任务处理。
            log.error(
                "图片压缩失败: taskId={}, messageId={}",
                taskId,
                messageId,
                e
            );
        }
    }
}
```

这个示例展示了最基本的生命周期：

```text
读取消息
  -> 校验字段
  -> 幂等检查
  -> 标记处理中
  -> 执行业务
  -> 保存结果
  -> ACK
```

异常分支暂时不 ACK，因此消息会留在 PEL 中，后续再由恢复任务接管。实际项目还需要根据异常类型决定重试、死信或直接丢弃，后文会继续完善。

## 9. 用数据库保存任务状态

Stream 负责调度，数据库负责保存业务事实。不要把 Stream 当作唯一的任务状态存储。

任务表可以包含：

```text
task_id
source_object_key
target_object_key
status
retry_count
error_message
processing_started_at
created_at
updated_at
```

状态保持简单即可：

```java
public enum TaskStatus {
    PENDING,        // 已创建，等待消费者处理
    PROCESSING,     // 消费者已经领取，正在执行
    COMPLETED,      // 业务结果已经保存
    FAILED,         // 达到重试上限或遇到永久错误
    ENQUEUE_FAILED  // 数据库已保存，但消息写入 Stream 失败
}
```

完整请求流程为：

```text
用户上传图片
  -> 保存原图
  -> 创建 PENDING 任务
  -> XADD 写入 Stream
  -> 接口返回 taskId
  -> 消费者处理
  -> 更新 COMPLETED 或 FAILED
  -> 前端查询任务状态
```

前端可以在存在 `PENDING` 或 `PROCESSING` 任务时每隔几秒轮询。需要更强实时性时，再使用 SSE 或 WebSocket 推送状态，不必一开始就增加通信复杂度。

## 10. 生产实践一：ACK 必须放在正确位置

ACK 的原则是：

> 只有业务结果已经可靠保存，才确认消息。

不能在业务处理前 ACK：

```java
// 错误示例
stream.ack(groupName, messageId);
compressService.compress(taskId, objectKey);
```

如果 ACK 后应用宕机，这条任务不会再出现在 PEL 中。

正确顺序是：

```text
执行业务
  -> 提交数据库事务
  -> ACK
```

即使顺序正确，数据库提交成功后、ACK 前仍可能宕机。因此消息可能再次投递，消费者必须实现幂等。

在代码中，可以把数据库事务和 ACK 明确分开：

```java
public void processAndAck(
    RStream<String, String> stream,
    StreamMessageId messageId,
    String taskId,
    String objectKey
) {
    // processInTransaction 内部使用 @Transactional，
    // 方法正常返回时，说明业务结果已经提交到数据库。
    taskService.processInTransaction(taskId, objectKey);

    // 数据库提交成功后再 ACK。
    // 如果 ACK 前应用宕机，消息会重复投递，由幂等逻辑兜底。
    stream.ack(
        ImageStreamConstants.GROUP_NAME,
        messageId
    );
}
```

不要在带 `@Transactional` 的业务方法内部直接 ACK，因为方法返回前数据库事务可能尚未真正提交。

## 11. 生产实践二：按至少一次处理设计幂等

Redis Stream 无法替业务消除所有重复执行。常见场景是：

1. 图片压缩成功。
2. 数据库已经保存结果。
3. 应用在 ACK 前宕机。
4. Pending 消息被其他消费者接管。
5. 同一个任务再次执行。

### 11.1 使用业务任务 ID

`taskId` 在所有重试中保持不变，适合做幂等键。

消息 ID 只标识某次 Stream Entry。任务重新入队后，消息 ID 会变化，不能单独用于业务去重。

### 11.2 对结果建立唯一约束

例如图片结果表对 `task_id` 建立唯一索引，防止并发消费者写入多份结果。

### 11.3 使用条件更新抢占任务

```sql
-- 只有待处理、失败，或者已经超时的处理中任务才能被重新抢占。
UPDATE image_task
SET status = 'PROCESSING',
    processing_started_at = CURRENT_TIMESTAMP,
    updated_at = CURRENT_TIMESTAMP
WHERE task_id = :taskId
  AND (
      status IN ('PENDING', 'FAILED')
      OR (
          status = 'PROCESSING'
          AND processing_started_at < :staleBefore
      )
  );
```

普通消费者只处理 `PENDING` 任务。恢复消费者接管超时消息时，才允许抢占长时间处于 `PROCESSING` 的任务。

普通消费与故障恢复最好使用两个语义明确的方法：

```java
@Repository
public interface ImageTaskRepository
    extends JpaRepository<ImageTaskEntity, String> {

    // 普通消费者只能领取尚未开始或允许再次尝试的任务。
    @Modifying
    @Query("""
        update ImageTaskEntity task
           set task.status = :processingStatus,
               task.processingStartedAt = :now
         where task.taskId = :taskId
           and task.status in :claimableStatuses
        """)
    int claimNewTask(
        @Param("taskId") String taskId,
        @Param("now") LocalDateTime now,
        @Param("processingStatus")
        TaskStatus processingStatus,
        @Param("claimableStatuses")
        Collection<TaskStatus> claimableStatuses
    );

    // 恢复消费者只能领取已经超过处理时限的任务。
    @Modifying
    @Query("""
        update ImageTaskEntity task
           set task.status = :processingStatus,
               task.processingStartedAt = :now
         where task.taskId = :taskId
           and task.status = :processingStatus
           and task.processingStartedAt < :staleBefore
        """)
    int claimStaleTask(
        @Param("taskId") String taskId,
        @Param("now") LocalDateTime now,
        @Param("processingStatus")
        TaskStatus processingStatus,
        @Param("staleBefore") LocalDateTime staleBefore
    );
}
```

调用方通过影响行数判断是否获得处理权：

```java
@Transactional
public boolean tryClaim(String taskId, boolean recovery) {
    LocalDateTime now = LocalDateTime.now();

    if (!recovery) {
        // 普通消费者只能领取 PENDING 或 FAILED 任务。
        return repository.claimNewTask(
            taskId,
            now,
            TaskStatus.PROCESSING,
            List.of(
                TaskStatus.PENDING,
                TaskStatus.FAILED
            )
        ) == 1;
    }

    // 恢复消费者只抢占超过 5 分钟仍未完成的任务。
    LocalDateTime staleBefore = now.minusMinutes(5);
    return repository.claimStaleTask(
        taskId,
        now,
        TaskStatus.PROCESSING,
        staleBefore
    ) == 1;
}
```

只有返回 `true` 的消费者才能继续执行业务。这样即使消息重复投递，也不会让多个实例同时处理同一任务。

### 11.4 输出路径保持稳定

缩略图可以固定写入：

```text
thumbnails/{taskId}.jpg
```

重复执行时覆盖同一对象，避免每次生成新的孤儿文件。

## 12. 生产实践三：区分错误类型和重试策略

异常不应该全部使用同一种处理方式。

### 12.1 不可恢复错误

例如：

- 图片格式不支持
- 消息缺少必要字段
- 文件已损坏
- 业务记录已删除

继续重试不会改变结果。应记录失败原因，必要时写入死信 Stream，然后 ACK 原消息。

### 12.2 可恢复错误

例如：

- 对象存储临时超时
- 下游接口返回 429
- 网络连接短暂中断
- 数据库暂时不可用

这类错误可以重试，但不要在捕获异常后立即重新入队。下游持续故障时，立即重试会形成高频循环。

推荐使用指数退避：

```text
第 1 次：1 秒后
第 2 次：5 秒后
第 3 次：30 秒后
```

Redis Stream 本身不提供精确延迟队列。需要延迟重试时，可以采用：

- Redis Sorted Set 保存 `nextRetryAt`
- 数据库重试表加定时扫描
- 专门的延迟消息组件

重新发送重试消息时，应先确认新消息写入成功，再 ACK 原消息。即使如此仍可能产生重复，因此幂等依然不可省略。

可以先统一异常分类：

```java
private void handleFailure(
    RStream<String, String> stream,
    StreamMessageId messageId,
    ImageTaskMessage message,
    Exception exception
) {
    if (exception instanceof InvalidImageException
            || exception instanceof TaskNotFoundException
            || message.attempt() >= 3) {
        // 参数错误、文件损坏、任务已删除等永久错误不再重试。
        // 临时错误达到 3 次重试上限后也进入死信队列。
        deadLetterService.moveToDeadLetter(
            messageId,
            message,
            exception
        );
        taskService.markFailed(
            message.taskId(),
            exception.getMessage()
        );

        // DLQ 和失败状态都保存成功后，再 ACK 原消息。
        stream.ack(
            ImageStreamConstants.GROUP_NAME,
            messageId
        );
        return;
    }

    // 网络超时、限流等临时错误进入延迟重试队列。
    retryScheduler.schedule(
        message.nextAttempt(),
        exception.getMessage()
    );

    // 新的重试任务已经可靠保存后，再 ACK 原消息。
    stream.ack(
        ImageStreamConstants.GROUP_NAME,
        messageId
    );
}
```

### 12.3 使用 Sorted Set 实现退避重试

可以使用 Redis Sorted Set 保存“下一次可执行时间”，分数是毫秒时间戳：

```java
public record RetryPayload(
    ImageTaskMessage message,
    String lastError
) {
}

@Service
@RequiredArgsConstructor
public class ImageRetryScheduler {

    private static final String RETRY_KEY =
        "image:compress:retry";

    private final RedissonClient redissonClient;
    private final ObjectMapper objectMapper;
    private final ImageCompressProducer producer;

    public void schedule(
        ImageTaskMessage message,
        String lastError
    ) {
        int attempt = message.attempt();

        // 根据重试次数计算 1 秒、5 秒、30 秒的退避时间。
        long delaySeconds = switch (attempt) {
            case 1 -> 1;
            case 2 -> 5;
            default -> 30;
        };

        RetryPayload payload = new RetryPayload(
            message,
            lastError
        );

        String json;
        try {
            json = objectMapper.writeValueAsString(payload);
        } catch (JsonProcessingException exception) {
            // 序列化失败属于程序或消息结构错误，不能静默丢弃。
            throw new IllegalStateException(
                "重试任务序列化失败",
                exception
            );
        }
        double executeAt =
            System.currentTimeMillis() + delaySeconds * 1000;

        // Sorted Set 的 score 就是下一次执行时间。
        RScoredSortedSet<String> retryQueue =
            redissonClient.getScoredSortedSet(
                RETRY_KEY,
                StringCodec.INSTANCE
            );
        retryQueue.add(executeAt, json);
    }

    @Scheduled(fixedDelay = 1000)
    public void publishDueTasks() {
        RScoredSortedSet<String> retryQueue =
            redissonClient.getScoredSortedSet(
                RETRY_KEY,
                StringCodec.INSTANCE
            );

        double now = System.currentTimeMillis();

        // 每次最多获取 100 条已经到期的重试任务。
        Collection<String> dueTasks = retryQueue.valueRange(
            0,
            true,
            now,
            true,
            0,
            100
        );

        for (String json : dueTasks) {
            try {
                RetryPayload payload =
                    objectMapper.readValue(
                        json,
                        RetryPayload.class
                    );

                // 重新写入 Stream，attempt 已经在 nextAttempt 中递增。
                producer.send(payload.message());

                // XADD 成功后再删除延迟任务。
                // 宕机最多造成重复发送，不会造成任务永久丢失。
                retryQueue.remove(json);
            } catch (Exception exception) {
                // 发布失败时保留原数据，下一轮继续尝试。
                // 多实例可能重复发送，因此消费者仍必须幂等。
            }
        }
    }
}
```

示例省略了最大重试次数判断。实际项目应在 `nextAttempt()` 中限制次数，超过上限后转入 DLQ。

## 13. 生产实践四：恢复 Pending 消息

只消费 `neverDelivered()` 对应的新消息是不够的。

消费者读到消息后如果宕机，消息会留在该消费者的 PEL 中。其他消费者继续读取 `>` 时，不会自动拿到这些旧消息。

需要增加一个恢复任务：

1. 定期扫描 Pending 消息。
2. 找出空闲时间超过阈值的消息。
3. 使用 `XAUTOCLAIM` 转移给恢复消费者。
4. 再次执行幂等检查和业务处理。

接管阈值必须大于正常任务的最长处理时间。

例如大部分图片在 10 秒内完成，极端情况不超过 1 分钟，可以把接管阈值设为 5 分钟。若阈值设得过短，正常任务还没有结束就会被重复接管。

还应记录：

- 消息空闲时间
- 投递次数
- 原消费者名称
- 当前任务状态

超过最大投递次数后，不应无限接管，而应进入死信 Stream。

可以把底层 `XAUTOCLAIM` 封装为一个恢复客户端，让定时任务只负责业务流程：

```java
public record ClaimedMessage(
    StreamMessageId messageId,
    Map<String, String> body,
    long deliveryCount
) {
}

public interface RedisStreamRecoveryClient {

    // 实现类负责调用 XAUTOCLAIM，并把返回结果转换为业务对象。
    List<ClaimedMessage> autoClaim(
        String streamKey,
        String groupName,
        String consumerName,
        Duration minIdleTime,
        int count
    );
}

@Component
@RequiredArgsConstructor
public class PendingRecoveryJob {

    private final RedisStreamRecoveryClient recoveryClient;
    private final ImageMessageHandler messageHandler;

    @Scheduled(fixedDelay = 60_000)
    public void recover() {
        // 接管空闲超过 5 分钟的 Pending 消息，每次最多处理 100 条。
        List<ClaimedMessage> messages =
            recoveryClient.autoClaim(
                ImageStreamConstants.STREAM_KEY,
                ImageStreamConstants.GROUP_NAME,
                "image-recovery-worker",
                Duration.ofMinutes(5),
                100
            );

        for (ClaimedMessage message : messages) {
            if (message.deliveryCount() > 3) {
                // 投递次数过多，说明它可能是一条毒消息。
                messageHandler.moveToDeadLetter(message);
                continue;
            }

            // recovery=true，只允许抢占数据库中已超时的 PROCESSING 任务。
            messageHandler.process(message, true);
        }
    }
}
```

`RedisStreamRecoveryClient.autoClaim(...)` 对应 Redis 的 `XAUTOCLAIM` 命令。之所以在示例中增加这一层封装，是因为不同 Redisson 版本的自动接管 API 签名可能不同，但输入参数始终是 Stream、Group、Consumer、最小空闲时间、起始 ID 和数量。

## 14. 生产实践五：建立死信 Stream

可以为最终失败消息建立独立 Stream：

```text
image:compress:dlq
```

死信消息建议包含：

```java
// 死信消息保留原任务、失败原因和投递次数，便于人工排查。
Map<String, String> deadMessage = Map.of(
    "taskId", taskId,
    "originalMessageId", messageId.toString(),
    "objectKey", objectKey,
    "errorType", errorType,
    "errorMessage", errorMessage,
    "failedAt", Instant.now().toString(),
    "deliveries", String.valueOf(deliveries)
);
```

先成功写入 DLQ，再 ACK 原消息。若死信写入失败却直接 ACK，最后一份故障证据也会丢失。

完整写入方法可以这样实现：

```java
@Service
@RequiredArgsConstructor
public class ImageDeadLetterService {

    private static final String DLQ_KEY =
        "image:compress:dlq";

    private final RedissonClient redissonClient;

    public void moveToDeadLetter(
        StreamMessageId originalMessageId,
        ImageTaskMessage message,
        Exception exception
    ) {
        RStream<String, String> dlq =
            redissonClient.getStream(
                DLQ_KEY,
                StringCodec.INSTANCE
            );

        String errorMessage =
            exception.getMessage() == null
                ? "unknown error"
                : exception.getMessage();

        Map<String, String> deadMessage = Map.of(
            "taskId", message.taskId(),
            "objectKey", message.objectKey(),
            "originalMessageId",
                originalMessageId.toString(),
            "errorType",
                exception.getClass().getSimpleName(),
            "errorMessage", errorMessage,
            "attempt",
                String.valueOf(message.attempt()),
            "failedAt", Instant.now().toString()
        );

        // 先确保死信写入成功；方法抛异常时，调用方不能 ACK 原消息。
        dlq.add(
            StreamAddArgs.entries(deadMessage)
                .trimNonStrict()
                .maxLen(10_000)
        );
    }
}
```

DLQ 还需要配套：

- 长度告警
- 查询和筛选工具
- 人工重放功能
- 重放前修正参数的能力
- 操作审计

死信队列不是失败消息的终点，而是人工介入和问题分析的入口。

## 15. 生产实践六：控制 Stream 长度

ACK 只清理 PEL，不会删除 Stream 中的历史消息。如果不做裁剪，Stream 会持续占用 Redis 内存和持久化空间。

常用方式是写入时设置：

```text
MAXLEN ~ 100000
```

保留长度可以粗略估算：

```text
保留条数 = 峰值每秒消息数 × 计划保留秒数
```

例如峰值每秒 20 条，希望保留 2 小时：

```text
20 × 2 × 60 × 60 = 144000
```

实际配置还要留出流量波动和故障恢复余量。

裁剪周期不能短于：

- 最长任务处理时间
- Pending 接管时间
- 最长故障恢复时间

否则消息仍在 PEL 中，原始 Entry 却已经被裁剪，恢复消费者可能只看到 Pending ID，无法取得完整消息内容。

## 16. 生产实践七：处理数据库与 Redis 双写

创建任务通常包含两个动作：

1. 数据库写入 `PENDING` 任务。
2. Redis Stream 写入消息。

它们不在同一个本地事务中。

### 16.1 数据库成功，XADD 失败

数据库中会留下一个永远不被消费的 `PENDING` 任务。

最低限度的补偿方案是：

- XADD 失败后标记 `ENQUEUE_FAILED`
- 定时扫描长时间未入队的任务
- 根据 `taskId` 幂等地重新发送

最简单的补偿扫描可以这样写：

```java
@Scheduled(fixedDelay = 30_000)
public void resendEnqueueFailedTasks() {
    // 每次只查询一小批，避免补偿任务冲击数据库和 Redis。
    List<ImageTaskEntity> tasks =
        repository.findTop100ByStatusOrderByCreatedAt(
            TaskStatus.ENQUEUE_FAILED
        );

    for (ImageTaskEntity task : tasks) {
        try {
            // send 内部仍使用相同 taskId，因此消费者可以幂等处理。
            producer.send(
                task.getTaskId(),
                task.getSourceObjectKey(),
                task.getTraceId()
            );

            // 入队成功后再把状态恢复为 PENDING。
            task.markPending();
            repository.save(task);
        } catch (Exception exception) {
            // 保留 ENQUEUE_FAILED，等待下一轮继续补偿。
            log.warn(
                "任务重新入队失败: taskId={}",
                task.getTaskId(),
                exception
            );
        }
    }
}
```

### 16.2 XADD 成功，数据库事务回滚

消费者会收到一条找不到业务任务的消息。

此时应将“任务不存在”识别为不可恢复错误，记录后 ACK，避免无限重试。

### 16.3 Transactional Outbox

可靠性要求更高时，可以在同一个数据库事务中写入：

- 业务任务表
- Outbox 事件表

后台发布器扫描 Outbox 并写入 Redis Stream，成功后标记已发布。

Outbox 解决的是“数据库中已经存在业务事实，但消息没有发出去”的问题。发布器仍可能重复发送，所以消费者幂等仍然需要保留。

创建业务任务时，在同一个数据库事务中写两张表：

```java
@Transactional
public String createImageTask(String objectKey)
        throws JsonProcessingException {
    String taskId = UUID.randomUUID().toString();
    String traceId = UUID.randomUUID().toString();

    // 保存业务任务。
    ImageTaskEntity task =
        ImageTaskEntity.pending(
            taskId,
            objectKey,
            traceId
        );
    imageTaskRepository.save(task);

    // 同一事务内保存待发布事件。
    OutboxEvent event = OutboxEvent.pending(
        "IMAGE_COMPRESS",
        taskId,
        objectMapper.writeValueAsString(
            new ImageTaskMessage(
                taskId,
                objectKey,
                traceId,
                0
            )
        )
    );
    outboxRepository.save(event);

    return taskId;
}
```

后台发布器只处理尚未发布的 Outbox：

```java
@Scheduled(fixedDelay = 1000)
@Transactional
public void publishOutbox()
        throws JsonProcessingException {
    List<OutboxEvent> events =
        outboxRepository.lockNextBatch(100);

    for (OutboxEvent event : events) {
        // XADD 失败会抛出异常，当前事务回滚，
        // 事件仍保持未发布状态，下一轮继续尝试。
        producer.send(
            objectMapper.readValue(
                event.getPayload(),
                ImageTaskMessage.class
            )
        );

        // 只有写入 Stream 成功后才标记已发布。
        event.markPublished(Instant.now());
    }
}
```

## 17. 生产实践八：持久化、高可用和监控

### 17.1 Redis 持久化

Stream 消息能否在故障后恢复，取决于 Redis 配置：

- RDB 快照频率
- AOF 是否启用
- `appendfsync` 策略
- 主从复制
- Sentinel 或 Cluster 故障转移
- 备份与恢复流程

AOF `everysec` 通常在性能和可靠性之间较平衡，但极端故障下仍可能丢失最近约 1 秒的数据。绝对不能丢失的任务，需要 Outbox 或数据库补偿，而不是只依赖 Redis 持久化。

### 17.2 监控指标

至少监控：

| 指标 | 含义 | 可能的问题 |
| --- | --- | --- |
| `XLEN` | Stream 长度 | 裁剪失败或生产量异常 |
| Group `lag` | 尚未投递给组的消息数 | 消费能力不足 |
| Group `pending` | 已投递但未 ACK 的数量 | 消费者宕机或任务卡住 |
| Pending idle | 消息未处理时长 | 恢复任务未生效 |
| 投递次数 | 消息被接管次数 | 下游故障或毒消息 |
| DLQ 长度 | 最终失败数量 | 业务错误集中出现 |
| P95/P99 耗时 | 任务处理时延 | 下游性能下降 |

常用命令：

```bash
# 查看 Stream 中当前保留的消息数量。
XLEN image:compress:stream

# 查看每个消费者组的 lag 和 pending。
XINFO GROUPS image:compress:stream

# 查看组内各 Consumer 的 Pending 数量和空闲时间。
XINFO CONSUMERS \
  image:compress:stream \
  image-compress-group

# 查看组内尚未 ACK 的消息概况。
XPENDING \
  image:compress:stream \
  image-compress-group
```

日志中建议统一包含：

```text
taskId
messageId
consumerName
traceId
deliveries
costMs
result
```

## 18. 生产实践九：消费者线程和优雅停机

阻塞读取只负责等待消息，任务并发度仍由应用线程模型决定。

如果任务耗时较长：

- 使用固定大小的工作线程池
- 使用有界队列限制在途任务
- 队列满时停止继续拉取
- 给文件下载、数据库和外部接口设置超时
- 根据 CPU、内存和下游限流确定并发数

不要一次拉取几百条消息，再全部塞进 JVM 的无界队列。这样 Redis 看起来没有堆积，任务只是换到应用内存中堆积。

应用停机时应：

1. 停止读取新消息。
2. 等待正在执行的任务在限定时间内完成。
3. 已完成任务正常 ACK。
4. 未完成任务不 ACK，后续由 Pending 恢复任务接管。

## 19. 抽取通用生产者和消费者模板

当项目只有一条 Stream 链路时，直接写 Producer 和 Consumer 最清楚。

当图片压缩、报表生成、文档解析等多条链路都出现后，可以抽取稳定骨架：

```text
Producer:
构造消息 -> XADD -> 记录 messageId -> 入队失败回写状态

Consumer:
读取消息 -> 解析 -> 幂等检查 -> 标记处理中
-> 执行业务 -> 保存结果 -> ACK
-> 异常分类 -> 重试或死信
```

业务子类只实现：

- Stream Key 和 Group
- 消息解析
- 业务处理
- 状态更新
- 错误分类

抽象的目标是统一 ACK、日志、重试和生命周期，不是把所有任务做成一个巨大的通用消费者。只有稳定且重复的流程才值得进入基类。

## 20. 其他 Java 客户端实现

前文选择 Redisson，是因为它提供了清晰的 `RStream` API，并且同一个项目通常还会使用 Redisson 的分布式锁、限流器等能力。

Redis Stream 并不依赖 Redisson。Java 项目还可以使用 Spring Data Redis、Lettuce 或 Jedis。

### 20.1 Spring Data Redis

Spring Data Redis 通过 `StreamOperations` 写入消息：

```java
// 构造普通字符串字段，避免默认 JDK 序列化产生不可读内容。
Map<String, String> message = Map.of(
    "taskId", taskId,
    "objectKey", objectKey
);

// 把 Map 包装成写入指定 Stream 的 Record。
MapRecord<String, String, String> record =
    StreamRecords
        .mapBacked(message)
        .withStreamKey("image:compress:stream");

// XADD 写入消息，并返回 Redis 生成的消息 ID。
RecordId recordId =
    stringRedisTemplate
        .opsForStream()
        .add(record);
```

同步读取可以使用：

```java
// 使用消费者组阻塞读取消息。
List<MapRecord<String, Object, Object>> messages =
    redisTemplate.opsForStream().read(
        Consumer.from(
            // 消费者组名称。
            "image-compress-group",
            // 当前应用实例的 Consumer 名称。
            "worker-01"
        ),
        StreamReadOptions.empty()
            .count(10)
            .block(Duration.ofSeconds(2)),
        StreamOffset.create(
            "image:compress:stream",
            // 从该消费者组上次成功读取的位置继续。
            ReadOffset.lastConsumed()
        )
    );
```

Spring Data Redis 还提供 `StreamMessageListenerContainer`，可以统一管理轮询线程和连接：

```java
// 注册消息监听器，但此时容器还没有真正开始轮询。
container.receive(
    Consumer.from(
        "image-compress-group",
        "worker-01"
    ),
    StreamOffset.create(
        "image:compress:stream",
        ReadOffset.lastConsumed()
    ),
    message -> {
        // 先执行业务逻辑。
        process(message);

        // 业务成功后手动 ACK。
        redisTemplate.opsForStream().acknowledge(
            "image-compress-group",
            message
        );
    }
);

// 启动监听容器。
container.start();
```

可靠任务处理更适合手动 ACK。`receiveAutoAck` 会在接收时自动确认，业务尚未完成就失去 Pending 保护。

使用 Spring Data Redis 时还要检查 `keySerializer`、`hashKeySerializer` 和 `hashValueSerializer`。序列化配置不一致，会导致 CLI 中出现不可读字段，跨语言消费者也难以解析。

### 20.2 Lettuce 和 Jedis

Lettuce、Jedis 都支持 Redis Stream 命令，适合项目已经统一使用这些客户端，或需要更贴近 Redis 命令的控制。

相应地，开发者需要自己处理更多内容：

- 阻塞连接和线程
- 断线重连
- 消息序列化
- 消费循环
- ACK 和 Pending 恢复
- 应用生命周期

选择哪一个客户端并不是核心。无论使用 Redisson、Spring Data Redis、Lettuce 还是 Jedis，ACK、幂等、Pending 恢复和监控原则都相同。

## 21. 常见误区

### 21.1 认为 Redis Pub/Sub 可以替代 Stream

Pub/Sub 面向在线广播，没有历史消息、ACK 和 Pending，不适合可靠任务。

### 21.2 业务执行前 ACK

ACK 后应用宕机，消息无法通过 PEL 恢复。

### 21.3 认为 ACK 会删除消息

ACK 只从消费者组的 PEL 中移除记录。Stream 历史仍需使用 `MAXLEN`、`MINID` 或 `XTRIM` 管理。

### 21.4 只读取新消息，不恢复 Pending

消费者宕机后，旧 Pending 消息会长期滞留。

### 21.5 所有错误都立即重试

永久错误重试没有意义，临时故障立即重试又可能压垮下游。应先分类，再决定退避、死信或 ACK。

### 21.6 在消息中保存大对象

大文件和长文本会增加 Redis 内存、网络、AOF 和复制压力。Stream 更适合传递任务引用。

### 21.7 用消息 ID 作为唯一幂等键

重新入队会生成新的消息 ID。幂等应使用稳定的业务 `taskId`。

### 21.8 MAXLEN 设置过小

历史消息可能在 Pending 恢复之前被裁剪，导致无法重新取得消息内容。

### 21.9 只监控 Stream 长度

Stream 不长并不代表消费正常。消息可能全部堆积在 PEL 中。

## 22. 生产落地清单

- [ ] 先确认 Redis Stream 符合业务规模和可靠性要求
- [ ] 消息只保存业务 ID、数据引用、追踪信息和版本号
- [ ] 按任务耗时、重试策略和扩容方式划分 Stream
- [ ] 首次创建消费者组时明确使用 `0` 还是 `$`
- [ ] Consumer 名称唯一且能够定位实例
- [ ] 使用有限超时的阻塞读取
- [ ] 业务结果提交后再 ACK
- [ ] 使用稳定 `taskId` 实现幂等
- [ ] 区分可恢复和不可恢复错误
- [ ] 重试具有次数上限和退避策略
- [ ] 定时恢复超时 Pending 消息
- [ ] 最终失败消息进入 DLQ
- [ ] 使用 `MAXLEN ~` 或 `MINID` 控制 Stream 大小
- [ ] 裁剪周期覆盖最长处理和故障恢复时间
- [ ] 使用补偿扫描或 Outbox 处理数据库与 Redis 双写
- [ ] 根据可靠性要求配置 AOF、复制和故障转移
- [ ] 监控 `lag`、`pending`、idle、投递次数和 DLQ
- [ ] 使用有界线程池并实现优雅停机

## 23. 总结

Redis Stream 位于简单 Redis 队列和专业消息中间件之间。

它比 List 和 Pub/Sub 更适合可靠任务，因为提供了消费者组、ACK、PEL 和历史消息；它又比 RabbitMQ、RocketMQ、Kafka 更轻量，适合已经使用 Redis 的中小型系统。

一套可靠的 Stream 实现，需要同时做好：

1. **选型边界**：明确 Stream 能解决什么，什么时候应该升级到专业消息系统。
2. **基础消费**：使用消费者组、阻塞读取、手动 ACK 和长度裁剪。
3. **业务可靠性**：按至少一次处理设计幂等，正确处理数据库与 Redis 双写。
4. **故障闭环**：区分错误类型，提供退避重试、Pending 恢复和死信处理。
5. **运行治理**：配置持久化、高可用、监控、背压和优雅停机。

真正的最佳实践不是多调用几个 Redis 命令，而是让每一条消息在成功、失败和消费者宕机时都有清晰的去向。

## 参考资料

- [Redis 官方文档：Redis Streams](https://redis.io/docs/latest/develop/data-types/streams/)
- [Redis 官方文档：XADD](https://redis.io/docs/latest/commands/xadd/)
- [Redis 官方文档：XREADGROUP](https://redis.io/docs/latest/commands/xreadgroup/)
- [Redis 官方文档：XACK](https://redis.io/docs/latest/commands/xack/)
- [Redis 官方文档：XPENDING](https://redis.io/docs/latest/commands/xpending/)
- [Redis 官方文档：XAUTOCLAIM](https://redis.io/docs/latest/commands/xautoclaim/)
- [Redis 官方文档：Redis Persistence](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/)
- [Redisson Reference Guide](https://redisson.pro/docs/)
- [Spring Data Redis：Redis Streams](https://docs.spring.io/spring-data/redis/reference/redis/redis-streams.html)
- [RabbitMQ Work Queues Tutorial](https://www.rabbitmq.com/tutorials/tutorial-two-java)
- [Apache RocketMQ Documentation](https://rocketmq.apache.org/docs/)
- [Apache Kafka Documentation](https://kafka.apache.org/documentation/)
