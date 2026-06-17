---
title: Redis + Lua 多维度分布式限流组件：从方案选型到 Spring Boot 实战
tags:
  - Redis
  - Lua
  - 限流
  - Java
  - Spring Boot
categories:
  - java
keywords:
  - Redis分布式限流
  - Redis Lua限流
  - 多维度限流
  - Spring Boot限流
  - AOP限流
description: 从为什么需要限流开始，对比单机限流、网关限流、Redisson RRateLimiter 和 Redis + Lua 等方案，最后实现一个支持全局、IP、用户多维度组合的 Spring Boot 分布式限流组件。
cover: ../img/redis/redis.png
copyright: true
abbrlink: d4f8a21c
date: 2026-06-17 10:00:00
updated: 2026-06-17 10:00:00
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

接口一开始通常不会先做限流。

用户少、调用链短、服务只有一个实例时，限流看起来像是“过早优化”。但只要业务进入真实流量环境，下面这些情况就很容易出现：

- 登录、短信、上传、搜索、AI 解析等接口被用户连续点击。
- 同一个接口被脚本、爬虫、压测工具或恶意请求反复调用。
- 某个下游服务变慢，上游请求还在持续涌入，最终把线程池、连接池和数据库一起拖垮。
- 应用从单实例扩展到多实例后，原来的本地计数器不再能表达“全局每秒最多多少次”。

限流要解决的不是“让系统永远不报错”，而是给系统加一道入口秩序：在流量超过承载能力时，优先保护核心资源，让超出的请求快速失败、排队等待或走降级结果。

本文会先讨论限流方案怎么选，再实现一个基于 Redis + Lua + Spring AOP 的多维度分布式限流组件。示例场景统一为“简历上传后触发 AI 解析”，因为这类接口通常成本高、耗时长、也最怕被重复请求。

## 1. 为什么需要限流

限流常见于三类场景。

### 1.1 保护高成本接口

比如文件解析、图片处理、报表导出、大模型调用、第三方接口调用。这类接口即使 QPS 不高，也可能因为单次调用成本太高而压垮系统。

```java
@PostMapping("/api/resumes/analyze")
public Result<AnalyzeResult> analyze(@RequestParam("file") MultipartFile file) {
    // AI 解析可能消耗较长时间，也可能调用外部模型服务。
    return Result.success(resumeAnalyzeService.analyze(file));
}
```

如果用户连续点 10 次，系统可能真的并发执行 10 次解析。限流之后，可以把规则收敛为“同一个用户 1 分钟最多提交 3 次”。

### 1.2 防止异常流量放大故障

下游接口变慢时，如果入口不做限制，请求会持续堆积：

- Web 容器线程被占满。
- 数据库连接池被占满。
- Redis、MQ、第三方 API 被连带打满。
- 正常用户请求也被阻塞。

限流不是故障治理的全部，但它能把“无限涌入”变成“有限进入”。

### 1.3 多实例部署后的全局约束

单机限流只约束当前 JVM。如果应用部署了 4 个实例，每个实例都配置“每秒 100 次”，那么全局峰值可能变成每秒 400 次。

这时就需要一个所有实例共享的状态中心。Redis 很适合做这件事：延迟低、命令丰富、天然适合保存短生命周期计数状态。

## 2. 常见限流方案对比

限流没有银弹，选型要看部署形态、规则复杂度、精度要求和维护成本。

### 2.1 本地限流：Guava、Bucket4j、Resilience4j

本地限流把计数状态放在当前进程内，典型方案有 Guava `RateLimiter`、Bucket4j、Resilience4j RateLimiter。

优点：

- 性能最好，基本都是内存操作。
- 接入简单，不依赖 Redis、网关或注册中心。
- 适合单体应用、后台任务、单实例工具服务。

缺点：

- 多实例之间不能共享额度。
- 应用重启后状态丢失。
- 很难表达“全站每秒最多 1000 次”这种全局规则。

适合场景：单实例服务、本地任务调度、对全局一致性没有要求的接口保护。

### 2.2 网关限流：Nginx、Spring Cloud Gateway、Kong

网关限流把规则放在入口层，所有请求先经过网关再进入业务服务。

优点：

- 入口统一，能在请求到达业务服务前就拦截。
- 对业务代码侵入很低。
- 适合按路径、域名、IP、Header 做通用规则。

缺点：

- 很难直接使用业务身份，比如会员等级、租户套餐、接口参数。
- 规则复杂后需要额外配置中心或管理平台。
- 业务方法内部的细粒度限流仍然不方便。

适合场景：公网入口保护、基础防刷、按路由维度控制大盘流量。

### 2.3 Sentinel 这类治理组件

Sentinel、Hystrix 类组件更偏服务治理，除了限流，还会覆盖熔断、降级、热点参数、系统自适应保护等能力。

优点：

- 能力完整，适合微服务体系。
- 控制台和规则管理比较成熟。
- 对热点参数、熔断降级支持更系统。

缺点：

- 引入成本高于一个轻量限流组件。
- 团队需要理解它的规则模型和运行方式。
- 如果项目只想做少量接口限流，可能显得重。

适合场景：已经有微服务治理需求，或者希望把限流、熔断、降级统一管理。

### 2.4 Redisson RRateLimiter

Redisson 提供了开箱即用的 `RRateLimiter`。如果只需要一个简单的分布式限流器，它通常是很好的起点。

```java
RRateLimiter limiter = redissonClient.getRateLimiter("api:resume:analyze");

// 只在首次创建时设置速率：整个部署每秒最多 20 次。
limiter.trySetRate(RateType.OVERALL, 20, 1, RateIntervalUnit.SECONDS);

if (!limiter.tryAcquire()) {
    throw new RateLimitExceededException("请求过于频繁，请稍后再试");
}
```

优点：

- 使用简单，不需要自己写 Lua。
- Redisson 已经处理了很多底层细节。
- `OVERALL` 可以表示跨 Redisson 实例共享的总速率。

缺点：

- 多维度组合需要自己组织多个 limiter，并处理“部分成功后如何回滚”的问题。
- 复杂业务规则不如自定义 Lua 灵活。
- Redis Cluster 下的 Key 规划仍然需要谨慎。

适合场景：单维度、规则简单、希望快速接入分布式限流。

### 2.5 Redis INCR + EXPIRE

最常见的自研方案是固定窗口计数：

```java
String key = "ratelimit:resume:analyze:" + userId + ":" + currentSecond;
Long count = redisTemplate.opsForValue().increment(key);

if (count != null && count == 1) {
    // 第一次写入时设置过期时间，避免限流 Key 永久留存。
    redisTemplate.expire(key, Duration.ofSeconds(2));
}

if (count != null && count > 5) {
    throw new RateLimitExceededException("请求过于频繁，请稍后再试");
}
```

优点：

- 实现简单。
- 性能好。
- 对很多后台接口已经够用。

缺点：

- 固定窗口有边界突刺问题。比如 12:00:00.999 和 12:00:01.001 各打满一次，瞬时流量会接近配置值的两倍。
- `INCR` 和 `EXPIRE` 如果不放进 Lua，异常情况下可能留下无过期时间的 Key。
- 多维度组合不原子，比如全局维度成功了，用户维度失败了，回滚会变复杂。

适合场景：规则简单、能接受固定窗口误差、只做粗粒度保护。

### 2.6 Redis + Lua

Redis + Lua 的核心价值是把“清理过期请求、检查额度、写入本次请求、设置过期时间”放到 Redis 服务器端一次完成。

优点：

- 原子性好，多个命令不会被其他请求插入。
- 能组合 String、Sorted Set 等数据结构。
- 适合实现多维度限流、滑动窗口、加权请求等自定义规则。
- 应用只需要拿到通过或拒绝的结果。

缺点：

- 需要维护 Lua 脚本。
- 脚本执行期间会占用 Redis 单线程，脚本必须短小。
- Redis Cluster 下，脚本访问的多个 Key 必须落在同一个 Slot。

适合场景：多实例部署、需要全局限流、规则有业务维度、希望封装成注解给业务方使用。

## 3. 最终方案：Redis + Lua + 注解 + AOP

本文最终选择 Redis + Lua，并把它封装成注解。

目标如下：

- 支持全局、IP、用户等多维度组合。
- 多个维度必须同时满足才允许请求通过。
- 支持毫秒、秒、分钟等时间窗口。
- 支持限流后的降级方法。
- 对业务代码侵入尽量低。
- 兼容 Redis Cluster 的 Key Slot 规则。

使用效果大概是这样：

```java
@PostMapping("/api/resumes/analyze")
@RateLimit(
    dimensions = {RateLimit.Dimension.GLOBAL, RateLimit.Dimension.IP, RateLimit.Dimension.USER},
    count = 5,
    interval = 1,
    timeUnit = RateLimit.TimeUnit.MINUTES,
    fallback = "analyzeFallback"
)
public Result<AnalyzeResult> analyze(@RequestParam("file") MultipartFile file) {
    // 真正的业务逻辑只关心解析本身。
    return Result.success(resumeAnalyzeService.analyze(file));
}

private Result<AnalyzeResult> analyzeFallback(MultipartFile file) {
    // 被限流后返回更友好的业务提示。
    return Result.error("解析请求过于频繁，请稍后再试");
}
```

这段配置表示：

- 全站 1 分钟最多允许 5 次该接口请求。
- 同一个 IP 1 分钟最多允许 5 次。
- 同一个用户 1 分钟最多允许 5 次。
- 三个维度是 AND 关系，只要任意一个维度超限，本次请求就被拒绝。

实际项目里，全局额度通常会比单用户额度大很多。这里为了 demo 直观，三个维度使用了相同参数。

## 4. 限流算法怎么选

实现之前，先明确算法。

### 4.1 固定窗口

固定窗口把时间切成一个个固定片段，例如每分钟一个窗口。窗口内计数达到阈值后拒绝。

优点是简单高效，缺点是窗口边界可能出现突刺。

### 4.2 滑动窗口

滑动窗口记录最近一段时间内的请求时间点，每次请求进来时先删除窗口外的旧记录，再统计窗口内数量。

优点是更接近真实的“最近 N 秒最多 M 次”，缺点是需要保存请求时间线，内存开销高于固定窗口。

### 4.3 令牌桶

令牌桶按固定速率生成令牌，请求必须拿到令牌才能通过。桶容量允许短时间突发。

适合既要限制平均速率，又允许少量突发的场景。

### 4.4 漏桶

漏桶把请求放进队列，再以固定速率流出。它更强调平滑输出。

适合保护下游稳定处理能力，但如果请求不允许排队，直接拒绝会更简单。

本文选择滑动窗口，因为它的语义最容易解释：某个维度在最近一段时间内最多请求多少次。它也很适合用 Redis Sorted Set 实现。

## 5. Redis 数据结构设计

每一个限流维度使用一个 Sorted Set。

Key 示例：

```text
ratelimit:{ResumeController:analyze}:global
ratelimit:{ResumeController:analyze}:ip:192.168.1.10
ratelimit:{ResumeController:analyze}:user:10086
```

Sorted Set 中：

- `score`：请求时间戳，单位毫秒。
- `member`：请求唯一 ID，建议使用 UUID。

为什么 `member` 不能直接用时间戳？

因为 Sorted Set 的 member 是唯一的。如果多个请求在同一毫秒进入，member 相同就会互相覆盖，计数会偏小，限流也会失准。所以 member 必须带随机值或请求 ID。

为什么 Key 里有 `{ResumeController:analyze}`？

这是 Redis Cluster 的 Hash Tag 写法。Redis Cluster 会根据 `{}` 中的内容计算 Slot。只要多个 Key 的 Hash Tag 相同，它们就会落到同一个 Slot，Lua 脚本才能在集群模式下同时访问这些 Key。

## 6. Lua 脚本实现

下面这个脚本做四件事：

1. 对每个维度删除窗口外的旧请求。
2. 检查每个维度当前请求数是否超过阈值。
3. 只有所有维度都通过时，才写入本次请求。
4. 给 Key 设置过期时间，避免冷门接口留下垃圾数据。

```lua
-- scripts/rate_limit.lua
-- KEYS[1..N]：每个限流维度对应的 Redis Key
-- ARGV[1]：当前时间戳，毫秒
-- ARGV[2]：窗口大小，毫秒
-- ARGV[3]：窗口内最大请求数
-- ARGV[4]：本次请求唯一标识

local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local request_id = ARGV[4]

if now == nil or window == nil or limit == nil then
    return {0, "bad_arguments"}
end

local window_start = now - window

-- 第一阶段：清理并预检查。
-- 这里不能边检查边写入，否则后面的维度失败时会留下部分成功的状态。
for i, key in ipairs(KEYS) do
    redis.call("ZREMRANGEBYSCORE", key, 0, window_start)

    local current = redis.call("ZCARD", key)
    if current >= limit then
        return {0, key}
    end
end

-- 第二阶段：所有维度都没超限，再统一写入本次请求。
for i, key in ipairs(KEYS) do
    redis.call("ZADD", key, now, request_id .. ":" .. i)

    -- 过期时间略大于窗口即可，避免 Key 长期留存。
    local ttl = math.ceil(window / 1000) + 1
    redis.call("EXPIRE", key, ttl)
end

return {1, "ok"}
```

这个版本是“每次请求消耗 1 个名额”。如果你的业务里有加权请求，比如一次批量导入按文件数量消耗多个名额，可以把 `ZCARD` 改成记录权重并求和，或者为一次请求写入多个 member。多数接口限流不需要那么复杂。

还有一个容易忽略的点：Redis 官方建议脚本访问的所有 Key 都通过 `KEYS` 显式传入，不要在脚本内部拼接出新的 Key。这样在单机和集群模式下都更可控。

## 7. Spring Boot 组件实现

### 7.1 引入 Redisson

Gradle 示例：

```groovy
dependencies {
    // Redisson Spring Boot Starter，版本按项目 Spring Boot 版本选择。
    implementation "org.redisson:redisson-spring-boot-starter:3.37.0"
}
```

配置示例：

```yaml
spring:
  redis:
    redisson:
      config: |
        singleServerConfig:
          address: "redis://${REDIS_HOST:localhost}:${REDIS_PORT:6379}"
          database: 0
          connectionMinimumIdleSize: 8
          connectionPoolSize: 32
```

### 7.2 定义限流注解

```java
package com.example.ratelimit;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
public @interface RateLimit {

    Dimension[] dimensions() default {Dimension.GLOBAL};

    int count();

    long interval() default 1;

    TimeUnit timeUnit() default TimeUnit.SECONDS;

    String fallback() default "";

    enum Dimension {
        GLOBAL,
        IP,
        USER
    }

    enum TimeUnit {
        MILLISECONDS,
        SECONDS,
        MINUTES,
        HOURS
    }
}
```

`dimensions` 使用数组，是为了支持组合规则。比如登录接口可以同时按 IP 和用户名限流，AI 解析接口可以同时按全局、用户和 IP 限流。

### 7.3 编写限流异常

```java
package com.example.ratelimit;

public class RateLimitExceededException extends RuntimeException {

    public RateLimitExceededException(String message) {
        super(message);
    }
}
```

项目里通常会在全局异常处理器里把它转换成 `429 Too Many Requests`。

```java
@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(RateLimitExceededException.class)
    @ResponseStatus(HttpStatus.TOO_MANY_REQUESTS)
    public Result<Void> handleRateLimitExceeded(RateLimitExceededException ex) {
        // 统一返回限流提示，避免每个接口重复处理。
        return Result.error(ex.getMessage());
    }
}
```

### 7.4 AOP 切面

切面的职责是：

- 读取注解配置。
- 计算窗口大小。
- 根据维度生成 Redis Key。
- 执行 Lua 脚本。
- 通过则放行，失败则执行 fallback 或抛异常。

```java
package com.example.ratelimit;

import jakarta.annotation.PostConstruct;
import jakarta.servlet.http.HttpServletRequest;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.aspectj.lang.ProceedingJoinPoint;
import org.aspectj.lang.annotation.Around;
import org.aspectj.lang.annotation.Aspect;
import org.aspectj.lang.reflect.MethodSignature;
import org.redisson.api.RScript;
import org.redisson.api.RedissonClient;
import org.redisson.client.codec.StringCodec;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Component;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

@Slf4j
@Aspect
@Component
@RequiredArgsConstructor
public class RateLimitAspect {

    private final RedissonClient redissonClient;

    private String luaScript;
    private String luaSha;

    @PostConstruct
    public void init() throws Exception {
        ClassPathResource resource = new ClassPathResource("scripts/rate_limit.lua");
        this.luaScript = resource.getContentAsString(StandardCharsets.UTF_8);

        // 启动时预加载脚本，后续优先通过 SHA 执行，减少重复传输脚本文本。
        this.luaSha = redissonClient
            .getScript(StringCodec.INSTANCE)
            .scriptLoad(luaScript);
    }

    @Around("@annotation(rateLimit)")
    public Object around(ProceedingJoinPoint joinPoint, RateLimit rateLimit) throws Throwable {
        MethodSignature signature = (MethodSignature) joinPoint.getSignature();
        Method method = signature.getMethod();

        long windowMs = toMillis(rateLimit.interval(), rateLimit.timeUnit());
        List<Object> keys = buildKeys(method, rateLimit.dimensions());

        List<Object> args = List.of(
            String.valueOf(System.currentTimeMillis()),
            String.valueOf(windowMs),
            String.valueOf(rateLimit.count()),
            UUID.randomUUID().toString()
        );

        List<?> result = executeLua(keys, args);
        boolean allowed = result != null && !result.isEmpty() && "1".equals(String.valueOf(result.get(0)));

        if (allowed) {
            return joinPoint.proceed();
        }

        log.debug("请求被限流：method={}, keys={}, result={}", method.getName(), keys, result);
        return handleRejected(joinPoint, rateLimit);
    }

    private List<?> executeLua(List<Object> keys, List<Object> args) {
        RScript script = redissonClient.getScript(StringCodec.INSTANCE);

        try {
            return script.evalSha(
                RScript.Mode.READ_WRITE,
                luaSha,
                RScript.ReturnType.MULTI,
                keys,
                args.toArray()
            );
        } catch (Exception ex) {
            // Redis 重启或 SCRIPT FLUSH 后，脚本缓存可能丢失。这里兜底重新加载并执行。
            if (ex.getMessage() != null && ex.getMessage().contains("NOSCRIPT")) {
                this.luaSha = script.scriptLoad(luaScript);
                return script.evalSha(
                    RScript.Mode.READ_WRITE,
                    luaSha,
                    RScript.ReturnType.MULTI,
                    keys,
                    args.toArray()
                );
            }
            throw ex;
        }
    }

    private List<Object> buildKeys(Method method, RateLimit.Dimension[] dimensions) {
        String className = method.getDeclaringClass().getSimpleName();
        String methodName = method.getName();

        // Hash Tag 保证同一个方法的多个维度 Key 落到 Redis Cluster 的同一个 Slot。
        String prefix = "ratelimit:{" + className + ":" + methodName + "}";

        List<Object> keys = new ArrayList<>();
        for (RateLimit.Dimension dimension : dimensions) {
            switch (dimension) {
                case GLOBAL -> keys.add(prefix + ":global");
                case IP -> keys.add(prefix + ":ip:" + getClientIp());
                case USER -> keys.add(prefix + ":user:" + getCurrentUserId());
            }
        }
        return keys;
    }

    private Object handleRejected(ProceedingJoinPoint joinPoint, RateLimit rateLimit) throws Throwable {
        if (rateLimit.fallback() == null || rateLimit.fallback().isBlank()) {
            throw new RateLimitExceededException("请求过于频繁，请稍后再试");
        }

        Method fallbackMethod = findFallbackMethod(joinPoint, rateLimit.fallback());
        if (fallbackMethod == null) {
            throw new RateLimitExceededException("请求过于频繁，请稍后再试");
        }

        fallbackMethod.setAccessible(true);
        if (fallbackMethod.getParameterCount() == 0) {
            return fallbackMethod.invoke(joinPoint.getTarget());
        }
        return fallbackMethod.invoke(joinPoint.getTarget(), joinPoint.getArgs());
    }

    private Method findFallbackMethod(ProceedingJoinPoint joinPoint, String fallbackName) {
        MethodSignature signature = (MethodSignature) joinPoint.getSignature();
        Class<?> targetClass = joinPoint.getTarget().getClass();

        try {
            // 优先匹配与原方法参数一致的降级方法。
            return targetClass.getDeclaredMethod(fallbackName, signature.getParameterTypes());
        } catch (NoSuchMethodException ignored) {
            try {
                // 再匹配无参降级方法。
                return targetClass.getDeclaredMethod(fallbackName);
            } catch (NoSuchMethodException ex) {
                return null;
            }
        }
    }

    private long toMillis(long interval, RateLimit.TimeUnit unit) {
        return switch (unit) {
            case MILLISECONDS -> interval;
            case SECONDS -> interval * 1000;
            case MINUTES -> interval * 60 * 1000;
            case HOURS -> interval * 60 * 60 * 1000;
        };
    }

    private String getClientIp() {
        ServletRequestAttributes attributes =
            (ServletRequestAttributes) RequestContextHolder.getRequestAttributes();

        if (attributes == null) {
            return "unknown";
        }

        HttpServletRequest request = attributes.getRequest();
        String forwardedFor = request.getHeader("X-Forwarded-For");
        if (forwardedFor != null && !forwardedFor.isBlank()) {
            // 多层代理时取第一个 IP，生产环境还应结合可信代理列表校验。
            return forwardedFor.split(",")[0].trim();
        }

        String realIp = request.getHeader("X-Real-IP");
        if (realIp != null && !realIp.isBlank()) {
            return realIp;
        }

        return request.getRemoteAddr();
    }

    private String getCurrentUserId() {
        // 这里按自己的登录体系替换，例如 SecurityContext、Sa-Token 或网关透传 Header。
        return UserContext.getCurrentUserId()
            .map(String::valueOf)
            .orElse("anonymous");
    }
}
```

这里有几个实现细节值得注意。

第一，Lua 脚本缓存不是持久化数据。Redis 重启、主从切换或执行 `SCRIPT FLUSH` 后，`EVALSHA` 可能返回 `NOSCRIPT`。所以组件最好做一次重新加载兜底。

第二，IP 限流不能无条件信任 `X-Forwarded-For`。如果服务直接暴露在公网，客户端可以伪造这个 Header。生产环境应该只在经过可信网关或负载均衡器时读取它。

第三，用户维度要和认证体系打通。未登录用户可以使用 `anonymous`、设备 ID 或 IP 作为替代维度，但不要把所有匿名请求都挤到一个共享用户 Key 上，否则会误伤。

## 8. 简单 demo 示例

下面用一个简历解析接口演示如何使用。

```java
@RestController
@RequestMapping("/api/resumes")
@RequiredArgsConstructor
public class ResumeController {

    private final ResumeAnalyzeService resumeAnalyzeService;

    @PostMapping("/analyze")
    @RateLimit(
        dimensions = {
            RateLimit.Dimension.GLOBAL,
            RateLimit.Dimension.IP,
            RateLimit.Dimension.USER
        },
        count = 3,
        interval = 1,
        timeUnit = RateLimit.TimeUnit.MINUTES,
        fallback = "analyzeFallback"
    )
    public Result<AnalyzeResult> analyze(@RequestParam("file") MultipartFile file) {
        // 这里可能包含文件解析、OCR、AI 模型调用等高成本操作。
        AnalyzeResult result = resumeAnalyzeService.analyze(file);
        return Result.success(result);
    }

    private Result<AnalyzeResult> analyzeFallback(MultipartFile file) {
        // 触发限流后给用户明确反馈，而不是让请求在后端排队。
        return Result.error("当前解析请求较多，请 1 分钟后再试");
    }
}
```

用 `curl` 连续请求可以观察效果：

```bash
curl -F "file=@resume.pdf" http://localhost:8080/api/resumes/analyze
curl -F "file=@resume.pdf" http://localhost:8080/api/resumes/analyze
curl -F "file=@resume.pdf" http://localhost:8080/api/resumes/analyze
curl -F "file=@resume.pdf" http://localhost:8080/api/resumes/analyze
```

前三次通过，第四次进入 fallback。1 分钟窗口过去后，旧请求会被 Lua 脚本清理，接口重新允许访问。

如果想看 Redis 里的数据，可以执行：

```bash
redis-cli keys 'ratelimit:*'
redis-cli zrange 'ratelimit:{ResumeController:analyze}:global' 0 -1 withscores
```

生产环境不要在线上使用 `keys` 扫描大库，可以换成 `SCAN`。

## 9. 生产实践建议

### 9.1 限流结果应该可观测

限流不是写完就结束，必须知道它有没有误伤、有没有生效。

建议记录这些指标：

- 通过次数。
- 被限流次数。
- 被限流的接口名。
- 被限流的维度，比如 global、ip、user。
- Lua 执行耗时。
- Redis 异常次数。

```java
if (!allowed) {
    // 实际项目可以接入 Micrometer，把接口和维度作为 tag。
    rateLimitMetrics.recordRejected(method.getName());
}
```

### 9.2 Redis 异常时怎么处理要提前决定

Redis 不可用时有两种策略：

- fail open：放行请求，优先保证可用性。
- fail closed：拒绝请求，优先保护下游资源。

面向普通查询接口，通常可以 fail open。面向短信、支付、第三方扣费、AI 高成本接口，更适合 fail closed 或走更保守的本地兜底限流。

不要把这个选择藏在代码细节里，最好做成配置项。

### 9.3 Key 的基数要可控

按用户、IP、租户限流都可能产生大量 Key。需要注意：

- 给所有限流 Key 设置 TTL。
- 不要把完整 URL、长参数、搜索词直接拼进 Key。
- 对高基数字段做白名单，或者只对核心接口启用。

### 9.4 不要把 Lua 写成大程序

Redis 执行 Lua 时具备原子性，但代价是脚本运行期间会阻塞其他命令。限流脚本应该只做短小的计数逻辑，不要在里面做复杂循环、远距离扫描或大批量数据处理。

### 9.5 参数要能动态调整

实际业务里，限流阈值往往需要调整：

- 大促期间临时放宽。
- 第三方接口故障时临时收紧。
- 不同租户使用不同额度。

注解适合表达默认值。如果规则经常变化，可以让注解只提供 ruleKey，再从配置中心读取实际阈值。

```java
@RateLimitRule("resume.analyze")
public Result<AnalyzeResult> analyze(MultipartFile file) {
    return Result.success(resumeAnalyzeService.analyze(file));
}
```

## 10. 什么时候不要用这套方案

Redis + Lua 很灵活，但不是所有项目都需要。

如果你的应用只有一个实例，用 Bucket4j 或 Resilience4j 就够了。

如果限流规则完全按网关路由配置，业务代码不需要感知用户、租户、参数，那么网关限流更合适。

如果项目已经全面接入 Sentinel，并且规则管理也在 Sentinel 控制台里完成，就没必要再单独维护一套业务限流组件。

如果只是单个全局限流器，Redisson `RRateLimiter` 会比自定义 Lua 更省心。

这套方案更适合这样的项目：服务已经多实例部署，Redis 是基础设施之一，业务方希望用注解快速给高成本接口增加全局、IP、用户等组合限流。

## 总结

限流首先是选型问题，其次才是代码问题。

本地限流性能最好，但不能解决多实例全局配额。网关限流适合入口保护，但不擅长业务身份维度。Redisson `RRateLimiter` 开箱即用，但复杂组合规则需要额外封装。Redis + Lua 的维护成本更高，却能把多维度检查和写入做成一次原子操作，适合封装为业务组件。

本文实现的核心思路可以概括为：

- 用注解声明限流规则。
- 用 AOP 拦截业务方法。
- 用 Redis Sorted Set 保存滑动窗口内的请求时间线。
- 用 Lua 保证清理、检查、写入的原子性。
- 用 Hash Tag 兼容 Redis Cluster 多 Key 脚本。
- 用 fallback 或统一异常处理提供友好的降级结果。

最后还是那句话：不要为了“看起来高级”而上分布式限流。先判断系统部署形态和接口风险，再选择刚好够用、团队能长期维护的方案。

## 参考资料

- [Redis Lua scripting](https://redis.io/docs/latest/develop/programmability/eval-intro/)
- [Redis EVAL command](https://redis.io/docs/latest/commands/eval/)
- [Redis Sorted Sets](https://redis.io/docs/latest/develop/data-types/sorted-sets/)
- [Redisson RateLimiter 文档](https://redisson.pro/docs/data-and-services/objects/#rate-limiter)
