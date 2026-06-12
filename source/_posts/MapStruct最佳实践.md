---
title: MapStruct 最佳实践：从能用到好用
tags:
  - MapStruct
  - Java
  - Spring Boot
categories:
  - java
keywords:
  - MapStruct最佳实践
  - Java对象映射
  - DTO
  - MappingTarget
  - MapperConfig
description: 以网上书店订单为例，介绍 MapStruct 在生产项目中的统一配置、职责拆分、严格映射、复用、局部更新、空值处理、测试和常见反模式。
cover: ../img/java.jpg
copyright: true
abbrlink: 211da4d7
date: 2026-06-12 14:00:00
updated:
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

> 本文不再重复 MapStruct 的依赖配置、基础字段映射、集合转换和常用注解。第一次接触 MapStruct 的读者，可以先阅读上一篇：[《MapStruct 使用指南：用示例讲清 Java 对象映射》](/posts/51ee8b2b.html)。

MapStruct 入门并不难，真正容易出现问题的是项目规模扩大以后：

- 每个 Mapper 的配置不一致
- DTO 新增字段后没有人发现漏映射
- 更新接口把数据库中的原值覆盖成 `null`
- Mapper 越写越大，最后承担了查询和业务计算
- 相同的金额、状态、脱敏逻辑散落在多个接口中
- Lombok 与 MapStruct 的注解处理器互相影响

本文以一个网上书店的订单模块为例，讨论 MapStruct 在生产项目中如何组织、约束和测试。示例使用 MapStruct `1.6.3`，重点不是记忆更多注解，而是建立一套长期可维护的映射方式。

## 1. 示例场景

书店系统中有三个主要实体：

```java
public class BookEntity {

    private Long id;
    private String isbn;
    private String title;
    private Long priceInCents;

    // getter、setter 省略
}
```

```java
public class OrderItemEntity {

    private Long id;
    private BookEntity book;
    private Integer quantity;
    private Long subtotalInCents;

    // getter、setter 省略
}
```

```java
public class OrderEntity {

    private Long id;
    private String orderNumber;
    private String buyerName;
    private String buyerMobile;
    private String receiverAddress;
    private OrderStatus status;
    private Long totalAmountInCents;
    private List<OrderItemEntity> items;
    private LocalDateTime createdAt;
    private LocalDateTime paidAt;

    // getter、setter 省略
}
```

对应的订单详情 DTO：

```java
public class OrderDetailDTO {

    private String orderNo;
    private String buyerName;
    private String buyerMobile;
    private String statusText;
    private String totalAmount;
    private List<OrderItemDTO> items;
    private String createdTime;
    private String couponName;
    private String promotionText;

    // getter、setter 省略
}
```

```java
public class OrderItemDTO {

    private String isbn;
    private String bookTitle;
    private Integer quantity;
    private String subtotal;

    // getter、setter 省略
}
```

后面的实践都围绕这组对象展开。

## 2. 最佳实践一：使用统一的 MapperConfig

项目中如果有十几个 Mapper，不应该在每个接口上重复配置：

```java
@Mapper(
    componentModel = MappingConstants.ComponentModel.SPRING,
    injectionStrategy = InjectionStrategy.CONSTRUCTOR,
    unmappedTargetPolicy = ReportingPolicy.ERROR
)
```

更好的方式是建立一个全局配置：

```java
import org.mapstruct.InjectionStrategy;
import org.mapstruct.MapperConfig;
import org.mapstruct.MappingConstants;
import org.mapstruct.NullValueMappingStrategy;
import org.mapstruct.ReportingPolicy;

@MapperConfig(
    componentModel = MappingConstants.ComponentModel.SPRING,
    injectionStrategy = InjectionStrategy.CONSTRUCTOR,
    unmappedTargetPolicy = ReportingPolicy.ERROR,
    nullValueIterableMappingStrategy = NullValueMappingStrategy.RETURN_DEFAULT,
    nullValueMapMappingStrategy = NullValueMappingStrategy.RETURN_DEFAULT
)
public interface CentralMapperConfig {
}
```

业务 Mapper 只需要引用配置：

```java
@Mapper(
    config = CentralMapperConfig.class,
    uses = OrderValueConverter.class
)
public interface BookMapper {

    BookDTO toDTO(BookEntity entity);
}
```

这份配置表达了四个团队约定。

### 2.1 统一交给 Spring 管理

`componentModel = SPRING` 会让生成的实现类成为 Spring Bean。Service 通过构造器注入 Mapper，不需要同时出现 `Mappers.getMapper()`、字段注入和构造器注入等多种写法。

### 2.2 Mapper 依赖使用构造器注入

当一个 Mapper 通过 `uses` 依赖另一个 Mapper 时，`InjectionStrategy.CONSTRUCTOR` 会让生成类通过构造器接收依赖。

构造器注入的依赖关系更明确，也更容易测试。需要注意，如果两个 Mapper 互相引用，构造器注入会暴露循环依赖。此时通常应该先重新划分职责，而不是急着把注入方式改回字段注入。

### 2.3 未映射目标字段直接报错

`ReportingPolicy.ERROR` 会在目标对象存在未映射属性时让编译失败。

例如，前端给 `OrderDetailDTO` 新增了 `couponAmount`，但 Mapper 没有处理，构建阶段就会提醒开发者。相比 `IGNORE`，这种方式更适合长期维护的生产项目。

严格检查并不意味着所有字段都必须赋值。不需要映射的字段应该显式写出：

```java
@Mapping(target = "internalRemark", ignore = true)
```

“明确忽略”和“悄悄遗漏”是两回事。

### 2.4 集合输入为 null 时返回空集合

接口返回集合时，空集合通常比 `null` 更容易使用。统一设置 `RETURN_DEFAULT` 后：

```java
List<OrderItemDTO> toDTOList(List<OrderItemEntity> entities);
```

当 `entities` 为 `null` 时会返回空列表。

这是一项接口约定，不是绝对规则。如果项目明确使用 `null` 表示“未查询”，就不应该强行改为空集合。关键是全项目保持一致。

## 3. 最佳实践二：按业务边界拆分 Mapper

不要创建一个什么都能转换的 `CommonMapper`：

```java
// 不推荐
public interface CommonMapper {

    UserDTO toUserDTO(UserEntity entity);

    BookDTO toBookDTO(BookEntity entity);

    OrderDTO toOrderDTO(OrderEntity entity);

    CouponDTO toCouponDTO(CouponEntity entity);
}
```

这种接口会持续膨胀，任何模块都可能依赖它，最后很难判断修改影响范围。

更合适的拆分方式是：

- `BookMapper`：负责图书对象
- `OrderItemMapper`：负责订单项，并复用 `BookMapper` 或公共值转换器
- `OrderMapper`：负责订单聚合和订单接口模型

```java
@Mapper(config = CentralMapperConfig.class)
public interface BookMapper {

    @Mapping(target = "bookId", source = "id")
    @Mapping(target = "price", source = "priceInCents",
        qualifiedByName = "centsToYuan")
    BookDTO toDTO(BookEntity entity);
}
```

```java
@Mapper(
    config = CentralMapperConfig.class,
    uses = OrderValueConverter.class
)
public interface OrderItemMapper {

    @Mapping(target = "isbn", source = "book.isbn")
    @Mapping(target = "bookTitle", source = "book.title")
    @Mapping(target = "subtotal", source = "subtotalInCents",
        qualifiedByName = "centsToYuan")
    OrderItemDTO toDTO(OrderItemEntity entity);

    List<OrderItemDTO> toDTOList(List<OrderItemEntity> entities);
}
```

```java
@Mapper(
    config = CentralMapperConfig.class,
    uses = {
        OrderItemMapper.class,
        OrderValueConverter.class
    }
)
public interface OrderMapper {

    @Mapping(target = "orderNo", source = "orderNumber")
    @Mapping(target = "buyerMobile", source = "buyerMobile",
        qualifiedByName = "maskMobile")
    @Mapping(target = "statusText", source = "status",
        qualifiedByName = "orderStatusText")
    @Mapping(target = "totalAmount", source = "totalAmountInCents",
        qualifiedByName = "centsToYuan")
    @Mapping(target = "createdTime", source = "createdAt",
        dateFormat = "yyyy-MM-dd HH:mm:ss")
    @Mapping(target = "couponName", ignore = true)
    @Mapping(target = "promotionText", ignore = true)
    OrderDetailDTO toDetailDTO(OrderEntity entity);
}
```

MapStruct 会根据 `items` 的源类型和目标类型，自动找到 `OrderItemMapper.toDTO()` 完成集合元素转换。

### 如何判断是否需要拆分

可以从三个问题判断：

1. 这个转换是否属于同一个业务模块？
2. 修改这个 Mapper 时，调用方是否具有相同的变化原因？
3. 被复用的是完整对象转换，还是一个与业务无关的值转换？

完整对象转换放在对应业务 Mapper 中；金额格式化、手机号脱敏等可复用的纯函数，可以放到独立 Converter。

## 4. 最佳实践三：公共转换器保持纯粹

多个 Mapper 都可能用到分转元、手机号脱敏和状态展示。可以抽取一个值转换器：

```java
import java.math.BigDecimal;
import java.math.RoundingMode;
import org.mapstruct.Named;
import org.springframework.stereotype.Component;

@Component
public class OrderValueConverter {

    @Named("centsToYuan")
    public String centsToYuan(Long cents) {
        if (cents == null) {
            return null;
        }

        return BigDecimal.valueOf(cents)
            .divide(BigDecimal.valueOf(100), 2, RoundingMode.UNNECESSARY)
            .toPlainString();
    }

    @Named("maskMobile")
    public String maskMobile(String mobile) {
        if (mobile == null || mobile.length() != 11) {
            return mobile;
        }

        return mobile.substring(0, 3)
            + "****"
            + mobile.substring(7);
    }

    @Named("orderStatusText")
    public String orderStatusText(OrderStatus status) {
        if (status == null) {
            return "未知";
        }

        return switch (status) {
            case CREATED -> "待付款";
            case PAID -> "待发货";
            case SHIPPED -> "运输中";
            case COMPLETED -> "已完成";
            case CANCELED -> "已取消";
        };
    }
}
```

公共转换器应满足以下条件：

- 相同输入始终得到相同输出
- 不访问数据库、缓存或远程服务
- 不修改传入对象
- 能独立编写单元测试
- 方法名称准确表达转换含义

不要把所有方法都命名成 `convert()`。当存在多个相同输入、输出类型的方法时，`@Named` 与 `qualifiedByName` 可以明确告诉 MapStruct 应该选择哪一个。

## 5. 最佳实践四：写入实体时使用白名单映射

读取 Entity 并生成 DTO 时，自动映射同名字段通常很方便；但将前端请求写入 Entity 时，需要更谨慎。

假设创建订单的请求为：

```java
public class CreateOrderCommand {

    private String buyerName;
    private String buyerMobile;
    private String receiverAddress;

    // getter、setter 省略
}
```

订单实体还包含 `id`、`orderNumber`、`status`、`totalAmountInCents`、`paidAt` 等由系统维护的字段。这些字段不应该由前端请求决定。

可以使用 `ignoreByDefault = true` 建立映射白名单：

```java
@Mapper(config = CentralMapperConfig.class)
public interface OrderCommandMapper {

    @BeanMapping(ignoreByDefault = true)
    @Mapping(target = "buyerName", source = "buyerName")
    @Mapping(target = "buyerMobile", source = "buyerMobile")
    @Mapping(target = "receiverAddress", source = "receiverAddress")
    OrderEntity toEntity(CreateOrderCommand command);
}
```

只有显式列出的字段会进入实体。下面这些值继续由 Service 决定：

```java
@Service
@RequiredArgsConstructor
public class OrderCreateService {

    private final OrderCommandMapper orderCommandMapper;
    private final OrderRepository orderRepository;

    public Long create(CreateOrderCommand command) {
        OrderEntity order = orderCommandMapper.toEntity(command);

        order.setOrderNumber(generateOrderNumber());
        order.setStatus(OrderStatus.CREATED);
        order.setTotalAmountInCents(0L);
        order.setCreatedAt(LocalDateTime.now());

        return orderRepository.save(order).getId();
    }
}
```

这可以防止 DTO 将来意外增加 `status`、`paidAt` 等同名字段后，被自动写入实体。

## 6. 最佳实践五：局部更新必须定义 null 语义

编辑收货信息时，通常先查询已有订单，再把请求中的部分字段更新进去：

```java
public class UpdateReceiverCommand {

    private String buyerName;
    private String buyerMobile;
    private String receiverAddress;

    // getter、setter 省略
}
```

使用 `@MappingTarget` 更新已有实例：

```java
@Mapper(config = CentralMapperConfig.class)
public interface OrderCommandMapper {

    @BeanMapping(
        ignoreByDefault = true,
        nullValuePropertyMappingStrategy =
            NullValuePropertyMappingStrategy.IGNORE
    )
    @Mapping(target = "buyerName", source = "buyerName")
    @Mapping(target = "buyerMobile", source = "buyerMobile")
    @Mapping(target = "receiverAddress", source = "receiverAddress")
    void updateReceiver(
        UpdateReceiverCommand command,
        @MappingTarget OrderEntity order
    );
}
```

调用方式：

```java
@Transactional
public void updateReceiver(
    Long orderId,
    UpdateReceiverCommand command
) {
    OrderEntity order = orderRepository.findById(orderId)
        .orElseThrow(() -> new OrderNotFoundException(orderId));

    checkReceiverCanBeChanged(order);
    orderCommandMapper.updateReceiver(command, order);
}
```

这里组合了两个重要约束：

- `ignoreByDefault = true`：只允许修改收货相关字段
- `NullValuePropertyMappingStrategy.IGNORE`：请求中的 `null` 不覆盖原值

### null 到底表示什么

忽略 `null` 适合 PATCH 风格的局部更新，但它也意味着调用方无法通过 `null` 清空字段。

一个字段通常存在三种状态：

1. 请求中没有提供，不修改
2. 请求中提供了新值，更新
3. 请求明确要求清空

普通 Java 字段很难区分第一种和第三种。业务确实需要“清空”操作时，可以使用：

- 单独的清空接口
- 显式的 `clearXxx` 布尔字段
- 能表达“缺失”和“显式 null”的请求包装类型

不要仅依靠 `IGNORE` 猜测业务语义。

## 7. 最佳实践六：Mapper 不负责查询和业务决策

下面的做法不推荐：

```java
@Mapper(componentModel = "spring")
public abstract class OrderMapper {

    @Autowired
    protected CouponRepository couponRepository;

    @AfterMapping
    protected void fillCoupon(
        OrderEntity order,
        @MappingTarget OrderDetailDTO dto
    ) {
        CouponEntity coupon =
            couponRepository.findByOrderId(order.getId());
        dto.setCouponName(coupon.getName());
    }
}
```

问题在于：

- 一次列表映射可能触发 N 次查询
- Mapper 的性能变得不可预测
- 映射测试必须连接数据库或模拟 Repository
- 数据加载和对象转换的职责混在一起

正确方式是在 Service 中准备数据，再使用多源映射：

```java
public class OrderPromotionInfo {

    private String couponName;
    private String promotionText;

    // getter、setter 省略
}
```

```java
@Mapper(
    config = CentralMapperConfig.class,
    uses = {
        OrderItemMapper.class,
        OrderValueConverter.class
    }
)
public interface OrderMapper {

    @Mapping(target = "orderNo", source = "order.orderNumber")
    @Mapping(target = "couponName", source = "promotion.couponName")
    @Mapping(target = "promotionText",
        source = "promotion.promotionText")
    @Mapping(target = "buyerMobile", source = "order.buyerMobile",
        qualifiedByName = "maskMobile")
    @Mapping(target = "statusText", source = "order.status",
        qualifiedByName = "orderStatusText")
    @Mapping(target = "totalAmount",
        source = "order.totalAmountInCents",
        qualifiedByName = "centsToYuan")
    @Mapping(target = "items", source = "order.items")
    @Mapping(target = "createdTime", source = "order.createdAt",
        dateFormat = "yyyy-MM-dd HH:mm:ss")
    OrderDetailDTO toDetailDTO(
        OrderEntity order,
        OrderPromotionInfo promotion
    );
}
```

```java
public OrderDetailDTO getOrderDetail(Long orderId) {
    OrderEntity order = orderRepository.findDetailById(orderId)
        .orElseThrow(() -> new OrderNotFoundException(orderId));

    OrderPromotionInfo promotion =
        promotionService.getOrderPromotion(orderId);

    return orderMapper.toDetailDTO(order, promotion);
}
```

Service 负责“需要哪些数据”和“业务是否允许执行”，Mapper 只负责“这些数据如何进入目标对象”。

## 8. 最佳实践七：优先使用明确方法，谨慎使用表达式和钩子

MapStruct 支持 `expression`、`@BeforeMapping` 和 `@AfterMapping`。这些功能很灵活，但也更容易隐藏逻辑。

### 8.1 简单字段转换优先使用方法

不推荐在注解中堆积 Java 代码：

```java
@Mapping(
    target = "totalAmount",
    expression = "java(new BigDecimal(order.getTotalAmountInCents()).divide(new BigDecimal(100)).toString())"
)
OrderDetailDTO toDetailDTO(OrderEntity order);
```

更推荐使用可命名、可复用、可测试的方法：

```java
@Mapping(
    target = "totalAmount",
    source = "totalAmountInCents",
    qualifiedByName = "centsToYuan"
)
OrderDetailDTO toDetailDTO(OrderEntity order);
```

### 8.2 生命周期钩子只处理映射收尾

`@AfterMapping` 适合少量必须依赖完整目标对象的收尾工作，不适合：

- 查询数据库
- 调用远程接口
- 修改订单状态
- 计算优惠和运费
- 执行权限校验

如果一个钩子已经包含多个业务分支，应将逻辑移到 Service，并把结果作为映射参数传入。

## 9. 最佳实践八：不要盲目复用反向映射

Entity 转 DTO 和 DTO 转 Entity 看起来相反，实际职责可能完全不同。

输出订单详情时，可以返回：

- 脱敏手机号
- 状态中文名称
- 格式化金额
- 格式化时间

这些数据不能简单反向写回 Entity。因此下面的写法需要谨慎：

```java
@InheritInverseConfiguration
OrderEntity toEntity(OrderDetailDTO dto);
```

写入实体时，建议针对具体命令定义独立方法：

```java
OrderEntity toEntity(CreateOrderCommand command);

void updateReceiver(
    UpdateReceiverCommand command,
    @MappingTarget OrderEntity entity
);
```

只有当两个对象确实是结构对称、语义对称的内部模型时，才适合使用 `@InheritInverseConfiguration`。

## 10. 最佳实践九：正确配置 Lombok 与注解处理器

MapStruct 和 Lombok 都在编译阶段工作。如果处理器配置不完整，可能出现：

- MapStruct 提示属性不存在
- 生成类找不到 getter 或 setter
- IDE 编译成功，但 Maven 构建失败
- Maven 构建成功，但 IDE 一直标红

使用 Maven 时，可以把处理器统一放到 `annotationProcessorPaths`：

```xml
<properties>
    <java.version>17</java.version>
    <mapstruct.version>1.6.3</mapstruct.version>
    <lombok.version>1.18.38</lombok.version>
    <lombok-mapstruct-binding.version>0.2.0</lombok-mapstruct-binding.version>
</properties>

<plugin>
    <groupId>org.apache.maven.plugins</groupId>
    <artifactId>maven-compiler-plugin</artifactId>
    <version>3.13.0</version>
    <configuration>
        <source>${java.version}</source>
        <target>${java.version}</target>
        <annotationProcessorPaths>
            <path>
                <groupId>org.mapstruct</groupId>
                <artifactId>mapstruct-processor</artifactId>
                <version>${mapstruct.version}</version>
            </path>
            <path>
                <groupId>org.projectlombok</groupId>
                <artifactId>lombok</artifactId>
                <version>${lombok.version}</version>
            </path>
            <path>
                <groupId>org.projectlombok</groupId>
                <artifactId>lombok-mapstruct-binding</artifactId>
                <version>
                    ${lombok-mapstruct-binding.version}
                </version>
            </path>
        </annotationProcessorPaths>
    </configuration>
</plugin>
```

上面的 Lombok 版本仅用于展示配置结构，实际项目应使用团队统一验证过的版本。

配置完成后，应使用真实构建命令验证：

```bash
mvn clean compile
```

不要仅以 IDE 没有报错作为判断依据。

## 11. 最佳实践十：为 Mapper 编写行为测试

MapStruct 会生成代码，但映射规则仍然是项目代码的一部分。以下场景至少应该覆盖：

- 字段重命名是否正确
- 嵌套对象为 `null` 时是否安全
- 金额、时间和枚举是否符合接口约定
- 手机号是否完成脱敏
- 集合为 `null` 时是否返回空集合
- 局部更新时 `null` 是否保留旧值
- 系统维护字段是否不会被请求覆盖

Spring 项目可以直接注入 Mapper 测试：

```java
@SpringBootTest
class OrderMapperTest {

    @Autowired
    private OrderMapper orderMapper;

    @Test
    void shouldConvertOrderDetail() {
        OrderEntity order = new OrderEntity();
        order.setOrderNumber("BOOK-20260612-001");
        order.setBuyerName("小林");
        order.setBuyerMobile("13812345678");
        order.setStatus(OrderStatus.PAID);
        order.setTotalAmountInCents(5990L);
        order.setCreatedAt(
            LocalDateTime.of(2026, 6, 12, 10, 30)
        );

        OrderDetailDTO dto = orderMapper.toDetailDTO(order);

        assertEquals("BOOK-20260612-001", dto.getOrderNo());
        assertEquals("138****5678", dto.getBuyerMobile());
        assertEquals("待发货", dto.getStatusText());
        assertEquals("59.90", dto.getTotalAmount());
        assertEquals(
            "2026-06-12 10:30:00",
            dto.getCreatedTime()
        );
        assertNotNull(dto.getItems());
        assertTrue(dto.getItems().isEmpty());
    }
}
```

局部更新需要单独测试：

```java
@Test
void shouldKeepOldValueWhenPatchFieldIsNull() {
    OrderEntity order = new OrderEntity();
    order.setBuyerName("小林");
    order.setBuyerMobile("13812345678");
    order.setStatus(OrderStatus.PAID);

    UpdateReceiverCommand command =
        new UpdateReceiverCommand();
    command.setBuyerName("小林同学");
    command.setBuyerMobile(null);

    orderCommandMapper.updateReceiver(command, order);

    assertEquals("小林同学", order.getBuyerName());
    assertEquals("13812345678", order.getBuyerMobile());
    assertEquals(OrderStatus.PAID, order.getStatus());
}
```

测试关注的是对外行为，不必验证生成类的每一行代码。

## 12. 最佳实践十一：把生成代码纳入排查流程

遇到以下问题时，先查看生成的 `MapperImpl`：

- MapStruct 选择了错误的转换方法
- 嵌套对象的判空行为不符合预期
- 集合转换结果异常
- `uses` 中的 Mapper 没有被调用
- Builder 对象没有按预期赋值
- `@BeforeMapping`、`@AfterMapping` 的调用顺序不清楚

Maven 项目的默认目录通常是：

```text
target/generated-sources/annotations
```

Gradle 项目的默认目录通常是：

```text
build/generated/sources/annotationProcessor
```

生成代码是构建产物，一般不需要提交到 Git。持续集成应执行完整编译或测试，确保注解处理器确实运行：

```bash
mvn clean test
```

## 13. 常见反模式

### 13.1 全局使用 ReportingPolicy.IGNORE

它会让新增字段静默遗漏。生产项目更推荐全局 `ERROR`，对确实不需要的字段单独 `ignore = true`。

### 13.2 Mapper 中注入 Repository

这会产生隐藏查询、N+1 问题和难以测试的转换过程。数据应由 Service 准备。

### 13.3 把所有逻辑都写进 expression

长表达式没有方法名，难以复用和测试，编译错误也不够直观。复杂转换应提取为普通方法。

### 13.4 使用一个巨型 CommonMapper

公共值转换器可以共享，但不同业务模块的对象 Mapper 应保持独立。

### 13.5 更新实体时直接自动映射全部同名字段

请求对象一旦新增 `status`、`id` 等字段，就可能意外修改系统维护数据。写操作应采用白名单映射。

### 13.6 把 null 策略当成技术细节

`null` 是忽略、清空还是默认值，属于接口语义。应先确定业务含义，再选择 MapStruct 策略。

### 13.7 不测试 Mapper

编译成功只能说明类型和映射规则合法，不能保证金额格式、脱敏规则和接口语义符合预期。

## 14. 项目落地清单

在项目中引入或整理 MapStruct 时，可以按下面的清单检查：

- [ ] 使用 `@MapperConfig` 统一组件模型、注入方式和严格策略
- [ ] Spring 项目统一使用构造器注入
- [ ] 默认启用 `unmappedTargetPolicy = ERROR`
- [ ] 对不需要的目标字段显式设置 `ignore = true`
- [ ] 按业务模块拆分 Mapper，避免巨型公共接口
- [ ] 公共 Converter 保持无状态、无外部查询
- [ ] 请求写入 Entity 时优先采用白名单映射
- [ ] 更新已有对象时明确 `null` 的业务语义
- [ ] Mapper 不访问数据库、缓存和远程服务
- [ ] 复杂转换使用命名方法，不堆积 Java 表达式
- [ ] 谨慎使用反向映射和生命周期钩子
- [ ] Lombok 项目配置 `lombok-mapstruct-binding`
- [ ] 为关键映射、空值和更新行为编写测试
- [ ] CI 执行完整编译，确保生成代码可用

## 15. 总结

MapStruct 的最佳实践并不是使用更多注解，而是让对象映射具备清晰边界：

1. **统一约束**：使用 `@MapperConfig` 统一 Spring 组件模型、构造器注入、严格字段检查和集合空值策略。
2. **职责单一**：Mapper 只负责对象结构转换，不查询数据、不执行权限判断和业务状态流转。
3. **写入谨慎**：请求写入实体时使用白名单，局部更新时明确 `null` 的真实语义。
4. **复用适度**：业务 Mapper 按模块拆分，纯值转换通过 `uses` 和限定符复用。
5. **持续验证**：测试关键映射行为，遇到问题直接查看生成代码，并通过 CI 执行完整编译。

当这些约定稳定下来以后，MapStruct 才不只是一个减少 setter 的工具，而会成为不同应用层之间清晰、可检查的转换边界。

## 参考资料

- [上一篇：MapStruct 使用指南](/posts/51ee8b2b.html)
- [MapStruct 1.6.3 官方参考文档](https://mapstruct.org/documentation/stable/reference/html/)
